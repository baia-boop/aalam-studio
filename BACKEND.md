# watch.aalam — Backend

Server-side code extracted from the watch.aalam monorepo. This package contains
everything the API needs to run; the frontend (pages, components, hooks) is
deliberately excluded so it can be rebuilt from scratch against these APIs.

## Contents

| Path | What it is |
| --- | --- |
| `src/app/api/**` | Next.js route handlers — the public API surface |
| `src/server/**` | Server-side logic: auth, cache (LRU/Redis), Cinematch, debrid, discovery, playback grants, search, rate limiting, SEO/sitemaps, TMDB gateway |
| `src/middleware.ts` | Edge middleware: security headers/CSP, geo, rate-limit, origin checks |
| `src/lib/**` | Shared utilities the server imports (TMDB client, catalogue helpers, security, SEO helpers) — only the backend-needed subset |
| `src/data/curated-lists.ts` | Pure data file used by backend curation/Cinematch |
| `src/types/media.ts` | Shared media types |
| `supabase/migrations/**` | Database migrations (product, sharing, Cinematch, debrid subscriptions) |
| root config | `package.json`, `tsconfig.json`, `next.config.mjs`, `next-env.d.ts`, `.env.example`, `.gitignore` |

## Run

```bash
npm install
cp .env.example .env   # fill required vars (TMDB, Supabase, Real-Debrid, admin hash, ...)
npm run build && npm start   # or: npm run dev
```

The API surface is the contract for the frontend: `/api/search`,
`/api/feeds/[feed]`, `/api/discovery/[feed]`, `/api/tmdb/**`, `/api/streams/**`,
`/api/playback/grants`, `/api/debrid/**`, `/api/interactions`, `/api/recommendations`,
`/api/health`, admin auth routes, sitemap routes and more.
