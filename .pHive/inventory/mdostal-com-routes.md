# mdostal.com Route Inventory

Audit for PAN-6555. Source repo: `mdostal/personal-site` on `main` at
`9d24085f87161f2085f12d7fef785ad6b25ff7aa`.

## Framework Shape

- Next.js App Router rooted at `app/`.
- Embedded Sanity Studio at `/studio`.
- Static metadata routes are implemented with App Router route handlers:
  `/robots.txt`, `/sitemap.xml`, `/rss.xml`, `/feed.xml`, `/atom.xml`,
  `/feed.json`, and `/llms.txt`.
- Global providers/layout live in `app/layout.tsx`, with navigation, footer,
  PostHog, Vercel Speed Insights filtering, Meta Pixel, and structured data.
- Career routes are protected by `middleware.ts`; unauthenticated users under
  `/career` redirect to `/career/sign-in`.

## Public Pages

| Route | File | Notes |
| --- | --- | --- |
| `/` | `app/page.tsx` | Primary personal brand home page. |
| `/about` | `app/about/page.tsx` | Personal/about content. |
| `/blog` | `app/blog/page.tsx` | Sanity-backed blog listing. |
| `/blog/[slug]` | `app/blog/[slug]/page.tsx` | Sanity-backed blog detail with preview support. |
| `/blog/tags/[tag]` | `app/blog/tags/[tag]/page.tsx` | Tag-filtered blog listing. |
| `/portfolio` | `app/portfolio/page.tsx` | Portfolio/case study listing from local content. |
| `/portfolio/[slug]` | `app/portfolio/[slug]/page.tsx` | Case study detail. |
| `/products` | `app/products/page.tsx` | Product cards and offerings. |
| `/companies` | `app/companies/page.tsx` | Company/resume wall, Sanity with fallback mapping. |
| `/resume` | `app/resume/page.tsx` | Resume timeline, Sanity with local fallback. |
| `/contact` | `app/contact/page.tsx` | Contact form plus social links. |
| `/book` | `app/book/page.tsx` | Cal.com booking embed. |
| `/book/clients` | `app/book/clients/page.tsx` | Client-specific Cal.com booking page. |
| `/book/internal` | `app/book/internal/page.tsx` | Internal Cal.com booking page. |
| `/fractional-cto` | `app/fractional-cto/page.tsx` | Fractional CTO service landing page. |
| `/enterprise` | `app/enterprise/page.tsx` | Enterprise services entry. |
| `/enterprise/architecture` | `app/enterprise/architecture/page.tsx` | Architecture consulting page. |
| `/enterprise/audit` | `app/enterprise/audit/page.tsx` | Audit consulting page. |
| `/enterprise/consultant` | `app/enterprise/consultant/page.tsx` | Consultant positioning page. |
| `/smb` | `app/smb/page.tsx` | SMB services entry. |
| `/smb/checkup` | `app/smb/checkup/page.tsx` | SMB checkup page. |
| `/tech-checkup` | `app/tech-checkup/page.tsx` | Technical checkup landing page. |
| `/tools/roi-estimator` | `app/tools/roi-estimator/page.tsx` | Client-side ROI estimator. |
| `/drone` | `app/drone/page.tsx` | Drone/aerial services page. |
| `/drone-locked` | `app/drone-locked/page.tsx` | Locked drone access state. |
| `/materials/one-pager-fcto` | `app/materials/one-pager-fcto/page.tsx` | Public-but-unlisted one-pager collateral. |
| `/newsletter-preview` | `app/newsletter-preview/page.tsx` | Newsletter preview/send-test helper. |

## Auth-Gated Career Pages

| Route | File | Notes |
| --- | --- | --- |
| `/career` | `app/career/page.tsx` | Career dashboard from Sanity data. |
| `/career/sign-in` | `app/career/sign-in/page.tsx` | NextAuth sign-in. |
| `/career/assistant` | `app/career/assistant/page.tsx` | Career assistant surface. |
| `/career/checklist` | `app/career/checklist/page.tsx` | Career checklist grouped by section. |
| `/career/jobs` | `app/career/jobs/page.tsx` | Job application list. |
| `/career/jobs/[slug]` | `app/career/jobs/[slug]/page.tsx` | Job application detail. |
| `/career/strategy` | `app/career/strategy/page.tsx` | Strategy docs list. |
| `/career/strategy/[slug]` | `app/career/strategy/[slug]/page.tsx` | Strategy doc detail. |
| `/career/templates` | `app/career/templates/page.tsx` | Message templates. |
| `/career/toptal` | `app/career/toptal/page.tsx` | Toptal prep resources. |

## Studio And Operational Routes

| Route | File | Notes |
| --- | --- | --- |
| `/studio/[[...tool]]` | `app/studio/[[...tool]]/page.tsx` | Embedded Sanity Studio. |
| `/api/health` | `app/api/health/route.ts` | Health checks for Resend, Sanity, PostHog, and RSS. |
| `/api/contact` | `app/api/contact/route.ts` | Contact form email flow. |
| `/api/subscribe` | `app/api/subscribe/route.ts` | Newsletter subscription. |
| `/api/newsletter/*` | `app/api/newsletter/*/route.ts` | Broadcast, preview, test send, Sanity webhook, Resend webhook, poetry broadcast. |
| `/api/webhooks/cal-com` | `app/api/webhooks/cal-com/route.ts` | Cal.com webhook. |
| `/api/auth/[...nextauth]` | `app/api/auth/[...nextauth]/route.ts` | NextAuth handlers. |
| `/api/preview`, `/api/exit-preview`, `/api/draft-mode/enable`, `/api/revalidate` | App route handlers | Preview and cache invalidation. |
| `/api/ai-review`, `/api/ai-section-edit`, `/api/blog-chat`, `/api/editorial-chat`, `/api/career-chat`, `/api/career-generate`, `/api/ai-linkedin-draft`, `/api/generate-cover-image` | App route handlers | AI-assisted content/career/editorial features. |
| `/api/parse-upload`, `/api/parse-pdf-enhanced` | App route handlers | Upload parsing for Studio/career workflows. |
| `/api/cross-post/devto`, `/api/cross-post/hashnode`, `/api/cross-post-scheduler`, `/api/scheduled-publish` | App route handlers | Blog syndication and scheduling. |
| `/api/linear-webhook`, `/api/monitoring/alert`, `/api/analytics/[slug]`, `/api/drone-gate`, `/api/og` | App route handlers | Integrations, monitoring, gated drone access, OG images. |

## Redirects And Rewrites

- `next.config.js` rewrites PostHog paths (`/static/*`, `/decide`, `/e/*`) to
  PostHog hosts, likely to reduce blocker impact.
- `next.config.js` redirects `/services`, `/consulting`, and
  `/services/fractional-cto` to `/fractional-cto`, and `/clients` to
  `/book/clients`.
- CSP allows Cal.com frames/scripts, PostHog, Sanity CDN/API hosts, YouTube,
  Vimeo, Giscus, Facebook/Meta Pixel, and Vercel live scripts.
