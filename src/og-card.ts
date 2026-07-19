// og-card.ts
//
// Serves the static 1200x640 WXYC wordmark OG card — the day-one og:image
// for every share page (a brand asset from the station's design library; the
// per-show generated poster is a follow-up ticket). The PNG ships inside the
// Worker bundle as base64 (see scripts/embed-og-card.mjs), decoded once per
// isolate. It lives at /shows/og-card.png because /shows/* is one of this
// Worker's two routes — nothing else on the apex is its business.

import { OG_CARD_PNG_BASE64 } from "./og-card-data";

let cachedBytes: Uint8Array | null = null;

/** The decoded PNG, memoized per isolate. */
export function ogCardBytes(): Uint8Array {
  if (cachedBytes === null) {
    const binary = atob(OG_CARD_PNG_BASE64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    cachedBytes = bytes;
  }
  return cachedBytes;
}

/** Builds the image response. Immutable-ish: cache for a day. */
export function ogCardResponse(): Response {
  return new Response(ogCardBytes(), {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=86400",
    },
  });
}
