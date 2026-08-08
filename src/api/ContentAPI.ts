import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Content, ContentState } from '../domain/index.ts';

export interface ContentVersion {
  id: string;
  version: number;
  content: Content;
  createdAt: string;
}

export interface ContentAPI {
  listByState(state: ContentState): Promise<Content[]>;
  getById(id: string): Promise<Content | null>;
  getVersionHistory(id: string): Promise<ContentVersion[]>;
}

export interface ContentAPIOptions {
  rootDir?: string;
}

const defaultAPI = createContentAPI();

export function createContentAPI(options: ContentAPIOptions = {}): ContentAPI {
  const rootDir = options.rootDir ?? '.content';
  const contentDir = join(rootDir, 'content');

  return {
    async listByState(state: ContentState): Promise<Content[]> {
      const contents = await readAllContent(contentDir);
      return contents.filter((content) => content.state === state);
    },

    async getById(id: string): Promise<Content | null> {
      if (!isSafeContentId(id)) return null;
      return readContent(join(contentDir, `${id}.json`));
    },

    async getVersionHistory(id: string): Promise<ContentVersion[]> {
      if (!isSafeContentId(id)) return [];

      const content = await readContent(join(contentDir, `${id}.json`));
      if (content === null) return [];

      return [
        {
          id: content.id,
          version: content.currentVersion,
          content,
          createdAt: content.metadata.updatedAt,
        },
      ];
    },
  };
}

export function listByState(state: ContentState): Promise<Content[]> {
  return defaultAPI.listByState(state);
}

export function getById(id: string): Promise<Content | null> {
  return defaultAPI.getById(id);
}

export function getVersionHistory(id: string): Promise<ContentVersion[]> {
  return defaultAPI.getVersionHistory(id);
}

async function readAllContent(contentDir: string): Promise<Content[]> {
  let filenames: string[];
  try {
    filenames = await readdir(contentDir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const contentFiles = filenames
    .filter((filename) => filename.endsWith('.json'))
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(
    contentFiles.map((filename) => readContent(join(contentDir, filename))),
  ).then((contents) => contents.filter((content): content is Content => content !== null));
}

async function readContent(path: string): Promise<Content | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as Content;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function isSafeContentId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
