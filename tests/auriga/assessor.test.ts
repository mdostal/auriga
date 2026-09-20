import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectAssessor } from '../../src/auriga/assessor.ts';

test('ProjectAssessor parses Gap Map with delivered and missing sections', () => {
  const assessor = new ProjectAssessor();
  const mockGapMap = `
# Project Gap Map

## Delivered Features
- Feature A
- Feature B
- Implementation of core API

## Missing Gaps
- Feature C
- Security hardening
- E2E tests
`;

  const result = assessor.parseGapMap('Minerva', mockGapMap);
  
  assert.equal(result.projectName, 'Minerva');
  assert.deepEqual(result.deliveredFeatures, [
    'Feature A',
    'Feature B',
    'Implementation of core API'
  ]);
  assert.deepEqual(result.missingGaps, [
    'Feature C',
    'Security hardening',
    'E2E tests'
  ]);
});

test('ProjectAssessor handles completed/todo keywords', () => {
  const assessor = new ProjectAssessor();
  const mockGapMap = `
### Done
* auth module
* database schema

### TODO
* frontend integration
`;

  const result = assessor.parseGapMap('Heimdall', mockGapMap);
  
  assert.deepEqual(result.deliveredFeatures, [
    'auth module',
    'database schema'
  ]);
  assert.deepEqual(result.missingGaps, [
    'frontend integration'
  ]);
});

test('ProjectAssessor returns empty arrays for empty content', () => {
  const assessor = new ProjectAssessor();
  const result = assessor.parseGapMap('Auriga', '');
  
  assert.deepEqual(result.deliveredFeatures, []);
  assert.deepEqual(result.missingGaps, []);
});

test('ProjectAssessor skips non-list items in sections', () => {
  const assessor = new ProjectAssessor();
  const mockGapMap = `
Delivered
We have successfully finished the following:
- auth
This was hard.

Missing
The rest of the app:
- UI
`;

  const result = assessor.parseGapMap('Auriga', mockGapMap);
  
  assert.deepEqual(result.deliveredFeatures, ['auth']);
  assert.deepEqual(result.missingGaps, ['UI']);
});
