import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createDecisionsRouter } from '../decisions.mjs';

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

function recordsFile(count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auriga-decisions-'));
  const file = path.join(dir, 'router-records.jsonl');
  const base = Date.parse('2026-10-11T00:00:00.000Z');
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify({ ts: new Date(base + i * 1000).toISOString(), event: 'decision', identifier: `X-${i}` }));
  }
  lines.splice(2, 0, '{not json');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { file, dir };
}

async function get(file, query = '') {
  const app = express();
  app.use(createDecisionsRouter({ recordsFile: file, env: {} }));
  let out;
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/decisions${query}`);
    out = { status: res.status, body: await res.json() };
  });
  return out;
}

const ids = (body) => body.records.map((r) => r.identifier);

test('GET /api/decisions returns every record oldest first, skipping unparseable lines', async () => {
  const { file, dir } = recordsFile(5);
  try {
    const { status, body } = await get(file);
    assert.equal(status, 200);
    assert.deepEqual(ids(body), ['X-0', 'X-1', 'X-2', 'X-3', 'X-4']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('GET /api/decisions?since keeps records strictly after it; limit takes the first N after since', async () => {
  const { file, dir } = recordsFile(10);
  try {
    const { body } = await get(file, '?since=2026-10-11T00:00:03.000Z&limit=3');
    assert.deepEqual(ids(body), ['X-4', 'X-5', 'X-6']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('GET /api/decisions?limit without since returns the newest N, still oldest first', async () => {
  const { file, dir } = recordsFile(10);
  try {
    const { body } = await get(file, '?limit=2');
    assert.deepEqual(ids(body), ['X-8', 'X-9']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('GET /api/decisions rejects a bad since or limit', async () => {
  const { file, dir } = recordsFile(1);
  try {
    assert.equal((await get(file, '?since=yesterday')).status, 400);
    assert.equal((await get(file, '?limit=0')).status, 400);
    assert.equal((await get(file, '?limit=abc')).status, 400);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('GET /api/decisions: a missing records file is no records', async () => {
  const { body, status } = await get(path.join(os.tmpdir(), 'auriga-decisions-missing.jsonl'));
  assert.equal(status, 200);
  assert.deepEqual(body, { records: [] });
});

test('GET /api/decisions says so when AURIGA_RECORDS_FILE is not configured', async () => {
  const app = express();
  app.use(createDecisionsRouter({ env: {} }));
  await withServer(app, async (base) => {
    const body = await (await fetch(`${base}/api/decisions`)).json();
    assert.deepEqual(body.records, []);
    assert.match(body.unavailable, /AURIGA_RECORDS_FILE/);
  });
});
