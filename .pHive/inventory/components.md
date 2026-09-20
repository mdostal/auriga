# Component Inventory

Audit for PAN-6555. This maps reusable UI surfaces in `mdostal/personal-site`
and `mdostal/life` as of the audited `main` commits.

## mdostal/personal-site Components

Source commit: `9d24085f87161f2085f12d7fef785ad6b25ff7aa`.

### Shared Application Shell

- `components/providers.tsx` combines theme and PostHog providers.
- `components/navigation.tsx`, `components/nav-mega-menu.tsx`, and
  `components/footer.tsx` provide the global shell.
- `components/theme-provider.tsx`, `components/ui/theme-toggle.tsx`, and
  `app/store/theme-store.ts` support theme behavior.
- `components/preview-banner.tsx`, `components/feature-flag.tsx`,
  `components/filtered-speed-insights.tsx`, `components/meta-pixel.tsx`, and
  `components/animated-page-wrapper.tsx` are cross-cutting app helpers.

### Shared UI Primitives

Located in `components/ui/`:

- `accordion`, `badge`, `button`, `card`, `carousel`, `dialog`, `form`,
  `hover-card`, `input`, `label`, `navigation-menu`, `sonner`, `textarea`,
  `theme-toggle`, and `enterprise-background`.
- These are broadly shadcn/Radix-style primitives used by service pages,
  contact, portfolio, companies, career, and blog components.

### Marketing, Services, Portfolio, And Resume

- `components/animated-cta.tsx`, `components/service-card.tsx`,
  `components/product-card.tsx`, `components/project-card.tsx`,
  `components/project-filters.tsx`, `components/company-card.tsx`.
- Portfolio-specific: `components/portfolio/portfolio-content.tsx`,
  `components/portfolio/case-study-share.tsx`.
- Resume-specific: `components/resume/resume-page-client.tsx`,
  `resume-timeline`, `resume-skills`, `resume-education`,
  `resume-certifications`, and `formatted-description`.
- Backgrounds: `components/backgrounds/lazy.tsx` plus animated, fluid particle,
  light animation, and interactive drawing backgrounds.

### Blog And Newsletter

- `components/blog-subscribe.tsx` is reused by blog and service pages.
- Blog feature components include `blog-listing`, `blog-post-card`,
  `blog-post-content`, `author-bio`, `consulting-cta`, `reading-progress`,
  `table-of-contents`, `related-content`, `related-posts-carousel`,
  `tag-posts-grid`, `blog-faq-accordion`, `mermaid-diagram`,
  `giscus-comments`, and `ask-about-post-chatbot`.

### Career, Contact, Booking, And Drone

- Career: `components/career/checklist-item.tsx`,
  `components/career/copy-button.tsx`, `components/career/status-legend.tsx`.
- Contact: `components/contact-form.tsx`.
- Booking: `components/cal-inline-embed.tsx`.
- Drone/aerial: `components/property-card.tsx`,
  `components/property-carousel.tsx`, plus `lib/aerial-properties.ts`.

### Sanity Studio Components

Located under `sanity/components/`:

- Top-level Studio tools/views: `DashboardTool`, `ChecklistTool`,
  `PublicationScheduleTool`, `ContentCalendarTool`, `BulkStatusTool`,
  `BlogEditorView`, `BlogPreviewView`, `JobApplicationView`.
- Blog editor subcomponents:
  - AI: `AIReviewButton`, `AskAIPanel`, `CategorySuggestions`,
    `ExcerptComparison`, `InternalLinkSuggestions`, `KeywordAnalysis`,
    `PlatformSuggestions`, `PostAnalytics`, `SERPPreview`,
    `SuggestionChecklist`, `TagSuggestions`.
  - Editor: `BodyDiffView`, `EditorToolbar`, `FileUploadButton`,
    `FormattingHelp`, `ImageInsertButton`, `MarkdownImportButton`,
    `SectionActionBar`, `TagInputWithAutocomplete`.
  - Metadata: `CategoryPicker`, `InlineExcerptEditor`,
    `InlineReviewNotesEditor`, `InlineTitleEditor`.
  - Shared config/helpers: `blog-shared`, `checklist-config`,
    `editorial-status-config`, `format-utils`, `markdown-marks`,
    `tokens`, `types`, `utils`.

## mdostal/life Components

Source commit: `cd777c0f217499b688aabdaaff3fc312d9f40adf`.

### Shared Application Shell

- `src/components/nav.tsx` is the global navigation.
- `src/components/posthog-provider.tsx` initializes PostHog and captures
  friendly page view metadata.
- `src/lib/og-defaults.ts` centralizes OpenGraph/Twitter defaults.

### Public Site Components

- Writing: `src/components/featured-carousel.tsx`,
  `src/components/writing-tabs.tsx`, `src/components/poem-modal.tsx`,
  `src/components/poetry-subscribe-form.tsx`.
- Gallery: `src/components/gallery/photo-grid.tsx`,
  `src/components/gallery/tag-filter.tsx`,
  `src/components/gallery/lightbox/lightbox.tsx`,
  `lightbox-caption.tsx`, and `types.ts`.
- Reels: `src/components/reels/poster-grid.tsx`,
  `src/components/reels/video-lightbox.tsx`.
- Songs: `src/components/songs/song-grid.tsx`,
  `src/components/songs/song-lightbox.tsx`.

### Sanity Studio Components

Located under `src/sanity/components/`:

- `DashboardTool`, `CarouselTool`, `PoemScheduleTool`,
  `SubmissionTrackerTool`, `CompareView`, `PreviewView`,
  `LocalImagePreview`.

## Shared Vs Site-Specific

- No code-level shared package exists between the two repos.
- Both sites independently implement:
  - PostHog client providers.
  - Sanity clients/query layers.
  - Embedded Sanity Studio components.
  - Newsletter email templates and Resend endpoints.
- `personal-site` owns broad professional/portfolio/career/blog surfaces and a
  much larger Studio/editor toolset.
- `life` owns writing/gallery/reels/songs surfaces and a smaller Studio focused
  on poems, media, carousel generation, scheduling, and submissions.
