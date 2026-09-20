# Sanity Schema Inventory

Audit for PAN-6555. Both sites embed Sanity Studio at `/studio`, but their
schema registries are separate and are stored in their own repos.

## mdostal/personal-site

Source commit: `9d24085f87161f2085f12d7fef785ad6b25ff7aa`.

### Configuration

- Studio config: `sanity.config.ts`.
- CLI config: `sanity.cli.ts`.
- Schema registry: `sanity/schemas/index.ts`.
- Runtime client and GROQ helpers: `lib/sanity.ts`.
- Generated Sanity types: `sanity/types.ts`.
- Studio base path: `/studio`.
- Default dataset: `process.env.NEXT_PUBLIC_SANITY_DATASET || 'production'`.
- API version in runtime client and Studio list filters: `2025-02-19`.

### Registered Document Types

The schema registry exports:

- `post`
- `category`
- `checklistItem`
- `siteSettings`
- `strategyDoc`
- `companyExperience`
- `certification`
- `education`
- `jobApplication`
- `messageTemplate`
- `toptalPrepResource`
- `service`
- `caseStudy`
- `testimonial`

### Studio Structure And Tools

- Custom structure groups Site Settings, Blog Posts, Blog Filters, Career data,
  resume/company content, services, case studies, testimonials, checklist
  sections, message templates, and Toptal prep resources.
- Custom Studio tools:
  - `dashboard`
  - `checklist`
  - `schedule`
  - `calendar`
  - `bulk-status`
- Built-in/third-party Studio plugins:
  - `structureTool`
  - `visionTool`
  - `presentationTool`
  - `codeInput`
  - `simplerColorInput`
  - `media`
- Custom document actions include publish/status transitions, scheduling,
  cross-post actions for Medium/Hashnode/Dev.to, and job application status
  actions.
- Custom document badges include editorial status, scheduled state, application
  status, and Hashnode state.
- Blog documents get custom edit/preview/analytics views via
  `BlogEditorView`, `BlogPreviewView`, and `PostAnalytics`.

### Runtime Consumers

- Blog routes, feeds, sitemap, related-posts, and homepage latest posts query
  `post`, `category`, and related fields.
- Resume and companies pages query `companyExperience`, `certification`, and
  `education`, falling back to local resume data when needed.
- Career routes query `jobApplication`, `checklistItem`, `strategyDoc`,
  `messageTemplate`, and `toptalPrepResource`.
- Newsletter and webhook routes read and write `post.newsletterSentAt`.
- Cross-post routes read `post` content and patch syndication fields.

## mdostal/life

Source commit: `cd777c0f217499b688aabdaaff3fc312d9f40adf`.

### Configuration

- Studio config: `sanity.config.ts`.
- CLI config: `sanity.cli.ts`.
- Schema registry: `src/sanity/schemas/index.ts`.
- Runtime client and queries: `src/sanity/client.ts`, `src/sanity/queries.ts`.
- Additional simple client helper: `src/lib/sanity.ts`.
- Studio base path: `/studio`.
- Default dataset: `process.env.NEXT_PUBLIC_SANITY_DATASET || 'production-life'`.

### Registered Document Types

The schema registry exports:

- `poem`
- `poemCollection`
- `prose`
- `galleryPhoto`
- `chapter`
- `reel`
- `song`

### Studio Structure And Tools

- Custom structure groups Life Chapters, Gallery Photos, Reels, Songs, Poems,
  poem editorial status filters, song candidates, collections with nested poem
  lists, prose, and chapter-scoped photo lists.
- Custom Studio tools:
  - `dashboard`
  - `carousel`
  - `schedule`
  - `submissions`
- Built-in/third-party Studio plugins:
  - `structureTool`
  - `visionTool`
  - `media`
- `poem` documents get custom compare and preview views.

### Runtime Consumers

- `/writing` queries poems, collections, prose, and recent carousel candidates.
- `/gallery` queries visible gallery photos and falls back to committed local
  gallery data when Sanity has no visible photos.
- `/reels` queries visible reels.
- `/songs` queries curated songs.
- `/rss.xml` queries published poems for RSS output.
- Carousel API routes write carousel metadata back to Sanity.
- Poem submission evaluation reads and patches `poem` documents.

## Cross-Repo Schema Notes

- The two sites can share a Sanity project ID, but they do not share a schema
  package.
- Dataset defaults differ: `production` for `mdostal.com`, `production-life`
  for `life.mdostal.com`.
- `life` README states that the repos may share the Sanity project and that
  cross-repo schema consolidation remains an open question.
- Content overlap is limited: `personal-site` is professional/blog/career
  oriented, while `life` is poetry/gallery/reels/songs oriented.
