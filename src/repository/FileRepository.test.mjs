import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRepository } from './FileRepository.ts';

const sampleContent = {
  id: 'draft-1',
  title: 'Draft title',
  body: 'Draft body',
  type: 'post',
  state: 'draft',
  metadata: {
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    author: 'Auriga',
    tags: ['drafts'],
  },
  currentVersion: 1,
};

test('create writes content JSON to .content/content/{id}.json', async () => {
  await withRepository(async ({ rootDir, repository }) => {
    await repository.create(sampleContent);

    const filePath = join(rootDir, 'content', `${sampleContent.id}.json`);
    const persisted = JSON.parse(await readFile(filePath, 'utf8'));

    assert.deepEqual(persisted, sampleContent);
  });
});

test('read returns content with all fields intact', async () => {
  await withRepository(async ({ repository }) => {
    await repository.create(sampleContent);

    const content = await repository.read(sampleContent.id);

    assert.deepEqual(content, sampleContent);
  });
});

test('update persists changes to disk', async () => {
  await withRepository(async ({ repository }) => {
    await repository.create(sampleContent);
    const updated = {
      ...sampleContent,
      title: 'Updated draft title',
      body: 'Updated body',
      metadata: {
        ...sampleContent.metadata,
        updatedAt: '2026-08-08T01:00:00.000Z',
      },
      currentVersion: 2,
    };

    await repository.update(updated);

    assert.deepEqual(await repository.read(sampleContent.id), updated);
  });
});

test('delete removes the content file from disk', async () => {
  await withRepository(async ({ repository }) => {
    await repository.create(sampleContent);

    await repository.delete(sampleContent.id);

    assert.equal(await repository.read(sampleContent.id), null);
  });
});

test('repository rejects path-unsafe content IDs', async () => {
  await withRepository(async ({ repository }) => {
    await assert.rejects(
      () => repository.create({ ...sampleContent, id: '../draft-1' }),
      /Unsafe content id/,
    );
  });
});

async function withRepository(callback) {
  const dir = await mkdtemp(join(tmpdir(), 'content-repository-'));
  const rootDir = join(dir, '.content');
  const repository = new FileRepository({ rootDir });

  try {
    await callback({ rootDir, repository });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
