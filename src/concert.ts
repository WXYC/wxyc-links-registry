// concert.ts
//
// The Concert wire model as served by Backend-Service's public
// `GET /concerts/:id` (contract: wxyc-shared/api.yaml `Concert`), plus a
// lenient decoder. Decoding follows the iOS app's discipline: the fields the
// page cannot render without are required; everything else degrades to null
// (and an unrecognized `status` degrades to "unknown") rather than failing
// the page.

/** Lifecycle state per the `ConcertStatus` schema, plus the local "unknown". */
export type ConcertStatus = "on_sale" | "sold_out" | "cancelled" | "rescheduled" | "unknown";

/**
 * The venue fields this page renders (the wire object carries more — e.g.
 * `id` — which the decoder deliberately does not model).
 */
export interface ConcertVenue {
  slug: string;
  name: string;
  city: string;
  state: string;
  address: string | null;
}

/**
 * The Concert fields this page renders. An honest subset of the wire model:
 * fields nothing reads (e.g. `headlining_artist_id`) are not decoded.
 */
export interface Concert {
  id: number;
  venue: ConcertVenue;
  /** Venue-local (America/New_York) calendar date, `YYYY-MM-DD`. */
  starts_on: string;
  /** Exact start instant (ISO 8601), or null for date-only events. */
  starts_at: string | null;
  /** Doors-open instant (ISO 8601), when the source publishes one. */
  doors_at: string | null;
  /** Headliner billing exactly as the source displays it. */
  headlining_artist_raw: string;
  /** Event name when distinct from the artist billing. */
  title: string | null;
  supporting_artists_raw: string[];
  ticket_url: string | null;
  image_url: string | null;
  /** The venue's own event page; clients prefer it over `ticket_url`. */
  event_url: string | null;
  price_min: number | null;
  price_max: number | null;
  age_restriction: string | null;
  status: ConcertStatus;
}

const STATUSES: readonly ConcertStatus[] = ["on_sale", "sold_out", "cancelled", "rescheduled"];

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Decodes an upstream payload into a Concert, or returns null when the
 * payload is not usable. Required to render: `id`, a venue with `slug`,
 * `name`, and `city`, the `starts_on` date, and the headliner billing —
 * the same floor the iOS decoder enforces. Everything else is optional.
 */
export function parseConcert(payload: unknown): Concert | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;

  const id = asNumber(record.id);
  const startsOn = asString(record.starts_on);
  const headliner = asString(record.headlining_artist_raw);
  if (id === null || startsOn === null || headliner === null) return null;

  const venueRecord = record.venue;
  if (typeof venueRecord !== "object" || venueRecord === null) return null;
  const rawVenue = venueRecord as Record<string, unknown>;
  const slug = asString(rawVenue.slug);
  const name = asString(rawVenue.name);
  const city = asString(rawVenue.city);
  if (slug === null || name === null || city === null) return null;

  const rawStatus = asString(record.status);
  const status: ConcertStatus = STATUSES.includes(rawStatus as ConcertStatus)
    ? (rawStatus as ConcertStatus)
    : "unknown";

  const supporting = Array.isArray(record.supporting_artists_raw)
    ? record.supporting_artists_raw.filter((act): act is string => typeof act === "string")
    : [];

  return {
    id,
    venue: {
      slug,
      name,
      city,
      state: asString(rawVenue.state) ?? "",
      address: asString(rawVenue.address),
    },
    starts_on: startsOn,
    starts_at: asString(record.starts_at),
    doors_at: asString(record.doors_at),
    headlining_artist_raw: headliner,
    title: asString(record.title),
    supporting_artists_raw: supporting,
    ticket_url: asString(record.ticket_url),
    image_url: asString(record.image_url),
    event_url: asString(record.event_url),
    price_min: asNumber(record.price_min),
    price_max: asNumber(record.price_max),
    age_restriction: asString(record.age_restriction),
    status,
  };
}
