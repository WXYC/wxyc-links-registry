// Type of the sibling og-card.png when imported as a module: wrangler's
// `rules = [{ type = "Data" }]` (wrangler.toml) resolves PNGs to an
// ArrayBuffer at bundle time. Wildcard ambient modules cannot type relative
// imports, so this `.d.png.ts` sits beside the asset per TypeScript's
// `allowArbitraryExtensions` convention.
declare const data: ArrayBuffer;
export default data;
