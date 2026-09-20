export interface AurigaIssue {
  id: string;
  identifier?: string;
  title?: string;
  description?: string;
  status?: string | null;
  project_id?: string;
  parent_issue_id?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CheckNextSliceTicketInput {
  title: string;
  description: string;
  projectId: string;
  status: 'todo';
}

export interface CompletionHookClient {
  getIssue(issueId: string): AurigaIssue | null;
  listChildren(issueId: string): AurigaIssue[];
  listProjectIssues?(projectId: string): AurigaIssue[];
  createIssue(input: CheckNextSliceTicketInput): AurigaIssue;
  setIssueMetadata?(issueId: string, key: string, value: string): void;
}

export interface CompletionHookResult {
  action: 'created' | 'skipped';
  reason: string;
  sourceEpicId?: string;
  ticketIdentifier?: string;
  ticketId?: string;
}

const CLOSED_STATUSES = new Set(['done', 'cancelled', 'canceled']);
const TERMINAL_ASSESSMENT_VALUES = new Set([
  'complete',
  'completed',
  'no_op',
  'no-op',
  'no work',
  'no_work',
  'project_complete',
  'terminal',
]);

function norm(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function issueText(issue: AurigaIssue): string {
  return `${issue.title || ''}\n${issue.description || ''}`.toLowerCase();
}

function hasMetadataValue(issue: AurigaIssue, keys: string[], values: Set<string>): boolean {
  const metadata = issue.metadata || {};
  return keys.some((key) => values.has(norm(metadata[key])));
}

export function isClosedStatus(status: string | null | undefined): boolean {
  return CLOSED_STATUSES.has(norm(status));
}

export function isCheckNextSliceIssue(issue: AurigaIssue): boolean {
  return /\bcheck-next-slice\b/.test(issueText(issue));
}

export function hasTerminalAssessment(issue: AurigaIssue): boolean {
  return hasMetadataValue(issue, [
    'auriga_completion_state',
    'auriga_slice_status',
    'slice_status',
    'planning_status',
    'decision',
  ], TERMINAL_ASSESSMENT_VALUES);
}

export function isPlanningOrTerminalIssue(issue: AurigaIssue): boolean {
  const text = issueText(issue);
  return isCheckNextSliceIssue(issue) ||
    hasTerminalAssessment(issue) ||
    /\b(planning|assessor|assessment)\b/.test(text) && /\b(no[-_ ]?op|complete|completed)\b/.test(text);
}

export function isExistingCheckNextSliceForEpic(issue: AurigaIssue, epic: AurigaIssue): boolean {
  if (!isCheckNextSliceIssue(issue)) return false;
  const sourceEpicId = norm(issue.metadata?.source_epic_id);
  if (sourceEpicId && sourceEpicId === norm(epic.id)) return true;
  return issueText(issue).includes(`source_epic_id: ${norm(epic.id)}`);
}

export function shouldCreateCheckNextSliceTicket(
  epic: AurigaIssue,
  children: AurigaIssue[],
  existingIssues: AurigaIssue[] = [],
): { create: boolean; reason: string } {
  if (!epic.id || !epic.project_id) {
    return { create: false, reason: 'epic-missing-id-or-project' };
  }

  if (isPlanningOrTerminalIssue(epic)) {
    return { create: false, reason: 'planning-or-terminal-epic' };
  }

  const deliveryChildren = children.filter((child) => !isCheckNextSliceIssue(child));
  if (deliveryChildren.length === 0) {
    return { create: false, reason: 'no-delivery-children' };
  }

  if (!deliveryChildren.every((child) => isClosedStatus(child.status))) {
    return { create: false, reason: 'delivery-children-still-open' };
  }

  const alreadyFiled = [...children, ...existingIssues].some((issue) =>
    isExistingCheckNextSliceForEpic(issue, epic)
  );
  if (alreadyFiled) {
    return { create: false, reason: 'check-next-slice-already-filed' };
  }

  return { create: true, reason: 'delivery-epic-complete' };
}

export function buildCheckNextSliceTicket(
  epic: AurigaIssue,
  projectName = epic.project_id || 'project',
): CheckNextSliceTicketInput {
  if (!epic.project_id) {
    throw new Error('cannot build check-next-slice ticket without epic.project_id');
  }

  const source = epic.identifier ? `${epic.identifier} (${epic.id})` : epic.id;
  const title = `[check-next-slice] ${projectName} after ${epic.identifier || 'completed delivery epic'}`;
  const description = [
    'id: check-next-slice',
    `source_epic_id: ${epic.id}`,
    epic.identifier ? `source_epic_identifier: ${epic.identifier}` : null,
    `target_project_id: ${epic.project_id}`,
    `target_project_name: ${projectName}`,
    '',
    'description: |',
    `  Re-invoke the Auriga sweep logic for ${projectName} after delivery epic ${source} completed.`,
    '  Run the project assessment for this project only, then queue the next-slice generation job through the Auriga queue manager.',
    '  If the assessment finds no remaining gaps, mark this ticket done with auriga_completion_state=no_op and do not create another delivery epic.',
    '',
    'acceptance_criteria:',
    `  - "Given ${projectName}, when this ticket runs, then Auriga assesses only project_id ${epic.project_id}."`,
    '  - "Given gaps are found, then it queues the next delivery slice for that project."',
    '  - "Given no gaps are found, then it records a no-op completion state and does not create a new delivery epic."',
  ].filter((line): line is string => line !== null).join('\n');

  return {
    title,
    description,
    projectId: epic.project_id,
    status: 'todo',
  };
}

export function runCompletionHook(
  completedStory: AurigaIssue,
  client: CompletionHookClient,
  projectNames: Record<string, string> = {},
): CompletionHookResult {
  const parentId = completedStory.parent_issue_id;
  if (!parentId) {
    return { action: 'skipped', reason: 'completed-issue-has-no-parent' };
  }

  const epic = client.getIssue(parentId);
  if (!epic) {
    return { action: 'skipped', reason: 'parent-epic-not-found', sourceEpicId: parentId };
  }

  const children = client.listChildren(epic.id);
  const projectIssues = epic.project_id && client.listProjectIssues ? client.listProjectIssues(epic.project_id) : [];
  const decision = shouldCreateCheckNextSliceTicket(epic, children, projectIssues);
  if (!decision.create) {
    return { action: 'skipped', reason: decision.reason, sourceEpicId: epic.id };
  }

  const ticket = client.createIssue(buildCheckNextSliceTicket(
    epic,
    projectNames[epic.project_id || ''] || epic.project_id || 'project',
  ));

  if (client.setIssueMetadata) {
    client.setIssueMetadata(ticket.id, 'source_epic_id', epic.id);
    if (epic.identifier) client.setIssueMetadata(ticket.id, 'source_epic_identifier', epic.identifier);
    if (epic.project_id) client.setIssueMetadata(ticket.id, 'target_project_id', epic.project_id);
  }

  return {
    action: 'created',
    reason: decision.reason,
    sourceEpicId: epic.id,
    ticketIdentifier: ticket.identifier,
    ticketId: ticket.id,
  };
}
