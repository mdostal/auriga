# Dead, Duplicated, And Low-Entry Page Inventory

Audit for PAN-6555. This is a source-level inventory, not a live analytics
decision. Items below should be validated with production traffic, sitemap
coverage, and business intent before removal.

## mdostal.com

Source repo: `mdostal/personal-site` at
`9d24085f87161f2085f12d7fef785ad6b25ff7aa`.

### Confirmed Redirect Aliases

These are not dead pages, but they are compatibility paths defined in
`next.config.js`:

- `/services` -> `/fractional-cto`
- `/consulting` -> `/fractional-cto`
- `/services/fractional-cto` -> `/fractional-cto`
- `/clients` -> `/book/clients`

### Intentional Low-Entry Or Private Pages

These routes appear intentionally unlisted, gated, noindex, or operational:

- `/career/*` - gated by `middleware.ts` and intended for private job-search
  CRM workflows.
- `/materials/one-pager-fcto` - collateral route under `materials`, likely
  public-but-unlisted.
- `/newsletter-preview` - preview/test-send helper requiring preview secret
  handling.
- `/studio/*` - Sanity Studio.
- `/drone-locked` - locked/gated state for drone content.

### Duplicate Or Overlapping Marketing Surfaces

These are live source routes, but their positioning likely overlaps and should
be rationalized in later cleanup stories:

- `/fractional-cto`, `/enterprise`, `/enterprise/architecture`,
  `/enterprise/audit`, `/enterprise/consultant`, `/smb`, `/smb/checkup`,
  `/tech-checkup`, and `/tools/roi-estimator` all appear to target consulting,
  audit, checkup, or CTO service conversion paths.
- `/book`, `/book/clients`, and `/book/internal` are variants of the same
  Cal.com embed pattern. Keep if they use distinct Cal.com event types; collapse
  or redirect if production behavior is identical.
- `/drone` sits outside the main professional funnel and should stay only if it
  is a deliberate service line or portfolio proof point.

### API Surface Review Candidates

No unused API route was proven dead from static analysis alone. Routes that need
extra owner confirmation because they are operational or webhook-driven:

- `/api/linear-webhook`
- `/api/cross-post-scheduler`
- `/api/scheduled-publish`
- `/api/newsletter/poetry-broadcast`
- `/api/drone-gate`
- `/api/monitoring/alert`

## life.mdostal.com

Source repo: `mdostal/life` at
`cd777c0f217499b688aabdaaff3fc312d9f40adf`.

### Intentional Low-Entry Or Operational Pages

- `/studio/*` - Sanity Studio.
- `/writing/workshop` - workshop/editing surface, likely private or semi-private.
- `/api/workshop` - bearer-token guarded workshop API.
- `/api/carousel/*` - Studio/social carousel generation and rendering endpoints.
- `/api/poems/evaluate-submission` - authenticated submission evaluation.

### Duplicate Or Overlapping Content Surfaces

- `/writing` and `/writing/originals` overlap by domain. `/writing` is the main
  listing with poems, collections, prose, and carousel content; `/writing/originals`
  should be checked for unique navigation intent before keeping both.
- `/gallery` has a Sanity-first content path plus a large committed local
  fallback list. This is intentional resilience, but it can create duplicated
  inventory during a migration if Sanity and local entries both represent the
  same photos.
- `/reels` and `/songs` are separate media sections; no direct duplicate was
  found, but both depend on Sanity content and similar listing/lightbox patterns.

### API Surface Review Candidates

No endpoint was proven dead from static analysis alone. The lowest-entry
operational endpoints to validate with owner intent and logs are:

- `/api/carousel/generate`
- `/api/carousel/batch`
- `/api/carousel/slide`
- `/api/newsletter/broadcast`
- `/api/workshop`
- `/api/poems/evaluate-submission`

## Cross-Site Duplication

- Both sites host `/studio`, but against different schema registries and default
  datasets. This is intentional if editors need site-specific Studio surfaces.
- Both sites implement Sanity clients, query helpers, Resend newsletter flows,
  rate limiting, logging, and PostHog providers independently.
- Both sites have newsletter subscription and broadcast concepts. Consolidation
  could reduce maintenance, but it should wait until audience/list separation is
  confirmed.
- Both sites use the same Sanity project family according to repo docs, but
  schema overlap and dataset boundaries are not centralized.

## Recommended Follow-Up Checks

- Compare these route lists against production sitemap output.
- Pull 30 to 90 days of Vercel and PostHog traffic before deleting or redirecting
  public routes.
- Confirm Cal.com event-type differences for `/book`, `/book/clients`, and
  `/book/internal`.
- Confirm whether `/writing/originals` should remain a separate destination or
  become a tab/filter inside `/writing`.
- Decide whether duplicated Sanity/Resend/PostHog helpers should move into a
  small shared package after cleanup priorities are known.
