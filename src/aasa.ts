// aasa.ts
//
// The apple-app-site-association served on the wxyc.org apex — the org's
// universal-link registry (decision 2026-07-18, WXYC/wxyc-links-registry#1).
// `applinks` routes /shows/* taps into the WXYC listener app. Two keys are
// deliberately absent: `appclips` lands only if the App Clip gate ticket
// resolves GO, and `webcredentials` stays dj-site's concern on its own host.
//
// Two review-driven amendments to the body as originally specced in #1:
//   - The Debug bundle id is listed alongside Release. Debug is Xcode's
//     default run configuration, and Associated Domains developer mode only
//     bypasses Apple's CDN — it does not waive appID matching — so omitting
//     it would send every dev-build tap to Safari.
//   - /shows/og-card.png is excluded (ordered before the wildcard): the OG
//     image is an asset, not a share page, and a forwarded image link should
//     open in the browser, not the app.
//
// Apple requires HTTP 200, Content-Type application/json, and no redirects.
// Apple's CDN caches this file for days — get it right BEFORE first serve.

const APPLE_APP_SITE_ASSOCIATION = {
  applinks: {
    details: [
      {
        appIDs: ["92V374HC38.org.wxyc.iphoneapp", "92V374HC38.org.wxyc.iphoneappdebug"],
        components: [{ "/": "/shows/og-card.png", exclude: true }, { "/": "/shows/*" }],
      },
    ],
  },
} as const;

/** Serialized once — every response is byte-identical. */
const AASA_BODY = JSON.stringify(APPLE_APP_SITE_ASSOCIATION);

/** Builds the AASA response. Cacheable for an hour (dj-site precedent). */
export function aasaResponse(): Response {
  return new Response(AASA_BODY, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
