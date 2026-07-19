# wxyc-links-registry

The universal-link surface for [wxyc.org](https://wxyc.org): a Cloudflare Worker that serves the Apple App Site Association file and the `/shows/<id>` share pages for the WXYC app's On Tour feature. When someone shares a Triangle show from the app, this Worker is what the recipient's link unfurler reads and what a no-app tap lands on — an OG-tagged page with the show's facts, a ticket link, a live player for 89.3 FM, and a pointer to the app.

Bootstrapped by [#1](https://github.com/WXYC/wxyc-links-registry/issues/1); part of the [On Tour sharing](https://github.com/WXYC/wxyc-ios-64/issues/535) epic. Design doc and mockups live in the iOS repo: [`docs/ideas/on-tour-sharing.md`](https://github.com/WXYC/wxyc-ios-64/blob/master/docs/ideas/on-tour-sharing.md), [`docs/ideas/on-tour-share-cards.html`](https://github.com/WXYC/wxyc-ios-64/blob/master/docs/ideas/on-tour-share-cards.html).

## The two routes

This Worker owns exactly two route patterns on the apex — nothing else on wxyc.org is its business (everything else passes through to the GitHub Pages origin):

| Route | Serves |
|---|---|
| `wxyc.org/.well-known/apple-app-site-association` (exact path) | The `applinks` AASA registering `/shows/*` for the WXYC app (`92V374HC38.org.wxyc.iphoneapp`). HTTP 200, `Content-Type: application/json`, no redirect, cacheable for an hour. |
| `wxyc.org/shows/*` | The share pages. `/shows/<id>` renders a concert from Backend-Service's public `GET /concerts/:id`; slugged (`/shows/4821-jessica-pratt`), trailing-slash, and zero-padded forms 301 to the bare canonical id. `/shows/og-card.png` serves the static 1200x640 OG card. Unknown ids get a friendly 404, upstream failures a degraded 502 page that still offers the stream. |

**The AASA route must stay an exact path — never a `/.well-known/*` wildcard.** GitHub Pages renews the origin's certificate through `/.well-known/acme-challenge/*`, and those requests must keep passing through to the origin untouched. A wildcard route would silently break cert renewal for all of wxyc.org.

## Behavior notes

- **Edge caching.** Upstream `GET /concerts/:id` responses are cached via `caches.default`, honoring the API's `Cache-Control: public, max-age=300` — a share spike reaches the API roughly once per five minutes per show. The HTML responses themselves carry `public, max-age=300` (200s), `public, max-age=60` (404s), and `no-store` (5xx).
- **States.** Past shows render a "This one's passed" treatment instead of the ticket CTA (the by-id endpoint is windowless and serves tombstoned rows forever). `cancelled` / `sold_out` / `rescheduled` get status pills and CTA wording that mirrors the iOS app's `BoxOfficeTicketPresenter`; the ticket CTA target follows the app's `ctaURL` precedence (`event_url` over `ticket_url`).
- **Poster fallback.** Concerts without `image_url` get the app's deterministic `PosterGradient` (FNV-1a over `"<venue.slug>-<id>"` into the same 7-pair palette), so a show paints the same colors in the app and on its share page. Cross-language parity is pinned by tests.
- **Safety.** Upstream strings are HTML-escaped at render time and upstream URLs must be absolute http(s) — scrapers feed the concerts table, so `javascript:` and friends are dropped, not rendered.
- **Analytics.** When `POSTHOG_PROJECT_KEY` is configured the pages include a dependency-free inline snippet capturing `share_page_viewed {concert_id, os}` and `share_page_cta_tapped {cta}` against the PostHog capture API (`POSTHOG_API_HOST`, default `https://us.i.posthog.com`). With no key configured — the default — no analytics ship at all.
- **OG image.** v1 is the static WXYC wordmark card (1200x640 brand asset committed at `assets/og-card.png`), embedded in the bundle and served at `/shows/og-card.png`. To update it, replace the asset with a fresh export from the design library and run `node scripts/embed-og-card.mjs`. The per-show generated poster image is a follow-up ticket (#2).

## Local development

```sh
npm install
npm run dev        # wrangler dev on localhost:8787, hits the real api.wxyc.org
npm run typecheck
npm test           # vitest + @cloudflare/vitest-pool-workers (runs in workerd, no credentials)
```

The test suite runs the real Worker inside workerd with upstream traffic mocked; it needs no Cloudflare account, no network, and no secrets.

## Deploying

Deployment is deliberately staged. The wrangler config is laid out so that a bare deploy cannot touch production:

1. **`npm run deploy`** (bare `wrangler deploy`) publishes to **workers.dev only** — the top-level environment has no routes. Use this for soak/preview.
2. **`npm run deploy:production`** (`wrangler deploy --env production`) attaches the two `wxyc.org` route patterns. This is the explicit, post-soak step gated on the apex cutover soak (see [WXYC/website#209](https://github.com/WXYC/website/issues/209)) — do not run it before that soak concludes.
3. **Rollback:** remove the two routes from the production environment (Cloudflare dashboard or `wrangler triggers deploy` after editing config), or `wrangler delete --env production`. The apex itself can always fall back to the origin by gray-clouding the DNS record.

After production attach, validate the AASA end to end: `curl -i https://wxyc.org/.well-known/apple-app-site-association` and Apple's CDN view at `https://app-site-association.cdn-apple.com/a/v1/wxyc.org`.

CI (GitHub Actions) runs typecheck and tests on every PR and push to `main`. There is intentionally no deploy job yet.
