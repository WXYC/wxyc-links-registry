// aasa.ts
//
// The apple-app-site-association served on the wxyc.org apex — the org's
// universal-link registry (decision 2026-07-18, WXYC/wxyc-links-registry#1).
// `applinks` routes /shows/* taps into the WXYC listener app. Two keys are
// deliberately absent: `appclips` lands only if the App Clip gate ticket
// resolves GO, and `webcredentials` stays dj-site's concern on its own host.
//
// Apple requires HTTP 200, Content-Type application/json, and no redirects.

/** The association body, exactly as specced in wxyc-links-registry#1. */
export const APPLE_APP_SITE_ASSOCIATION = {
  applinks: {
    details: [
      {
        appIDs: ["92V374HC38.org.wxyc.iphoneapp"],
        components: [{ "/": "/shows/*" }],
      },
    ],
  },
} as const;

/** Builds the AASA response. Cacheable for an hour (dj-site precedent). */
export function aasaResponse(): Response {
  return new Response(JSON.stringify(APPLE_APP_SITE_ASSOCIATION), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=3600",
    },
  });
}
