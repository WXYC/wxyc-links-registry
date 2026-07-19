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
 * Formats a `YYYY-MM-DD` venue-local calendar date as "Sat, Aug 1", appending
 * the year ("Sat, Aug 1, 2027") when it differs from the current
 * America/New_York year.
 */
export function formatEventDate(startsOn: string, now: Date): string {
  const date = new Date(`${startsOn}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return startsOn;
  const formatted = calendarDateFormat.format(date);
  const eventYear = startsOn.slice(0, 4);
  const currentYear = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TIME_ZONE,
    year: "numeric",
  }).format(now);
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
 * Renders the price facts segment: "$22", "$22–25", or "Free" (price_min = 0
 * per the API contract). Null when no price is known.
 */
export function formatPrice(min: number | null, max: number | null): string | null {
  if (min === null && max === null) return null;
  if (min === 0 && (max === null || max === 0)) return "Free";
  if (min === null) return `$${formatAmount(max as number)}`;
  if (max === null || max === min) return `$${formatAmount(min)}`;
  return `$${formatAmount(min)}–${formatAmount(max)}`;
}

/** Whether a venue-local calendar date is before today in America/New_York. */
export function isPast(startsOn: string, now: Date): boolean {
  return startsOn < isoDateFormatNY.format(now);
}

/** The og:title shape from the share-card mockups: artist at venue — WXYC. */
export function ogTitle(concert: Concert): string {
  return `${concert.headlining_artist_raw} at ${concert.venue.name} — WXYC`;
}

/**
 * Composes the og:description — "Sat, Aug 1 · Doors 7 PM · $22–25 · All Ages.
 * Heard on WXYC 89.3 FM Chapel Hill." — omitting unknown segments, and
 * leading with the lifecycle state (passed/cancelled/sold out/rescheduled)
 * when it would change whether the recipient should get excited.
 */
export function buildDescription(concert: Concert, now: Date): string {
  const segments: string[] = [];

  if (isPast(concert.starts_on, now)) {
    segments.push("This one's passed");
  } else if (concert.status === "cancelled") {
    segments.push("Cancelled");
  } else if (concert.status === "sold_out") {
    segments.push("Sold out");
  } else if (concert.status === "rescheduled") {
    segments.push("Rescheduled");
  }

  segments.push(formatEventDate(concert.starts_on, now));

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
  let first: string | undefined;
  if ("Segmenter" in Intl) {
    const segments = new Intl.Segmenter("en", { granularity: "grapheme" }).segment(trimmed);
    first = [...segments][0]?.segment;
  }
  first ??= [...trimmed][0];
  return (first ?? "♪").toUpperCase();
}
