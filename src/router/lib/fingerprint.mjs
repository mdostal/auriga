import crypto from 'node:crypto';

export const ASSIGNMENT_FINGERPRINT_KEY = 'router_assignment_fingerprint';
export const ASSIGNMENT_AGENT_KEY = 'router_assignment_agent';

const INTERNAL_METADATA_KEYS = new Set([
  ASSIGNMENT_FINGERPRINT_KEY,
  ASSIGNMENT_AGENT_KEY,
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !INTERNAL_METADATA_KEYS.has(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => [key, stable(val)]),
  );
}

function normalizedLabels(labels = []) {
  return labels
    .map((label) => (typeof label === 'string' ? label : label?.name || label?.id || ''))
    .filter(Boolean)
    .sort();
}

function windowBucket(now, windowMs) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) return 'unwindowed';
  return Math.floor(now / windowMs);
}

export function assignmentFingerprint(issue, agentName, cfg = {}, opts = {}) {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? cfg.CAPS?.assignmentFingerprintWindowMs ?? Infinity;
  const agentId = cfg.AGENTS?.[agentName]?.id || agentName;
  const payload = {
    agent: { name: agentName, id: agentId },
    window: windowBucket(now, windowMs),
    issue: {
      id: issue.id || null,
      identifier: issue.identifier || null,
      project_id: issue.project_id || null,
      parent_issue_id: issue.parent_issue_id || null,
      tree_path: issue.tree_path ?? issue.treePath ?? issue.metadata?.tree_path ?? issue.metadata?.treePath ?? null,
      title: issue.title || '',
      description: issue.description || '',
      labels: normalizedLabels(issue.labels),
      metadata: stable(issue.metadata || {}),
    },
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function recordedAssignmentFingerprint(issue = {}) {
  return issue.metadata?.[ASSIGNMENT_FINGERPRINT_KEY] || null;
}

export function recordedAssignmentAgent(issue = {}) {
  return issue.metadata?.[ASSIGNMENT_AGENT_KEY] || null;
}

export function assignmentMetadata(issue, agentName, cfg = {}, opts = {}) {
  return {
    [ASSIGNMENT_FINGERPRINT_KEY]: assignmentFingerprint(issue, agentName, cfg, opts),
    [ASSIGNMENT_AGENT_KEY]: agentName,
  };
}

export function isRouterManagedAssignment(issue = {}) {
  return Boolean(recordedAssignmentFingerprint(issue) || recordedAssignmentAgent(issue));
}

export function assignmentFingerprintMatches(issue, agentName, cfg = {}, opts = {}) {
  const recorded = recordedAssignmentFingerprint(issue);
  if (!recorded) return false;
  return recorded === assignmentFingerprint(issue, agentName, cfg, opts);
}
