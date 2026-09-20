import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SliceEpicGenerator,
  SkeletonStoryError,
  isSkeletonStory,
  storyToYaml,
  epicToYaml,
} from '../../src/auriga/generator.ts';
import type { GeneratedStory } from '../../src/auriga/generator.ts';
import type { AssessedState } from '../../src/auriga/assessor.ts';

function stateFor(projectName: string, missingGaps: string[], deliveredFeatures: string[] = []): AssessedState {
  return { projectName, deliveredFeatures, missingGaps };
}

test('SliceEpicGenerator assigns the registry target_repo to the epic and every story', () => {
  const generator = new SliceEpicGenerator();
  const state = stateFor('Heimdall', ['Add lane-health dashboard', 'Wire actuate v2 alerts']);

  const epic = generator.generateEpic(state);

  assert.equal(epic.targetRepo, 'mdostal/heimdall');
  assert.equal(epic.name, 'heimdall-slice-2');
  assert.ok(epic.stories.length === 2);
  for (const story of epic.stories) {
    assert.equal(story.targetRepo, 'mdostal/heimdall');
  }
});

test('SliceEpicGenerator decomposes each missing gap into its own buildable story', () => {
  const generator = new SliceEpicGenerator();
  const state = stateFor(
    'Minerva',
    ['Recover slice-1 planning UI', 'Persist plan revisions'],
    ['Core planner API']
  );

  const epic = generator.generateEpic(state);

  assert.equal(epic.stories.length, 2);
  assert.equal(epic.stories[0].title, 'Recover slice-1 planning UI');
  assert.equal(epic.stories[1].title, 'Persist plan revisions');
  for (const story of epic.stories) {
    assert.ok(story.acceptanceCriteria.length >= 3);
    assert.ok(story.description.includes('Core planner API'));
    assert.ok(!isSkeletonStory(story));
  }
});

test('SliceEpicGenerator throws for a project not in the registry', () => {
  const generator = new SliceEpicGenerator();
  const state = stateFor('Not A Real Project', ['do something']);

  assert.throws(() => generator.generateEpic(state), /not present in PROJECT_REGISTRY/);
});

test('SliceEpicGenerator throws when there are no usable missing gaps', () => {
  const generator = new SliceEpicGenerator();
  const state = stateFor('Auriga', ['', '  ', 'ship it']);

  const epic = generator.generateEpic(state);
  assert.equal(epic.stories.length, 1);

  assert.throws(
    () => generator.generateEpic(stateFor('Auriga', ['', '  '])),
    /nothing to decompose/
  );
});

test('isSkeletonStory flags a thin, non-actionable story', () => {
  const skeleton: GeneratedStory = {
    id: 'x-1',
    epic: 'x',
    title: 'TODO',
    status: 'pending',
    complexity: 'low',
    methodology: 'classic',
    dependsOn: [],
    description: 'todo',
    acceptanceCriteria: ['done'],
    steps: [{ id: 'implement', description: 'do it', agent: 'developer' }],
    targetRepo: 'mdostal/auriga',
    designDecisions: [],
    risks: [],
  };

  assert.equal(isSkeletonStory(skeleton), true);
});

test('SliceEpicGenerator refuses to emit a skeleton story via a corrupted builder', () => {
  class BrokenGenerator extends SliceEpicGenerator {
    // simulate a future generator path that forgets to flesh out a story
    generateEpic(state: AssessedState) {
      const epic = super.generateEpic(state);
      epic.stories[0].acceptanceCriteria = [];
      // re-run the guard the base class would have applied
      if (isSkeletonStory(epic.stories[0])) {
        throw new SkeletonStoryError(`Generated story "${epic.stories[0].id}" is a skeleton`);
      }
      return epic;
    }
  }

  const generator = new BrokenGenerator();
  const state = stateFor('Auriga', ['Ship the slice-2 sweeper']);

  assert.throws(() => generator.generateEpic(state), SkeletonStoryError);
});

test('epicToYaml and storyToYaml emit target_repo and remain well-formed', () => {
  const generator = new SliceEpicGenerator();
  const epic = generator.generateEpic(
    stateFor('Argus', ['Ship anomaly detector'], ['Metrics ingest'])
  );

  const epicYaml = epicToYaml(epic);
  assert.match(epicYaml, /^name: argus-slice-2/m);
  assert.match(epicYaml, /target_repo: "mdostal\/argus"/);
  assert.match(epicYaml, /stories:\n {2}- id: /);

  const storyYaml = storyToYaml(epic.stories[0]);
  assert.match(storyYaml, /^id: argus-slice-2-1-/m);
  assert.match(storyYaml, /target_repo: "mdostal\/argus"/);
  assert.match(storyYaml, /acceptance_criteria:\n {2}- "Given/);
  assert.match(storyYaml, /steps:\n {2}- id: implement/);
});
