// poster.ts
//
// TypeScript port of the iOS app's PosterGradient
// (wxyc-ios-64 Shared/Concerts/Sources/Concerts/PosterGradient.swift): the
// deterministic fallback artwork for concerts with no `image_url`. The seed
// is a canonical 64-bit FNV-1a fold over `"<venue.slug>-<id>"` so the same
// show paints the same colors in the app and on its share page. Palette order
// is load-bearing — reordering or resizing repaints existing shows.

/** A two-stop gradient (top-leading → bottom-trailing), as CSS hex colors. */
export interface PosterGradientPair {
  start: string;
  end: string;
}

/** The app's 7 warm/moody gradient pairs, in the app's order. */
export const POSTER_PALETTE: readonly PosterGradientPair[] = [
  { start: "#c65a2e", end: "#7d1f3d" },
  { start: "#245b7a", end: "#101a52" },
  { start: "#8a6a3a", end: "#3a2140" },
  { start: "#6d2f6a", end: "#241246" },
  { start: "#2f5a8a", end: "#151a3a" },
  { start: "#b0632a", end: "#4a1d22" },
  { start: "#7a5a1f", end: "#20183a" },
];

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/**
 * Canonical 64-bit FNV-1a over the string's UTF-8 bytes (offset basis
 * 0xcbf29ce484222325, prime 0x100000001b3, XOR-then-multiply per byte).
 * Deterministic across runs and platforms, matching the Swift implementation.
 */
export function fnv1a64(input: string): bigint {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

/** The palette index for a concert: fnv1a64("<slug>-<id>") mod the palette size. */
export function posterIndex(venueSlug: string, concertId: number): number {
  return Number(fnv1a64(`${venueSlug}-${concertId}`) % BigInt(POSTER_PALETTE.length));
}

/** The fallback gradient pair for a concert. Stable per concert. */
export function posterPair(venueSlug: string, concertId: number): PosterGradientPair {
  const pair = POSTER_PALETTE[posterIndex(venueSlug, concertId)];
  if (pair === undefined) throw new Error("unreachable: index is reduced modulo palette length");
  return pair;
}
