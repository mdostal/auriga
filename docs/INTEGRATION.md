# Content Integration API

Auriga exposes a read-only content API for downstream tools such as Flayr. The
API hides the current `.content` file layout so external consumers can query
content without coupling to storage details.

## Importing

Use the default exports when Auriga is running from a repository root with the
standard `.content` directory:

```ts
import { getById, listByState } from '../src/api/index.ts';

const published = await listByState('published');
const content = await getById('launch-post');
```

For tests, scripts, or embedded tools that need a specific content root, create a
scoped API instance:

```ts
import { createContentAPI } from '../src/api/index.ts';

const contentAPI = createContentAPI({ rootDir: '/path/to/.content' });
const scheduled = await contentAPI.listByState('scheduled');
```

## Methods

### `listByState(state)`

Returns every content item whose workflow state matches `state`.

```ts
const published = await contentAPI.listByState('published');
```

Supported states are `draft`, `scheduled`, and `published`.

### `getById(id)`

Returns the full `Content` object for a safe content ID. Missing or unsafe IDs
return `null`.

```ts
const content = await contentAPI.getById('launch-post');

if (content === null) {
  // Not found or invalid ID.
}
```

### `getVersionHistory(id)`

Returns the version history available from the current V1 storage. Today that is
the current persisted content version; future storage can add historical
versions without changing the downstream API method.

```ts
const versions = await contentAPI.getVersionHistory('launch-post');
```

## Content Shape

The API returns Auriga's `Content` domain object:

```ts
interface Content {
  id: string;
  title: string;
  body: string;
  type: 'post' | 'article' | 'marketing';
  state: 'draft' | 'scheduled' | 'published';
  channel?: string;
  metadata: {
    createdAt: string;
    updatedAt: string;
    publishedAt?: string;
    scheduledFor?: string;
    author?: string;
    tags?: string[];
  };
  currentVersion: number;
}
```
