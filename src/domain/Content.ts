import type { ContentState } from './ContentState.ts';
import type { ContentType } from './ContentType.ts';

/**
 * Metadata attached to a content item for lifecycle tracking and filtering.
 */
export interface ContentMetadata {
  /** ISO 8601 timestamp for when the content item was created. */
  createdAt: string;
  /** ISO 8601 timestamp for the most recent update. */
  updatedAt: string;
  /** ISO 8601 timestamp for when the item was published, when applicable. */
  publishedAt?: string;
  /** ISO 8601 timestamp for scheduled publication, when applicable. */
  scheduledFor?: string;
  /** Optional author or owner display name. */
  author?: string;
  /** Optional tags used for filtering and discovery. */
  tags?: string[];
}

/**
 * Core content entity managed by the content system.
 */
export interface Content {
  /** Stable unique identifier for the content item. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Markdown body content in the MVP. */
  body: string;
  /** Content category used for grouping and downstream integrations. */
  type: ContentType;
  /** Current workflow state. */
  state: ContentState;
  /** Optional destination channel, such as a social network or newsletter. */
  channel?: string;
  /** Lifecycle metadata for the content item. */
  metadata: ContentMetadata;
  /** Current version number for the content item. */
  currentVersion: number;
}
