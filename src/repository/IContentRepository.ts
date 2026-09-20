import type { Content } from '../domain/index.ts';

export interface IContentRepository {
  create(content: Content): Promise<void>;
  read(id: string): Promise<Content | null>;
  update(content: Content): Promise<void>;
  delete(id: string): Promise<void>;
}
