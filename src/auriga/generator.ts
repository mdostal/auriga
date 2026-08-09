import type { AssessedState } from './assessor.ts';
import { PROJECT_REGISTRY } from './registry.ts';

export type StoryComplexity = 'low' | 'medium' | 'high';
export type StepAgent = 'researcher' | 'developer' | 'tester' | 'reviewer';

export interface GeneratedStep {
  id: string;
  description: string;
  agent: StepAgent;
  dependsOn?: string[];
}

export interface GeneratedStory {
  id: string;
  epic: string;
  title: string;
  status: 'pending';
  complexity: StoryComplexity;
  methodology: 'classic';
  dependsOn: string[];
  description: string;
  acceptanceCriteria: string[];
  steps: GeneratedStep[];
  targetRepo: string;
  designDecisions: string[];
  risks: string[];
}

export interface GeneratedEpic {
  name: string;
  title: string;
  targetRepo: string;
  targetCodebase: string;
  methodology: 'classic';
  stories: GeneratedStory[];
}

/** Raised when a generated story fails the anti-skeleton guard (PAN-7840 risk mitigation). */
export class SkeletonStoryError extends Error {}

const MIN_ACCEPTANCE_CRITERIA = 3;
const MIN_STEPS = 3;
const MIN_DESCRIPTION_LENGTH = 40;
const MIN_GAP_LENGTH = 3;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'item';
}

function complexityForGap(gap: string): StoryComplexity {
  const lower = gap.toLowerCase();
  if (/\b(rewrite|migrate|migration|architecture|redesign|overhaul)\b/.test(lower)) {
    return 'high';
  }
  if (/\b(add|small|tweak|copy|label|typo|minor)\b/.test(lower)) {
    return 'low';
  }
  return 'medium';
}

/**
 * A generated story is a "skeleton" if it would give a build lane nothing concrete to
 * execute against: too few acceptance criteria, a description too thin to act on, or a
 * step list that skips real implementation/verification work.
 */
export function isSkeletonStory(story: GeneratedStory): boolean {
  if (story.acceptanceCriteria.length < MIN_ACCEPTANCE_CRITERIA) return true;
  if (story.description.trim().length < MIN_DESCRIPTION_LENGTH) return true;
  if (story.steps.length < MIN_STEPS) return true;
  if (!story.targetRepo) return true;
  const hasImplementStep = story.steps.some(s => s.agent === 'developer');
  const hasVerifyStep = story.steps.some(s => s.agent === 'tester' || s.agent === 'reviewer');
  if (!hasImplementStep || !hasVerifyStep) return true;
  return false;
}

/**
 * Builds the slice-2 delivery epic payload for a project from its assessed state.
 * Every story it emits carries `targetRepo` so agnostic build lanes (Codex/Gemini) can
 * resolve where to clone/branch/push without guessing (see CLAUDE.md target_repo contract).
 */
export class SliceEpicGenerator {
  generateEpic(state: AssessedState): GeneratedEpic {
    const project = PROJECT_REGISTRY.find(p => p.name === state.projectName);
    if (!project) {
      throw new Error(`Unknown project "${state.projectName}" — not present in PROJECT_REGISTRY`);
    }

    const gaps = state.missingGaps
      .map(g => g.trim())
      .filter(g => g.length >= MIN_GAP_LENGTH);

    if (gaps.length === 0) {
      throw new Error(
        `No usable missing gaps for "${state.projectName}" — nothing to decompose into slice-2 stories`
      );
    }

    const epicName = `${slugify(state.projectName)}-slice-2`;
    const stories = gaps.map((gap, index) =>
      this.buildStory(gap, index, epicName, project.repoSlug, state)
    );

    for (const story of stories) {
      if (isSkeletonStory(story)) {
        throw new SkeletonStoryError(
          `Generated story "${story.id}" for "${state.projectName}" is a skeleton — refusing to emit it`
        );
      }
    }

    return {
      name: epicName,
      title: `Slice 2: ${state.projectName} — close the delivered-vs-vision gap`,
      targetRepo: project.repoSlug,
      targetCodebase: project.workspacePath,
      methodology: 'classic',
      stories,
    };
  }

  private buildStory(
    gap: string,
    index: number,
    epicName: string,
    targetRepo: string,
    state: AssessedState
  ): GeneratedStory {
    const id = `${epicName}-${index + 1}-${slugify(gap)}`;
    const deliveredSummary = state.deliveredFeatures.length
      ? state.deliveredFeatures.join(', ')
      : 'no delivered features recorded yet';

    const description =
      `${state.projectName} has delivered: ${deliveredSummary}. ` +
      `The recovered slice-1 vision still calls for: "${gap}". ` +
      `This story closes that specific gap in ${targetRepo} — implement it as a real, ` +
      `working change (not a stub), landed against the project's own delivery lane.`;

    const acceptanceCriteria = [
      `Given ${state.projectName}'s current state, when "${gap}" is implemented, ` +
        `then the capability is observable in the running system (not just present in source).`,
      `Given the existing delivered features (${deliveredSummary}), when "${gap}" lands, ` +
        `then none of them regress.`,
      `Given the story reaches review, when it is checked against slice-2 acceptance, ` +
        `then real, passing tests demonstrate "${gap}" works end-to-end.`,
    ];

    const steps: GeneratedStep[] = [
      {
        id: 'implement',
        description: `Implement "${gap}" in ${targetRepo} against the recovered slice-1 vision.`,
        agent: 'developer',
      },
      {
        id: 'test',
        description: `Add or update tests proving "${gap}" behaves correctly end-to-end.`,
        agent: 'tester',
        dependsOn: ['implement'],
      },
      {
        id: 'review',
        description: `Review the change for regressions against delivered features (${deliveredSummary}) and confirm it is not a skeleton/stub.`,
        agent: 'reviewer',
        dependsOn: ['test'],
      },
    ];

    return {
      id,
      epic: epicName,
      title: gap,
      status: 'pending',
      complexity: complexityForGap(gap),
      methodology: 'classic',
      dependsOn: [],
      description,
      acceptanceCriteria,
      steps,
      targetRepo,
      designDecisions: [
        `Story scoped to a single recovered gap ("${gap}") so it stays a buildable unit, not a re-bundled slice-1 backlog dump.`,
      ],
      risks: [
        `Gap text was extracted from a Gap Map via keyword parsing and may be imprecise; the developer step must confirm scope against ${targetRepo} before implementing.`,
      ],
    };
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlBlock(value: string, indent: string): string {
  return value
    .split('\n')
    .map(line => `${indent}${line}`)
    .join('\n');
}

function yamlList(items: string[], indent: string): string {
  if (items.length === 0) return `${indent}[]`;
  return items.map(item => `${indent}- ${yamlString(item)}`).join('\n');
}

/** Serializes a generated story to the plugin-hive story YAML schema used under .pHive/epics/. */
export function storyToYaml(story: GeneratedStory): string {
  const lines: string[] = [];
  lines.push(`id: ${story.id}`);
  lines.push(`epic: ${story.epic}`);
  lines.push(`title: ${yamlString(story.title)}`);
  lines.push(`status: ${story.status}`);
  lines.push(`complexity: ${story.complexity}`);
  lines.push(`methodology: ${story.methodology}`);
  lines.push(`target_repo: ${yamlString(story.targetRepo)}`);
  lines.push(`depends_on: [${story.dependsOn.join(', ')}]`);
  lines.push('');
  lines.push('description: |');
  lines.push(yamlBlock(story.description, '  '));
  lines.push('');
  lines.push('acceptance_criteria:');
  lines.push(yamlList(story.acceptanceCriteria, '  '));
  lines.push('');
  lines.push('steps:');
  for (const step of story.steps) {
    lines.push(`  - id: ${step.id}`);
    lines.push(`    description: ${yamlString(step.description)}`);
    lines.push(`    agent: ${step.agent}`);
    if (step.dependsOn?.length) {
      lines.push(`    depends_on: [${step.dependsOn.join(', ')}]`);
    }
  }
  lines.push('');
  lines.push('design_decisions:');
  for (const decision of story.designDecisions) {
    lines.push(`  - decision: ${yamlString(decision)}`);
  }
  lines.push('');
  lines.push('risks:');
  for (const risk of story.risks) {
    lines.push(`  - severity: medium`);
    lines.push(`    description: ${yamlString(risk)}`);
  }
  return lines.join('\n') + '\n';
}

/** Serializes a generated epic to the plugin-hive epic YAML schema used under .pHive/epics/. */
export function epicToYaml(epic: GeneratedEpic): string {
  const lines: string[] = [];
  lines.push(`name: ${epic.name}`);
  lines.push(`title: ${yamlString(epic.title)}`);
  lines.push(`target_repo: ${yamlString(epic.targetRepo)}`);
  lines.push(`target_codebase: ${epic.targetCodebase}`);
  lines.push(`methodology: ${epic.methodology}`);
  lines.push('');
  lines.push('stories:');
  for (const story of epic.stories) {
    lines.push(`  - id: ${story.id}`);
    lines.push(`    title: ${yamlString(story.title)}`);
    lines.push(`    complexity: ${story.complexity}`);
    lines.push(`    depends_on: [${story.dependsOn.join(', ')}]`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}
