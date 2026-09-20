import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAuthStatus,
  probeClaudeAuth,
  writeAuthRequired,
} from '../lib/claude-auth-status.mjs';

function tempStatusPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auriga-auth-status-'));
  return path.join(dir, 'daemon-auth-status.json');
}

function readStatus(statusPath) {
  return JSON.parse(fs.readFileSync(statusPath, 'utf8'));
}

test('buildAuthStatus records ok with checked_at timestamp', () => {
  const now = new Date('2026-08-05T03:45:00.000Z');
  assert.deepEqual(buildAuthStatus('ok', now), {
    status: 'ok',
    checked_at: '2026-08-05T03:45:00.000Z',
  });
});

test('probeClaudeAuth writes status ok after successful claude -p', () => {
  const statusPath = tempStatusPath();
  const now = new Date('2026-08-05T03:46:00.000Z');
  const calls = [];
  const rec = probeClaudeAuth({
    statusPath,
    now,
    runner: (cmd, args) => {
      calls.push([cmd, args]);
      return 'ok\n';
    },
  });

  assert.deepEqual(calls, [['claude', ['-p', 'Reply with ok if Claude auth is available.']]]);
  assert.deepEqual(rec, {
    status: 'ok',
    checked_at: '2026-08-05T03:46:00.000Z',
  });
  assert.deepEqual(readStatus(statusPath), rec);
});

test('probeClaudeAuth writes auth_required with checked_at after failed claude -p', () => {
  const statusPath = tempStatusPath();
  const now = new Date('2026-08-05T03:47:00.000Z');
  const rec = probeClaudeAuth({
    statusPath,
    now,
    runner: () => {
      throw new Error('auth required');
    },
  });

  assert.equal(rec.status, 'auth_required');
  assert.equal(rec.checked_at, '2026-08-05T03:47:00.000Z');
  assert.match(rec.error, /auth required/);
  assert.deepEqual(readStatus(statusPath), {
    status: 'auth_required',
    checked_at: '2026-08-05T03:47:00.000Z',
  });
});

test('writeAuthRequired preserves the auth-failure status shape', () => {
  const statusPath = tempStatusPath();
  const now = new Date('2026-08-05T03:48:00.000Z');
  const rec = writeAuthRequired({ statusPath, now });

  assert.deepEqual(rec, {
    status: 'auth_required',
    checked_at: '2026-08-05T03:48:00.000Z',
  });
  assert.deepEqual(readStatus(statusPath), rec);
});

