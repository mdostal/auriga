# life.mdostal.com Route Inventory

Audit for PAN-6555. Source repo: `mdostal/life` on `main` at
`cd777c0f217499b688aabdaaff3fc312d9f40adf`.

## Framework Shape

- Next.js App Router rooted at `src/app/`.
- Embedded Sanity Studio at `/studio`.
- Global layout uses `Nav`, `PostHogProvider`, Google fonts, default OpenGraph
  metadata, and Vercel Speed Insights.
- Sanity content is queried from `src/sanity/queries.ts` and
  `src/sanity/client.ts`; older/simple client helpers also exist in
  `src/lib/sanity.ts`.

## Public Pages

| Route | File | Notes |
| --- | --- | --- |
| `/` | `src/app/page.tsx` | Life-site home page. |
| `/about` | `src/app/about/page.tsx` | Personal/life about page. |
| `/journey` | `src/app/journey/page.tsx` | Timeline/journey page. |
| `/writing` | `src/app/writing/page.tsx` | Main writing page with featured carousel, poems, collections, and prose. |
| `/writing/originals` | `src/app/writing/originals/page.tsx` | Originals-focused writing page. |
| `/writing/workshop` | `src/app/writing/workshop/page.tsx` | Workshop/editing surface for writing review. |
| `/gallery` | `src/app/gallery/page.tsx` | Gallery page with Sanity-backed photos and local fallback data. |
| `/reels` | `src/app/reels/page.tsx` | Sanity-backed reel/video listing. |
| `/songs` | `src/app/songs/page.tsx` | Sanity-backed songs listing. |

## Studio And Operational Routes

| Route | File | Notes |
| --- | --- | --- |
| `/studio/[[...tool]]` | `src/app/studio/[[...tool]]/page.tsx` | Embedded Sanity Studio. |
| `/rss.xml` | `src/app/rss.xml/route.ts` | RSS feed for published poems. |
| `/robots.txt` | `src/app/robots.ts` | Robots metadata. |
| `/sitemap.xml` | `src/app/sitemap.ts` | Sitemap metadata. |
| `/api/health` | `src/app/api/health/route.ts` | Health checks for Resend and Sanity. |
| `/api/subscribe` | `src/app/api/subscribe/route.ts` | Poetry newsletter subscription. |
| `/api/unsubscribe` | `src/app/api/unsubscribe/route.ts` | Signed unsubscribe flow. |
| `/api/newsletter/broadcast` | `src/app/api/newsletter/broadcast/route.ts` | Poetry newsletter broadcast. |
| `/api/ai-review` | `src/app/api/ai-review/route.ts` | Gemini-backed poem review. |
| `/api/editorial-chat` | `src/app/api/editorial-chat/route.ts` | Gemini-backed editorial chat. |
| `/api/poems/evaluate-submission` | `src/app/api/poems/evaluate-submission/route.ts` | Authenticated Gemini/Sanity submission evaluation. |
| `/api/workshop` | `src/app/api/workshop/route.ts` | Workshop API guarded by bearer token. |
| `/api/carousel/generate` | `src/app/api/carousel/generate/route.ts` | Generate carousel slide plan and write Sanity metadata. |
| `/api/carousel/batch` | `src/app/api/carousel/batch/route.ts` | Batch carousel plan/write endpoint. |
| `/api/carousel/slide` | `src/app/api/carousel/slide/route.tsx` | Public image renderer for carousel slides. |

## Content Flow Notes

- `/writing` uses Sanity queries for featured poems, collections, prose, all
  poems, and recent carousel posts.
- `/gallery` first loads Sanity `galleryPhoto` documents and falls back to a
  large local static photo list when Sanity returns no visible photos.
- `/reels` and `/songs` are Sanity-first listing pages.
- The Studio is configured separately from `mdostal.com` but can share the same
  Sanity project ID while using the default `production-life` dataset.
