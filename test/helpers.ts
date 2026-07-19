// helpers.ts
//
// Shared test scaffolding: the canonical Jessica Pratt fixture (one Concert
// shape for every suite, per the org's WXYC-canonical example-data rule) and
// the outbound-fetch guard that makes any unprimed network call fail loudly.

import { vi, type MockInstance } from "vitest";
import type { Concert } from "../src/concert";

/** Spies on global fetch so any unprimed outbound request fails loudly. */
export function guardOutboundFetch(): MockInstance<typeof fetch> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    throw new Error(`Unprimed outbound fetch in test: ${request.url}`);
  });
}

/**
 * A WXYC-canonical fixture show (Jessica Pratt at Cat's Cradle), dated far in
 * the future so integration tests never trip the passed-show state. Callers
 * supply the id: integration suites allocate fresh ids so `caches.default`
 * entries never collide across tests; unit suites pin one and inject `now`.
 */
export function makeJessicaPratt(overrides: Partial<Concert> & Pick<Concert, "id">): Concert {
  return {
    venue: {
      slug: "cats-cradle",
      name: "Cat's Cradle",
      city: "Carrboro",
      state: "NC",
      address: "300 E Main St, Carrboro, NC 27510",
    },
    starts_on: "2199-08-01",
    starts_at: "2199-08-02T00:00:00.000Z",
    doors_at: "2199-08-01T23:00:00.000Z",
    headlining_artist_raw: "Jessica Pratt",
    title: null,
    supporting_artists_raw: ["Julie Byrne"],
    ticket_url: "https://www.etix.com/ticket/p/12345/jessica-pratt",
    image_url: null,
    event_url: "https://catscradle.com/event/jessica-pratt",
    price_min: 22,
    price_max: 25,
    age_restriction: "All Ages",
    status: "on_sale",
    ...overrides,
  };
}

/**
 * Serializes a fixture as the TRUE wire shape: the live `GET /concerts/:id`
 * carries fields this page does not model (`headlining_artist_id`,
 * `venue.id`, `genres`, `similar_artists`), and priming with them pins the
 * decoder's leniency — a strict-validator refactor must fail these suites,
 * not just production.
 */
export function wireBody(concert: Concert): string {
  return JSON.stringify({
    ...concert,
    headlining_artist_id: 88,
    genres: ["folk", "singer-songwriter"],
    similar_artists: ["Julie Byrne", "Weyes Blood"],
    venue: { ...concert.venue, id: 7 },
  });
}
