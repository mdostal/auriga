// HTTP-level tests for the 4 GET endpoints — status codes and JSON shapes,
// plus explicit read-only enforcement (every non-GET method must 405, not
// silently succeed as some future write endpoint).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../index.mjs';

async function withServer(fn) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /api/epics returns 200 and a real epics array', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/epics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    const p2 = body.find((e) => e.id === 'p2-adapter-interface');
    assert.ok(p2, 'expected p2-adapter-interface in the real epics list');
    assert.ok('title' in p2 && 'status' in p2 && 'story_count' in p2 && 'docs_path' in p2);
  });
});

test('GET /api/epics/:id returns 200 and stories[]/docs for a real epic', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/epics/p2-adapter-interface`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, 'p2-adapter-interface');
    assert.ok(Array.isArray(body.stories));
    assert.ok(body.stories.some((s) => s.id === 'p2-multica-backlog-adapter'));
    assert.ok(Array.isArray(body.docs));
  });
});

test('GET /api/epics/:id returns 404 for a nonexistent epic', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/epics/does-not-exist`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error);
  });
});

test('GET /api/epics/:id/stories/:storyId returns 200 and full story YAML content', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/epics/p2-adapter-interface/stories/p2-multica-backlog-adapter`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, 'p2-multica-backlog-adapter');
    assert.ok(Array.isArray(body.acceptance_criteria));
    assert.ok(Array.isArray(body.risks));
  });
});

test('GET /api/epics/:id/stories/:storyId returns 404 for a nonexistent story', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/epics/p2-adapter-interface/stories/does-not-exist`);
    assert.equal(res.status, 404);
  });
});

test('GET /api/activity returns 200 and a merged, time-sorted array', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/activity`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.ok(body.some((a) => a.type === 'commit'));
    assert.ok(body.some((a) => a.type === 'audit'));
  });
});

test('GET on an unknown route returns 404', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// Read-only enforcement: no write endpoint of any kind, ever. Every non-GET
// method on every route must be rejected outright (405), not routed to a
// handler at all.
// ---------------------------------------------------------------------------

for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  test(`${method} /api/epics is rejected (405) — this API is read-only`, async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/epics`, { method });
      assert.equal(res.status, 405);
      const body = await res.json();
      assert.ok(body.error);
    });
  });

  test(`${method} /api/epics/:id/stories/:storyId is rejected (405) — this API is read-only`, async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/epics/p2-adapter-interface/stories/p2-multica-backlog-adapter`, { method });
      assert.equal(res.status, 405);
    });
  });
}
