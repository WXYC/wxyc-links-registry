# wxyc-links-registry

Cloudflare Worker serving the wxyc.org universal-link surface: the `applinks` AASA at the exact `/.well-known/apple-app-site-association` path, and the `/shows/<id>` OG share pages for On Tour concerts (backed by Backend-Service's public `GET /concerts/:id`). Bootstrapped for [#1](https://github.com/WXYC/wxyc-links-registry/issues/1) under the [On Tour sharing epic (wxyc-ios-64#535)](https://github.com/WXYC/wxyc-ios-64/issues/535). The design doc and per-surface mockups live in the iOS repo (`docs/ideas/on-tour-sharing.md`, `docs/ideas/on-tour-share-cards.html`) — read them before changing what the pages say or how the cards look.

## Tech stack

TypeScript Cloudflare Worker; wrangler as a devDependency (never assume a global or authenticated wrangler). Tests are Vitest 4 + `@cloudflare/vitest-pool-workers` — the suite runs the real Worker inside workerd via the `cloudflareTest()` Vite plugin, `import { exports } from "cloudflare:workers"`, and `exports.default.fetch()`. No credentials, no network, no secrets needed to build or test.

## Layout

```
src/
  index.ts        # Router: method gate, AASA exact path, /shows/* dispatch, top-level catch
  aasa.ts         # The association body (verbatim from #1) + response builder
  upstream.ts     # GET /concerts/:id with caches.default edge caching; failures as values
  concert.ts      # Concert wire model + lenient decoder (iOS-style: required floor, rest degrades)
  render.ts       # Share/not-found/error page templates; head tags; inline analytics snippet
  format.ts       # escapeHtml, safeHttpUrl, NY-local dates/times, prices, og:description
  poster.ts       # PosterGradient port (FNV-1a 64 + the 7-pair palette)
  og-card.ts      # Serves the embedded static OG card at /shows/og-card.png
  og-card-data.ts # GENERATED base64 of assets/og-card.png — do not hand-edit
test/             # aasa, shows (integration via workerd), format, poster (unit)
scripts/          # OG-card generator (Swift/CoreGraphics, macOS) + base64 embedder
```

## Conventions

- **Route exactness is a safety property.** The AASA route must remain the exact path; NEVER introduce a `/.well-known/*` wildcard anywhere (routes, tests, docs) — GitHub Pages' ACME cert renewals transit `/.well-known/acme-challenge/*` and must pass through to the origin. The Worker owns exactly two production route patterns; resist adding more without an org decision.
- **A bare `wrangler deploy` must stay harmless.** Production routes live only under `[env.production]` in wrangler.toml; the top-level environment is workers.dev-only. Keep it that way — the staged deploy (soak on workers.dev, explicit `--env production` after the apex-cutover soak, WXYC/website#209) depends on it. Never deploy or attach routes from CI or from a coding session without being asked.
- **Escape at the data boundary.** Every upstream string goes through `escapeHtml` exactly once and every upstream URL through `safeHttpUrl` (absolute http/https or dropped). Static copy is authored raw. When a label mixes copy and data, escape the data at construction and mark the field `...Html` (see `ticketCta`).
- **Mirror the iOS app, don't invent.** CTA precedence is the app's `ctaURL` (`event_url ?? ticket_url`); CTA wording follows `BoxOfficeTicketPresenter`; the gradient must stay bit-identical to `PosterGradient.swift` (palette order is load-bearing; parity vectors in `test/poster.test.ts` were generated from the Swift implementation — regenerate them from Swift if the app's algorithm ever changes, never by running the TS port on itself).
- **Failures are values.** `fetchConcert` returns `ok | not_found | upstream_error`; the router maps them to 200/404/502 pages. The 502 page interpolates nothing so the top-level catch can always render it. Never let a raw exception escape the Worker.
- **Cache headers are contract.** Upstream 200s are cached via `caches.default` honoring the API's `max-age=300`; page responses carry `public, max-age=300` / `public, max-age=60` (404) / `no-store` (5xx). Tests pin these — update tests and README together if they change.
- **Analytics are env-gated and inline.** No external scripts on the share pages, ever — unfurl bots don't run JS and humans shouldn't wait for it. The PostHog snippet ships only when `POSTHOG_PROJECT_KEY` is set (per-environment vars/secrets, never hardcoded in this public repo). Event names `share_page_viewed` / `share_page_cta_tapped` are the App Clip gate's instrumentation — coordinate before renaming.
- **Tests mock upstream by spying on `globalThis.fetch`** (the Worker shares the test isolate); the guard throws on unprimed requests so nothing can silently hit the network. Each integration test uses a fresh concert id — `caches.default` is shared within a test file, and id reuse leaks one test's fixture into the next.
- **Fixtures use WXYC-canonical artists** (Jessica Pratt, Julie Byrne, real Triangle venues), per the org's example-data rule. No "Test Artist".
- **The OG card is a brand asset, not generated here.** `assets/og-card.png` is a 1200x640 export from the station's design library; `src/og-card-data.ts` is generated from it by `scripts/embed-og-card.mjs`. Hand-edit neither — replace the asset, rerun the script. The per-show OG image (mockup variant B) is ticket #2 — don't build image generation into this Worker ad hoc.
- **The page palette comes from the app icon.** The CSS custom properties in `src/render.ts` (`--rose`/`--salmon`/`--pink`/`--peri-light`/`--peri`) are the app-icon gradient stops verbatim; deep tones are darkened periwinkle. Don't introduce new hues — semantic states (live green, cancelled red) are the only colors outside the sunset family. The per-show poster fallback gradients are a different thing entirely: they're the iOS app's `PosterGradient` ported bit-for-bit and pinned by Swift-generated parity vectors — never restyle those.

## Related

- Org-level overview: `/Users/jake/Developer/WXYC/CLAUDE.md`
- Backend-Service serves `GET /concerts/:id` (public, windowless, `Cache-Control: public, max-age=300`); contract in `wxyc-shared/api.yaml` (`Concert`, `ConcertStatus`)
- dj-site's `app/.well-known/apple-app-site-association/route.ts` is the in-org AASA-serving precedent (`webcredentials`, its own host)
- iOS consumers: `Shared/Concerts` (model, `PosterGradient`, `BoxOfficeTicketPresenter`), `WXYCDeepLink` (universal-link receiver, epic #535)
