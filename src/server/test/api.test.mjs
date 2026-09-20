// HTTP-level tests for the 4 GET endpoints — status codes and JSON shapes,
// plus explicit read-only enforcement (every non-GET method must 405, not
// silently succeed as some future write endpoint).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer, UI_DIST_DIR } from '../index.mjs';

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

// ---------------------------------------------------------------------------
// Bug #1: decodeURIComponent() must never crash the server. An independent
// review found `decodeURIComponent(parts[2])` etc. called with no try/catch
// — since node:http does not catch synchronous throws inside a request
// callback, one request with malformed percent-encoding (a URIError, e.g.
// `%E0%A4`, an incomplete UTF-8 byte sequence) would take down the whole
// process. Every affected call site (both /api/epics/:id-shaped routes and
// static file serving) must return 400, and the server must keep serving
// requests afterward.
// ---------------------------------------------------------------------------

test('GET /api/epics/:id with malformed percent-encoding returns 400, not a crash', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/epics/%E0%A4`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
  });
});

test('GET /api/epics/:id/stories/:storyId with malformed percent-encoding in either segment returns 400', async () => {
  await withServer(async (base) => {
    const res1 = await fetch(`${base}/api/epics/%E0%A4/stories/foo`);
    assert.equal(res1.status, 400);
    const res2 = await fetch(`${base}/api/epics/p2-adapter-interface/stories/%E0%A4`);
    assert.equal(res2.status, 400);
  });
});

test('static file serving with malformed percent-encoding returns 400, not a crash', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/%E0%A4`);
    assert.equal(res.status, 400);
  });
});

test('the server survives a malformed-encoding request and serves subsequent requests normally', async () => {
  await withServer(async (base) => {
    const bad = await fetch(`${base}/api/epics/%E0%A4`);
    assert.equal(bad.status, 400);
    // Same still-alive process, same server instance — a real follow-up
    // request must succeed normally, proving the bad request didn't take
    // the process down.
    const ok = await fetch(`${base}/api/epics`);
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(await ok.json()));
  });
});

// ---------------------------------------------------------------------------
// Bugs #2/#3: path traversal. getEpic/getStory join URL segments straight
// into filesystem paths, and static serving's old guard was a bypassable
// naive `startsWith(UI_DIST_DIR)` string check. Both must reject traversal
// attempts (400/404, never a 200 leaking a file outside their root).
// ---------------------------------------------------------------------------

test('GET /api/epics/:id rejects a traversal-shaped id (path traversal), not a 200', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/epics/..%2F..%2F..%2F..%2F..%2F..%2Fetc`);
    assert.notEqual(res.status, 200);
    assert.ok([400, 404].includes(res.status));
  });
});

test('GET /api/epics/:id/stories/:storyId rejects a traversal-shaped storyId, not a 200', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/epics/p2-adapter-interface/stories/..%2F..%2Fpackage`);
    assert.notEqual(res.status, 200);
    assert.ok([400, 404].includes(res.status));
  });
});

test('GET /api/epics/:id/stories/:storyId rejects a traversal-shaped epicId, not a 200', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/epics/..%2F..%2F..%2Fetc/stories/anything`);
    assert.notEqual(res.status, 200);
    assert.ok([400, 404].includes(res.status));
  });
});

test('static serving: a sibling directory sharing dist\'s name as a string prefix is rejected — proves the guard is a real containment check, not a bypassable string prefix', async (t) => {
  // Reproduces the exact bug: a directory like "dist-evil" sitting next to
  // the real UI_DIST_DIR ("dist") shares "dist" as a plain string prefix,
  // which the OLD `requested.startsWith(UI_DIST_DIR)` check let through.
  const siblingDir = `${UI_DIST_DIR}-evil`;
  fs.mkdirSync(siblingDir, { recursive: true });
  fs.writeFileSync(path.join(siblingDir, 'secret.txt'), 'top secret — must never be served');
  t.after(() => fs.rmSync(siblingDir, { recursive: true, force: true }));

  await withServer(async (base) => {
    const res = await fetch(`${base}/..%2F${path.basename(siblingDir)}%2Fsecret.txt`);
    assert.notEqual(res.status, 200, 'must not serve the sibling directory\'s file as if it were under dist/');
    const body = await res.text();
    assert.ok(!body.includes('top secret'), 'must never leak the sibling file\'s contents');
  });
});

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
