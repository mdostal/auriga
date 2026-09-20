# Integration Inventory

Audit for PAN-6555. Source repos:

- `mdostal/personal-site` at `9d24085f87161f2085f12d7fef785ad6b25ff7aa`.
- `mdostal/life` at `cd777c0f217499b688aabdaaff3fc312d9f40adf`.

## mdostal/personal-site

### Sanity

- Dependencies: `@sanity/client`, `next-sanity`, `sanity`, `@sanity/vision`,
  `@sanity/code-input`, `sanity-plugin-media`,
  `sanity-plugin-simpler-color-input`, `@sanity/image-url`.
- Config: `sanity.config.ts`, `sanity.cli.ts`, `lib/sanity.ts`.
- Public env: `NEXT_PUBLIC_SANITY_PROJECT_ID`, `NEXT_PUBLIC_SANITY_DATASET`.
- Server env: `SANITY_API_TOKEN`, `SANITY_REVALIDATE_SECRET`, preview/studio
  secrets.
- Uses:
  - Blog/content reads in routes and feeds.
  - Preview/draft mode.
  - Newsletter dedup stamping.
  - Career data writes.
  - Cross-post metadata writes.
  - Embedded Studio tools and document actions.

### Cal.com

- UI component: `components/cal-inline-embed.tsx`.
- Pages: `/book`, `/book/clients`, `/book/internal`.
- Webhook endpoint: `app/api/webhooks/cal-com/route.ts`.
- CSP allows `app.cal.com` and `cal.com` script/frame/connect sources.
- Redirect from `/clients` to `/book/clients`.

### PostHog

- Dependencies: `posthog-js`, `posthog-node`.
- Client provider: `components/posthog-provider.tsx`, mounted through
  `components/providers.tsx`.
- Server helper: `lib/posthog-server.ts`.
- Proxy rewrites in `next.config.js` route `/static/*`, `/decide`, and `/e/*`
  to PostHog hosts.
- Used by contact, subscribe, revalidate, scheduled publish, newsletter, Cal.com
  webhook, AI routes, cross-post routes, health checks, and Studio analytics.
- Env: `NEXT_PUBLIC_POSTHOG_KEY`,
  `NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com'`.

### Resend

- Dependency: `resend`.
- Email templates: `lib/email-templates.ts`.
- Contact flow: `app/api/contact/route.ts`.
- Newsletter flow:
  - `/api/subscribe`
  - `/api/newsletter/broadcast`
  - `/api/newsletter/poetry-broadcast`
  - `/api/newsletter/preview`
  - `/api/newsletter/send-test`
  - `/api/newsletter/webhook`
  - `/api/newsletter/resend-webhook`
- Health alert flow: `lib/health-alert.ts`,
  `app/api/monitoring/alert/route.ts`.
- Linear notification flow: `app/api/linear-webhook/route.ts`.
- Env: `RESEND_API_KEY`, `RESEND_AUDIENCE_ID`,
  `RESEND_WEBHOOK_SECRET`.

### Google And Auth

- NextAuth v5 with Google provider in `lib/auth.ts`.
- Auth route: `app/api/auth/[...nextauth]/route.ts`.
- Middleware protects `/career/*`.
- Env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- Gemini provider through `@ai-sdk/google` in `lib/ai-provider.ts` and direct
  use in cover-image generation.
- Env: `GOOGLE_GENERATIVE_AI_API_KEY`.
- Google fonts are used through Next font.

### AI Providers And Studio AI

- Dependencies: `ai`, `@ai-sdk/google`, `@ai-sdk/anthropic`.
- Provider abstraction: `lib/ai-provider.ts`, defaulting to Gemini and optionally
  using Anthropic when configured.
- Server actions: `app/actions/studio-ai.ts`.
- API routes: AI review, section edit, blog chat, editorial chat, career chat,
  career generation, LinkedIn draft, cover image generation, PDF/upload parsing.
- Studio components call the server actions for blog review/editing, analytics,
  file parsing, cross-post actions, and cover image generation.

### Other Integrations

- Dev.to and Hashnode cross-post endpoints and Studio document actions.
- Medium cross-post helper opens Medium import with a canonical URL.
- Linear webhook sends queue notifications.
- Giscus comments are mounted in blog post content.
- Meta Pixel is mounted through `components/meta-pixel.tsx`.
- Vercel Speed Insights is mounted through
  `components/filtered-speed-insights.tsx`.
- Upstash Redis/ratelimit protects API routes.

## mdostal/life

### Sanity

- Dependencies: `@sanity/client`, `next-sanity`, `sanity`, `@sanity/vision`,
  `sanity-plugin-media`, `@sanity/orderable-document-list`.
- Config: `sanity.config.ts`, `sanity.cli.ts`, `src/sanity/config.ts`,
  `src/sanity/client.ts`, `src/sanity/queries.ts`.
- Public env: `NEXT_PUBLIC_SANITY_PROJECT_ID`,
  `NEXT_PUBLIC_SANITY_DATASET || 'production-life'`.
- Server env: `SANITY_API_TOKEN` for write endpoints and Studio helpers.
- Uses:
  - Poem, collection, prose, gallery, reel, song reads.
  - Carousel generation/batch writes.
  - Poem submission evaluation writes.
  - Embedded Studio tools.

### PostHog

- Dependency: `posthog-js`.
- Provider: `src/components/posthog-provider.tsx`, mounted in
  `src/app/layout.tsx`.
- The current provider hardcodes the public PostHog key in source and captures
  friendly page metadata on route changes.

### Resend

- Dependency: `resend`.
- Email templates: `src/lib/email-templates.ts`.
- Endpoints:
  - `/api/subscribe`
  - `/api/unsubscribe`
  - `/api/newsletter/broadcast`
  - `/api/health`
- Env: `RESEND_API_KEY`, `RESEND_AUDIENCE_ID`.
- Unsubscribe tokens are implemented in `src/lib/unsubscribe.ts`.

### Google And AI

- Dependency: `@ai-sdk/google`.
- Gemini is used by:
  - `src/app/api/ai-review/route.ts`
  - `src/app/api/editorial-chat/route.ts`
  - `src/app/api/poems/evaluate-submission/route.ts`
- Env: `GOOGLE_GENERATIVE_AI_API_KEY`.
- Google fonts are used through Next font.

### Other Integrations

- Upstash Redis/ratelimit protects API routes.
- Carousel routes render or write social slide assets.
- Vercel Speed Insights is mounted in the root layout.

## Integration Gaps To Track Later

- Cal.com appears only in `personal-site`.
- NextAuth/Google OAuth appears only in `personal-site`.
- PostHog key handling differs: `personal-site` uses env-driven config, while
  `life` currently hardcodes the public key in the client provider.
- Both sites duplicate Sanity, Resend, rate-limit, logger, and newsletter helper
  concepts without a shared package.
