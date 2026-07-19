// embed-og-card.mjs
//
// Regenerates src/og-card-data.ts from assets/og-card.png. The PNG is embedded
// as base64 so the Worker bundle is self-contained and the module resolves
// identically under wrangler and vitest (no bundler-specific binary-import
// rules to keep in sync). Run after scripts/generate-og-card.swift.

import { readFileSync, writeFileSync } from "node:fs";

const png = readFileSync(new URL("../assets/og-card.png", import.meta.url));
const base64 = png.toString("base64");

const header = `// og-card-data.ts
//
// GENERATED FILE — do not edit by hand. The static 1200x630 WXYC wordmark OG
// card (share-card mockup variant A), embedded as base64 so the Worker bundle
// is self-contained. Regenerate with:
//
//   swift scripts/generate-og-card.swift assets/og-card.png
//   node scripts/embed-og-card.mjs

/** Base64 of the 1200x630 wordmark card PNG served at /shows/og-card.png. */
export const OG_CARD_PNG_BASE64 =
`;

const chunks = base64.match(/.{1,100}/g) ?? [];
const literal = chunks.map((chunk) => `  "${chunk}"`).join(" +\n");
writeFileSync(
  new URL("../src/og-card-data.ts", import.meta.url),
  `${header}${literal};\n`
);
console.log(`Embedded assets/og-card.png (${png.length} bytes) into src/og-card-data.ts`);
