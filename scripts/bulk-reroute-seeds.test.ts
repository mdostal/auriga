import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUnplannedTopLevelSeed, rerouteIssue } from './bulk-reroute-seeds.ts';

// Minimal issue fixtures mirroring the shape returned by
// `multica issue list --output json`.
const issue = (metadata: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) => ({
  id: 'i1',
  identifier: 'PAN-1',
  status: 'blocked',
  metadata,
  parent_issue_id: null,
  title: 'some issue',
  ...overrides,
});

test('isUnplannedTopLevelSeed matches the live PAN-6646 wording', () => {
  assert.ok(isUnplannedTopLevelSeed(issue({
    blocked_reason: 'Unplanned top-level seed; needs Minerva/plugin-hive planning before build.',
  })));
});

test('isUnplannedTopLevelSeed is case-insensitive', () => {
  assert.ok(isUnplannedTopLevelSeed(issue({ blocked_reason: 'UNPLANNED TOP-LEVEL SEED, blocked for planning' })));
  assert.ok(isUnplannedTopLevelSeed(issue({ blocked_reason: 'unplanned Top-Level Seed detected' })));
});

test('isUnplannedTopLevelSeed matches as a substring within longer free text', () => {
  assert.ok(isUnplannedTopLevelSeed(issue({
    blocked_reason: 'This is an unplanned top-level seed; needs Minerva/plugin-hive planning before build execution.',
  })));
});

test('isUnplannedTopLevelSeed rejects unrelated blocked_reason text', () => {
  assert.ok(!isUnplannedTopLevelSeed(issue({ blocked_reason: 'corrected Gemini chat export required for memory ingestion' })));
  assert.ok(!isUnplannedTopLevelSeed(issue({ blocked_reason: 'depends_on PAN-6678 and PAN-6679 are blocked' })));
});

test('isUnplannedTopLevelSeed guards against missing/absent metadata.blocked_reason', () => {
  assert.ok(!isUnplannedTopLevelSeed(issue({})));
  assert.ok(!isUnplannedTopLevelSeed(issue(undefined as unknown as Record<string, unknown>)));
  assert.ok(!isUnplannedTopLevelSeed(issue({}, { metadata: {} })));
  assert.ok(!isUnplannedTopLevelSeed(issue({}, { metadata: undefined })));
});

test('isUnplannedTopLevelSeed guards against non-string blocked_reason', () => {
  assert.ok(!isUnplannedTopLevelSeed(issue({ blocked_reason: 42 })));
  assert.ok(!isUnplannedTopLevelSeed(issue({ blocked_reason: null })));
  assert.ok(!isUnplannedTopLevelSeed(issue({ blocked_reason: { nested: true } })));
});

// Regression for the bug where `metadata delete` and `status` were called
// without `{ json: false }`. Both `multica issue metadata delete` and
// `multica issue status` default to TABLE output (not JSON) when
// `--output json` isn't passed on the CLI invocation itself, and real `run()`
// unconditionally `JSON.parse`s stdout unless told `{ json: false }`. If
// either call omits that option, feeding it realistic non-JSON table output
// (as the real CLI would produce) throws a SyntaxError partway through
// rerouteIssue, aborting before the remaining mutation(s) run — silently
// leaving the issue stuck (reassigned/metadata-cleared but never unblocked).
test('rerouteIssue calls metadata-delete and status with { json: false }, and survives non-JSON table output from those calls', () => {
  const calls: { args: string[]; opts?: { json?: boolean } }[] = [];

  // Mirrors the real `run()`'s JSON-parsing contract: JSON.parse is only
  // skipped when explicitly told `{ json: false }`. Table-formatted stdout
  // (as the live CLI actually prints for `metadata delete` / `status` sans
  // `--output json`) would blow up JSON.parse if `{ json: false }` were
  // dropped from either call.
  const fakeRun = (args: string[], opts: { json?: boolean } = { json: true }): any => {
    calls.push({ args, opts });
    const isMetadataDelete = args[0] === 'issue' && args[1] === 'metadata' && args[2] === 'delete';
    const isStatus = args[0] === 'issue' && args[1] === 'status';
    const out =
      isMetadataDelete || isStatus
        ? 'ID       KEY              VALUE\n--       ---              -----\ni1       blocked_reason   (deleted)\n' // realistic non-JSON table output
        : '{"id":"i1","identifier":"PAN-1"}';
    if (opts.json === false) return out;
    return out.trim() ? JSON.parse(out) : null; // throws SyntaxError on table text
  };

  const testIssue = issue({ blocked_reason: 'unplanned top-level seed' });

  assert.doesNotThrow(() => rerouteIssue(testIssue as any, fakeRun as any));

  assert.equal(calls.length, 3, 'all three mutations must run, not just the first');

  const [updateCall, metadataDeleteCall, statusCall] = calls;
  assert.deepEqual(updateCall.args.slice(0, 2), ['issue', 'update']);
  assert.deepEqual(metadataDeleteCall.args.slice(0, 3), ['issue', 'metadata', 'delete']);
  assert.equal(metadataDeleteCall.opts?.json, false, 'metadata delete must pass { json: false }');
  assert.deepEqual(statusCall.args.slice(0, 2), ['issue', 'status']);
  assert.equal(statusCall.opts?.json, false, 'status must pass { json: false }');
});
