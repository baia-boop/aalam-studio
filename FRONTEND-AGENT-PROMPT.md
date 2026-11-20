# Agent Prompt: Build the AALAM frontend from scratch against the existing backend

You are being given a **capability test**: build a complete, production-quality
frontend for a real product with **no product direction, no design direction,
no color palette, and no design system provided**. Every product decision,
every UX decision and every design decision is yours to make. The quality of
your own judgment is what is being evaluated. Make the decisions yourself,
defend them with reasoning, and build something you would be proud to ship.

## Context

**AALAM (watch.aalam)** is a movies & series discovery and streaming-guide web
app. Users discover trending and regional titles, browse catalogues, search,
open title pages, watch content through third-party stream providers, manage a
personal library, and (optionally) sign in for cloud sync and a premium
debrid subscription. An admin exists for operational oversight.

The **backend already exists and is fixed**. It is a Next.js server package
containing all server logic and the API route handlers. You are **only**
building the frontend, from scratch, that consumes these APIs. **Do not
modify, extend or re-implement the backend.** Treat the API contract below as
immutable.

Your job: design and build the **complete frontend experience** — the entire
information architecture, visual language, component architecture, and all
user flows — from nothing, guided only by the product context and the API
contract. Nothing about *how* the product should look or feel is specified
below. You decide that.

## Tech stack (technical constraints — these are not design decisions)

- **Next.js 15 (App Router)** — same framework as the backend so the two can
  be deployed side by side or as one app later.
- **React 19** with **TypeScript** in strict mode.
- **Tailwind CSS** for styling.
- No new runtime dependencies without a clear, written justification. Keep the
  dependency surface minimal and purposeful.

## Backend API contract (fixed — consume it, do not change it)

All endpoints are on the same origin. Auth is **cookie-based** (backend-managed
sessions); never build your own auth or token handling in the frontend.

| Endpoint | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/api/search?q=&type=all\|movie\|tv&page=&ignore=&genre=&year=&rating=&sort=&person=&collection=` | GET | public | Hybrid search: natural-language queries ("90s korean thrillers"), title ranking, typo correction, full-set genre/year/rating/sort filters, person/collection-scoped results |
| `/api/search/suggest?q=&type=&limit=` | GET | public | As-you-type title suggestions (cached) |
| `/api/feeds/[feed]` | GET | public | Home rails: `home-editorial`, `home-full` (incl. curated collection stacks), `home-below`, `anime-below` (ISR-cached, anonymous, identical for all visitors) |
| `/api/discovery/providers?region=` | GET | public | Regional streaming-service list for a market |
| `/api/discovery/market?region=` | GET | public | Regional market feed (may be `partial`) |
| `/api/discovery/service?region=&provider=&type=movie\|tv&page=&sort=` | GET | public | Catalog of one provider in a region |
| `/api/discovery/origin?region=&type=&page=&sort=&genre=` | GET | public | Regional catalogue (movies/TV) with genre + sort |
| `/api/tmdb/status` | GET | public | `{ hasServerKey }` — whether the server TMDB proxy is configured |
| `/api/tmdb/status/[...path]` | GET | public | Read-only, allow-listed TMDB catalogue proxy (use it when no client TMDB key is set) |
| `/api/geo` | GET | public | Coarse visitor country (ISO code) from a trusted CDN header — the only geo source you may use |
| `/api/playback/grants` | GET | public | Which titles/episodes the deployment is authorized to play |
| `/api/interactions` | POST / GET / DELETE | required | Taste telemetry: `POST { events: [{ tmdbId, mediaType, type, progress?, position?, source? }] }`; `GET → { total, lastAt }`; `DELETE` wipes the caller's history |
| `/api/recommendations` | GET / POST | optional | CineMatch recommendations; guests get the cold-start feed, signed-in users get history-based results; `POST` may carry local taste state |
| `/api/streams/torrentio?type=&imdb=&s=&e=` | GET | required (premium) | Stream discovery for a title/episode; requires an active debrid subscription |
| `/api/streams/detect` | POST | public | Probe which embed/stream sources actually work for a title/episode |
| `/api/debrid/access` | GET | required | Current user's premium entitlement `{ status, expiresAt }` |
| `/api/debrid/realdebrid/resolve` | POST | required | Resolve a stream/magnet link through Real-Debrid |
| `/api/admin/login` / `/api/admin/logout` | POST | public | Admin session; **same-origin enforced by the backend** |
| `/api/health` | GET | public | Liveness/readiness; admin cookie unlocks cache/upstream/engine metrics |
| `/api/rum` | POST | public | Web Vitals / route-error beacon collector |
| `/api/csp-report` | POST | public | CSP violation collector (browser-sent) |
| `/sitemap.xml`, `/sitemaps/[kind]/[shard]`, `/sitemap-static.xml` | GET | public | SEO sitemaps |

## The core instruction: you make every decision

**Nobody will tell you what to build or how it should look.** You decide, and
you own the consequences:

- **Product scope and IA**: which pages and flows the app has, how they are
  structured and prioritized, what the primary path is and what is secondary.
  Cover the full app surface implied by the API above (discovery/home, browsing
  catalogues, search, title detail, watch/playback, accounts & profile, personal
  library, premium/debrid, admin) — but the shape of it is yours to design.
- **Visual design**: the entire design language — color system, typography,
  spacing, radius, shadows, motion, dark/light treatment, imagery treatment.
  This is a movie & series product; design something that genuinely fits the
  medium and feels premium. Do not default to a generic template look — show
  judgment.
- **UX and interaction patterns**: navigation model, filtering, search UX,
  rails/carousels, cards, states, empty/error/loading design, onboarding,
  personalization surfacing, playback UX.
- **Architecture**: component structure, data-fetching strategy (server vs
  client components, caching, revalidation), state management, TypeScript types.
- **Quality bar**: set and meet a high one. This is being evaluated on the
  *maximum* capability you can produce, not the minimum that works.

Where you make a significant decision, keep a short written rationale (see
Deliverables) — this shows your reasoning, which is part of the evaluation.

## Requirements and quality bar

- **Completeness**: the delivered app must actually run end-to-end against the
  backend. No placeholder screens, no stubbed flows. Every API above that maps
  to a user-facing capability should be exercised by the UI somewhere.
- **Responsive, mobile-first**: must work from ~375 px to wide desktop. Touch
  targets, gesture-friendly rails, no desktop-only assumptions.
- **Accessibility**: keyboard navigation, focus management, semantic markup,
  ARIA where needed, reduced-motion support. Screen-reader and keyboard users
  must be able to complete core flows.
- **Performance**: budget-conscious — lazy-load images with proper sizing,
  minimize client JS, use server components where possible, avoid layout shift,
  respect caching headers the backend sets.
- **Resilience**: every data surface handles loading, error, empty, and
  degraded states. The app must degrade gracefully when things fail.
- **Security-aware**: never send a visitor IP anywhere yourself (use
  `/api/geo`); respect same-origin for admin forms; keep secrets out of the
  client bundle; wire real CSP reporting if you implement CSP-relevant
  behavior.
- **Telemetry**: report Web Vitals / route errors to `/api/rum`; report CSP
  violations to `/api/csp-report`.
- **Code quality**: strict TypeScript, ESLint clean, meaningful unit tests for
  non-trivial logic, a README with run instructions and an architecture note.

## Hard rules

1. **Do not modify or extend the backend.** If an endpoint seems missing or
   insufficient for something you want to do, adapt your client-side design or
   document the gap — do not hack around it in a way that assumes backend
   changes.
2. **Do not implement auth yourself** — sessions are cookie-based and handled
   by the backend. The frontend consumes session state, it does not manage
   credentials.
3. **Do not introduce design constraints from outside this prompt** — there is
   no provided palette, no provided mockup, no provided design system. If you
   want one, you build it.
4. Do not pad the deliverable with unused code, unused dependencies or
   decorative complexity.

## Deliverables

1. A complete, runnable Next.js frontend app.
2. `README.md`: what was built, how to run it, how to point it at the backend.
3. A short **`DESIGN-DECISIONS.md`** (or a section in the README): the key
   product and design decisions you made and why — the rationale that shows
   your judgment.
4. Lint, typecheck and tests passing.
5. A final self-review: walk through the app yourself, find and fix the rough
   edges before you declare it done.

## How to work

Plan first (briefly state your approach), then build, then verify, then polish.
Work autonomously end to end. If you hit a genuine ambiguity in the API
contract, make a sensible decision and document it rather than stalling.

**Goal: produce the strongest frontend you can — full decisions, full
ownership, full quality.**
