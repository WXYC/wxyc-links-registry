// format.ts
//
// Formatting and safety helpers for the share pages. Two hard rules govern
// this module: every upstream string is HTML-escaped exactly once at render
// time (escapeHtml), and every outbound URL from upstream data must survive
// safeHttpUrl — scrapers feed the concerts table, so ticket/event/image URLs
// are external data and script-scheme URLs must die here, not in a reviewer's
// eyeball. Dates render venue-local (America/New_York), matching the
// `starts_on` semantics in wxyc-shared/api.yaml.

import type { Concert } from "./concert";

const NY_TIME_ZONE = "America/New_York";

// Intl formatters are expensive to construct and cheap to reuse, so every
// fixed-config formatter in this module lives at module scope.
const isoDateFormatNY = new Intl.DateTimeFormat("en-CA", {
  timeZone: NY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const calendarDateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
});

const hourFormatNY = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_TIME_ZONE,
  hour: "numeric",
});

const hourMinuteFormatNY = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
});

const minuteProbeNY = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_TIME_ZONE,
  minute: "numeric",
});

const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Escapes the five HTML metacharacters for text and attribute contexts. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Returns the normalized href when `value` is an absolute http(s) URL, else
 * null. This is the only gate through which upstream URLs reach an href/src.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.href;
}

/**
 * Like `safeHttpUrl` but https-only, for `<img src>`. The share page is
 * served over https, so an http image would be mixed content the browser
 * blocks or force-upgrades — dropping it lets the hero fall back cleanly to
 * the poster gradient. (Ticket/event links stay http-tolerant: those are
 * user-initiated top-level navigations, not subresources.)
 */
export function safeImageUrl(value: string | null | undefined): string | null {
  const href = safeHttpUrl(value);
  return href !== null && href.startsWith("https://") ? href : null;
}

/**
 * Formats a `YYYY-MM-DD` venue-local calendar date as "Sat, Aug 1", appending
 * the year ("Sat, Aug 1, 2027") when it differs from the current
 * America/New_York year.
 */
export function formatEventDate(startsOn: string, now: Date): string {
  const date = new Date(`${startsOn}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return startsOn;
  const formatted = calendarDateFormat.format(date);
  const eventYear = startsOn.slice(0, 4);
  // en-CA renders YYYY-MM-DD, so the first four characters are the NY year.
  const currentYear = isoDateFormatNY.format(now).slice(0, 4);
  return eventYear === currentYear ? formatted : `${formatted}, ${eventYear}`;
}

/**
 * Formats an ISO instant as a venue-local clock time — "7 PM", or "7:30 PM"
 * when the minutes are non-zero. Returns null for unparseable input.
 */
export function formatTimeNY(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const minutes = Number(minuteProbeNY.format(date));
  return minutes === 0 ? hourFormatNY.format(date) : hourMinuteFormatNY.format(date);
}

function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * Renders the price facts segment, matching the iOS presenter's priceLabel
 * shapes: "$22", "$22–$25" (dollar sign on both numbers), or "Free"
 * (price_min = 0 per the API contract). Null when no price is known.
 */
export function formatPrice(min: number | null, max: number | null): string | null {
  if (min === null && max === null) return null;
  if (min === 0 && (max === null || max === 0)) return "Free";
  if (min === null) return `$${formatAmount(max as number)}`;
  if (max === null || max === min) return `$${formatAmount(min)}`;
  return `$${formatAmount(min)}–$${formatAmount(max)}`;
}

/** Whether a venue-local calendar date is before today in America/New_York. */
export function isPast(startsOn: string, now: Date): boolean {
  return startsOn < isoDateFormatNY.format(now);
}

/**
 * Whether the show is free, per the API's zero-price convention. The
 * semantic fact — not formatPrice's display string — so presentation copy
 * can change without breaking rules keyed on freeness.
 */
export function isFree(concert: Concert): boolean {
  return concert.price_min === 0;
}

/** The og:title shape from the share-card mockups: artist at venue — WXYC. */
export function ogTitle(concert: Concert): string {
  return `${concert.headlining_artist_raw} at ${concert.venue.name} — WXYC`;
}

/**
 * The facts segments — date, doors-else-showtime, price, age restriction,
 * unknowns omitted. The single source for both the hero facts line and the
 * og:description, so the visible page and the unfurl card can never disagree.
 */
export function factsSegments(concert: Concert, now: Date): string[] {
  const segments = [formatEventDate(concert.starts_on, now)];

  const doors = concert.doors_at === null ? null : formatTimeNY(concert.doors_at);
  const showTime = concert.starts_at === null ? null : formatTimeNY(concert.starts_at);
  if (doors !== null) {
    segments.push(`Doors ${doors}`);
  } else if (showTime !== null) {
    segments.push(showTime);
  }

  const price = formatPrice(concert.price_min, concert.price_max);
  if (price !== null) segments.push(price);
  if (concert.age_restriction !== null && concert.age_restriction !== "") {
    segments.push(concert.age_restriction);
  }

  return segments;
}

/**
 * The lifecycle lead for the og:description — present only when it would
 * change whether the recipient should get excited. The switch is exhaustive
 * over ConcertStatus so a new status cannot silently skip the description.
 */
function statusLead(concert: Concert, now: Date): string | null {
  if (isPast(concert.starts_on, now)) return "This one's passed";
  switch (concert.status) {
    case "cancelled":
      return "Cancelled";
    case "sold_out":
      return "Sold out";
    case "rescheduled":
      return "Rescheduled";
    case "on_sale":
    case "unknown":
      return null;
  }
}

/**
 * Composes the og:description — "Sat, Aug 1 · Doors 7 PM · $22–$25 · All
 * Ages. Heard on WXYC 89.3 FM Chapel Hill." — omitting unknown segments, and
 * leading with the lifecycle state (passed/cancelled/sold out/rescheduled).
 */
export function buildDescription(concert: Concert, now: Date): string {
  const lead = statusLead(concert, now);
  const segments = lead === null ? [] : [lead];
  segments.push(...factsSegments(concert, now));
  return `${segments.join(" · ")}. Heard on WXYC 89.3 FM Chapel Hill.`;
}

/**
 * The Apple Maps search link backing the Directions CTA, mirroring the iOS
 * app's BoxOfficeTicketPresenter: venue name, then street address, then
 * city/state, empty components skipped.
 */
export function directionsUrl(concert: Concert): string {
  const { name, address, city, state } = concert.venue;
  const parts = [name];
  if (address !== null && address !== "") parts.push(address);
  if (city !== "") parts.push(city);
  if (state !== "") parts.push(state);
  return `https://maps.apple.com/?q=${encodeURIComponent(parts.join(", "))}`;
}

/**
 * The oversized poster initial: the headliner's first grapheme, uppercased,
 * with a music note fallback for blank billing.
 */
export function initialGrapheme(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return "♪";
  const first = [...graphemeSegmenter.segment(trimmed)][0]?.segment;
  return (first ?? "♪").toUpperCase();
}
