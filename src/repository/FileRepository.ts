import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Content } from '../domain/index.ts';
import type { IContentRepository } from './IContentRepository.ts';

interface FileRepositoryOptions {
  rootDir?: string;
}

export class FileRepository implements IContentRepository {
  readonly rootDir: string;
  readonly contentDir: string;

  constructor(options: FileRepositoryOptions = {}) {
    this.rootDir = options.rootDir ?? '.content';
    this.contentDir = join(this.rootDir, 'content');
  }

  async create(content: Content): Promise<void> {
    const path = this.contentPath(content.id);
    await this.ensureContentDir();
    await assertMissing(path);
    await this.writeContent(path, content);
  }

  async read(id: string): Promise<Content | null> {
    const path = this.contentPath(id);
    try {
      const raw = await readFile(path, 'utf8');
      return JSON.parse(raw) as Content;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async update(content: Content): Promise<void> {
    const path = this.contentPath(content.id);
    await this.ensureContentDir();
    await assertExists(path);
    await this.writeContent(path, content);
  }

  async delete(id: string): Promise<void> {
    const path = this.contentPath(id);
    await rm(path, { force: true });
  }

  private contentPath(id: string): string {
    assertSafeContentId(id);
    return join(this.contentDir, `${id}.json`);
  }

  private async ensureContentDir(): Promise<void> {
    await mkdir(this.contentDir, { recursive: true });
  }

  private async writeContent(path: string, content: Content): Promise<void> {
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
      await rename(tempPath, path);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }
}

function assertSafeContentId(id: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
    throw new Error(`Unsafe content id: ${id}`);
  }
}

async function assertExists(path: string): Promise<void> {
  try {
    await access(path, constants.F_OK);
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`Content file not found: ${path}`);
    }
    throw error;
  }
}

async function assertMissing(path: string): Promise<void> {
  try {
    await access(path, constants.F_OK);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  throw new Error(`Content file already exists: ${path}`);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
