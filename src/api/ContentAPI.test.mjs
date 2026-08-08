import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { createContentAPI, getById, listByState } from './ContentAPI.ts';

const draftContent = {
  id: 'draft-1',
  title: 'Draft title',
  body: 'Draft body',
  type: 'post',
  state: 'draft',
  metadata: {
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
  },
  currentVersion: 1,
};

const publishedContent = {
  id: 'published-1',
  title: 'Published title',
  body: 'Published body',
  type: 'article',
  state: 'published',
  metadata: {
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T01:00:00.000Z',
    publishedAt: '2026-08-08T01:00:00.000Z',
  },
  currentVersion: 2,
};

test('module exports read-only query functions', () => {
  assert.equal(typeof listByState, 'function');
  assert.equal(typeof getById, 'function');
});

test('listByState returns content matching the requested workflow state', async () => {
  await withContentRoot(async ({ rootDir }) => {
    await writeContent(rootDir, draftContent);
    await writeContent(rootDir, publishedContent);
    const api = createContentAPI({ rootDir });

    const published = await api.listByState('published');

    assert.deepEqual(published, [publishedContent]);
  });
});

test('getById returns the full Content object for an existing id', async () => {
  await withContentRoot(async ({ rootDir }) => {
    await writeContent(rootDir, publishedContent);
    const api = createContentAPI({ rootDir });

    assert.deepEqual(await api.getById(publishedContent.id), publishedContent);
  });
});

test('getById returns null for missing or unsafe ids', async () => {
  await withContentRoot(async ({ rootDir }) => {
    const api = createContentAPI({ rootDir });

    assert.equal(await api.getById('missing'), null);
    assert.equal(await api.getById('../published-1'), null);
  });
});

test('getVersionHistory exposes the current persisted version for V1 storage', async () => {
  await withContentRoot(async ({ rootDir }) => {
    await writeContent(rootDir, publishedContent);
    const api = createContentAPI({ rootDir });

    assert.deepEqual(await api.getVersionHistory(publishedContent.id), [
      {
        id: publishedContent.id,
        version: publishedContent.currentVersion,
        content: publishedContent,
        createdAt: publishedContent.metadata.updatedAt,
      },
    ]);
  });
});

async function withContentRoot(callback) {
  const dir = await mkdtemp(join(tmpdir(), 'content-api-'));
  const rootDir = join(dir, '.content');

  try {
    await callback({ rootDir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeContent(rootDir, content) {
  const contentDir = join(rootDir, 'content');
  await mkdir(contentDir, { recursive: true });
  await writeFile(
    join(contentDir, `${content.id}.json`),
    `${JSON.stringify(content, null, 2)}\n`,
    'utf8',
  );
}
