// og-card.ts
//
// Serves the static 1200x640 WXYC wordmark OG card — the day-one og:image
// for every share page (a brand asset from the station's design library; the
// per-show generated poster is a follow-up ticket). The PNG ships inside the
// Worker bundle as a binary Data module (see `rules` in wrangler.toml), so
// there is no base64 blob to decode and nothing to regenerate: replace
// assets/og-card.png and redeploy. It lives at /shows/og-card.png because
// /shows/* is one of this Worker's two routes — nothing else on the apex is
// its business.

import OG_CARD_PNG from "../assets/og-card.png";

/** The one path under /shows/ that is an asset, not a share page. */
export const OG_CARD_PATH = "/shows/og-card.png";

/** The absolute og:image URL for a page served from `origin`. */
export function ogImageUrl(origin: string): string {
  return `${origin}${OG_CARD_PATH}`;
}

/** Builds the image response. Immutable-ish: cache for a day. */
export function ogCardResponse(): Response {
  return new Response(OG_CARD_PNG, {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  });
}
