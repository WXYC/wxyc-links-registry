// embed-og-card.mjs
//
// Regenerates src/og-card-data.ts from assets/og-card.png. The PNG is embedded
// as base64 so the Worker bundle is self-contained and the module resolves
// identically under wrangler and vitest (no bundler-specific binary-import
// rules to keep in sync). assets/og-card.png is a brand asset exported from
// the station's design library — replace the file, rerun this script.

import { readFileSync, writeFileSync } from "node:fs";

const png = readFileSync(new URL("../assets/og-card.png", import.meta.url));
const base64 = png.toString("base64");

const header = `// og-card-data.ts
//
// GENERATED FILE — do not edit by hand. The static 1200x640 WXYC wordmark OG
// card (brand asset committed at assets/og-card.png), embedded as base64 so
// the Worker bundle is self-contained. After replacing the asset, regenerate
// with:
//
//   node scripts/embed-og-card.mjs

/** Base64 of the 1200x640 wordmark card PNG served at /shows/og-card.png. */
// A flat array joined at runtime, NOT a "…" + "…" chain: thousands of chained
// concatenations nest the AST deep enough to overflow parser stacks.
export const OG_CARD_PNG_BASE64 = [
`;

const chunks = base64.match(/.{1,2000}/g) ?? [];
const literal = chunks.map((chunk) => `  "${chunk}",`).join("\n");
writeFileSync(
  new URL("../src/og-card-data.ts", import.meta.url),
  `${header}${literal}\n].join("");\n`
);
console.log(`Embedded assets/og-card.png (${png.length} bytes) into src/og-card-data.ts`);
