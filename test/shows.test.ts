// shows.test.ts
//
// End-to-end coverage of the /shows/:id share pages through the real Worker
// in workerd (`exports.default.fetch()`), with upstream api.wxyc.org mocked
// by spying on `globalThis.fetch` — the Worker runs in the same isolate as
// the tests, and the guard throws on any unprimed outbound request, so a
// test that slips a real network call fails loudly. Covers the happy path
// (OG tags, Smart App Banner, stream, CTAs), CTA precedence, HTML-escaping
// of hostile upstream strings, slug and trailing-slash canonicalization,
// unknown/absurd ids, upstream 404/5xx degradation, edge caching, and the
// embedded OG card asset.
//
// Each test uses a distinct concert id: the Worker caches upstream responses
// in `caches.default`, which is shared across tests in this file, so reusing
// an id would leak one test's fixture into the next.

import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Concert } from "../src/concert";
import { renderShowPage } from "../src/render";

const worker = exports.default;

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    throw new Error(`Unprimed outbound fetch in test: ${request.url}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Allocates a fresh concert id per test so cache entries never collide. */
let lastId = 5000;
function nextId(): number {
  lastId += 1;
  return lastId;
}

/**
 * A WXYC-canonical fixture show (Jessica Pratt at Cat's Cradle), dated far in
 * the future so the integration tests never trip the passed-show state — the
 * Worker reads the real clock; date-edge behavior is unit-tested in
 * format.test.ts with an injected now.
 */
function jessicaPratt(overrides: Partial<Concert> = {}): Concert {
  return {
    id: nextId(),
    venue: {
      id: 7,
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
    headlining_artist_id: 88,
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

/** Primes the fetch spy to answer `GET /concerts/:id` like production does. */
function primeConcert(
  concert: Concert,
  reply: { status?: number; body?: string; contentType?: string } = {}
): void {
  const status = reply.status ?? 200;
  const body = reply.body ?? JSON.stringify(concert);
  const contentType = reply.contentType ?? "application/json; charset=utf-8";
  fetchSpy.mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "https://api.wxyc.org" && url.pathname === `/concerts/${concert.id}`) {
      return new Response(body, {
        status,
        headers: {
          "content-type": contentType,
          "cache-control": "public, max-age=300",
        },
      });
    }
    throw new Error(`Unprimed outbound fetch in test: ${request.url}`);
  });
}

function showUrl(concert: Concert): string {
  return `https://wxyc.org/shows/${concert.id}`;
}

describe("GET /shows/:id — live show", () => {
  it("renders the OG head that authors every share card", async () => {
    const show = jessicaPratt();
    primeConcert(show);
    const response = await worker.fetch(showUrl(show));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");

    expect(html).toContain("<!doctype html>");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain(
      'property="og:title" content="Jessica Pratt at Cat&#39;s Cradle — WXYC"'
    );
    expect(html).toContain(`property="og:url" content="https://wxyc.org/shows/${show.id}"`);
    expect(html).toContain(`rel="canonical" href="https://wxyc.org/shows/${show.id}"`);
    expect(html).toContain('property="og:image" content="https://wxyc.org/shows/og-card.png"');
    expect(html).toContain('property="og:site_name" content="WXYC 89.3 FM"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toMatch(/property="og:description" content="[^"]*Doors 7 PM[^"]*"/);
    expect(html).toMatch(/og:description" content="[^"]*Heard on WXYC 89\.3 FM Chapel Hill\./);
  });

  it("carries the Smart App Banner meta for the App Store listing", async () => {
    const show = jessicaPratt();
    primeConcert(show);
    const response = await worker.fetch(showUrl(show));
    const html = await response.text();
    expect(html).toContain('name="apple-itunes-app" content="app-id=353182815"');
  });

  it("renders the facts, billing, status pill, and live-stream player", async () => {
    const show = jessicaPratt();
    primeConcert(show);
    const response = await worker.fetch(showUrl(show));
    const html = await response.text();

    expect(html).toContain("Jessica Pratt");
    expect(html).toContain("w/ Julie Byrne");
    expect(html).toContain("Cat&#39;s Cradle, Carrboro");
    expect(html).toMatch(/Aug 1, 2199/);
    expect(html).toContain("Doors 7 PM");
    expect(html).toContain("$22–25");
    expect(html).toContain("All Ages");
    expect(html).toContain("ON SALE");
    expect(html).toContain("<audio");
    expect(html).toContain("https://audio-mp3.ibiblio.org/wxyc.mp3");
  });

  it("prefers event_url for the ticket CTA and links directions + the app", async () => {
    const show = jessicaPratt();
    primeConcert(show);
    const response = await worker.fetch(showUrl(show));
    const html = await response.text();

    expect(html).toMatch(
      /data-cta="tickets" href="https:\/\/catscradle\.com\/event\/jessica-pratt"/
    );
    expect(html).toContain("Get Tickets");
    expect(html).toMatch(/data-cta="directions" href="https:\/\/maps\.apple\.com\/\?q=Cat/);
    expect(html).toMatch(
      /data-cta="open_app" href="https:\/\/apps\.apple\.com\/us\/app\/wxyc-radio\/id353182815"/
    );
  });

  it("falls back to ticket_url when the venue has no event page (iOS ctaURL precedence)", async () => {
    const show = jessicaPratt({ event_url: null });
    primeConcert(show);
    const response = await worker.fetch(showUrl(show));
    const html = await response.text();
    expect(html).toMatch(
      /data-cta="tickets" href="https:\/\/www\.etix\.com\/ticket\/p\/12345\/jessica-pratt"/
    );
  });

  it("is edge-cacheable for the share-spike window", async () => {
    const show = jessicaPratt();
    primeConcert(show);
    const response = await worker.fetch(showUrl(show));
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("serves repeat hits from the edge cache without re-reaching the API", async () => {
    const show = jessicaPratt();
    primeConcert(show);

    const first = await worker.fetch(showUrl(show));
    expect(first.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const second = await worker.fetch(showUrl(show));
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("Jessica Pratt");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("GET /shows/:id — hostile upstream data", () => {
  it("HTML-escapes artist and venue strings and drops script-scheme URLs", async () => {
    const show = jessicaPratt({
      headlining_artist_raw: "Sleater<script>alert(1)</script>",
      supporting_artists_raw: ["<img src=x onerror=alert(2)>"],
      ticket_url: "javascript:alert(3)",
      event_url: null,
      image_url: "javascript:alert(4)",
    });
    primeConcert(show);
    const response = await worker.fetch(showUrl(show));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("Sleater&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("javascript:");
    // Both outbound URLs were unsafe, so the ticket CTA disappears entirely.
    expect(html).not.toContain('data-cta="tickets"');
  });
});

describe("GET /shows/:id — canonicalization", () => {
  it.each([
    ["https://wxyc.org/shows/4821-jessica-pratt", "slugged"],
    ["https://wxyc.org/shows/4821/", "trailing slash"],
    ["https://wxyc.org/shows/04821", "leading zeros"],
    ["https://wxyc.org/shows/4821-", "dangling hyphen"],
  ])("301s %s to the bare canonical form (%s)", async (variant) => {
    const response = await worker.fetch(variant, { redirect: "manual" });
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://wxyc.org/shows/4821");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("GET /shows/:id — misses and junk ids", () => {
  it("renders a friendly 404 with an upcoming pointer when the API knows no such show", async () => {
    const missingId = nextId();
    fetchSpy.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === "https://api.wxyc.org" && url.pathname === `/concerts/${missingId}`) {
        return new Response(JSON.stringify({ message: `No concert with id ${missingId}` }), {
          status: 404,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      throw new Error(`Unprimed outbound fetch in test: ${request.url}`);
    });

    const response = await worker.fetch(`https://wxyc.org/shows/${missingId}`);
    const html = await response.text();

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(html).toContain("couldn't find that show");
    expect(html).toContain("what's coming up");
  });

  it.each([
    ["https://wxyc.org/shows/jessica-pratt", "non-numeric id"],
    ["https://wxyc.org/shows/99999999999999999999", "overflow id"],
    ["https://wxyc.org/shows/0", "zero id"],
    ["https://wxyc.org/shows/", "no id"],
    ["https://wxyc.org/shows", "bare prefix"],
  ])("404s %s locally without calling upstream (%s)", async (url) => {
    const response = await worker.fetch(url);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("couldn't find that show");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("GET /shows/:id — upstream failures", () => {
  it("degrades to a 502 page when the API answers 5xx", async () => {
    const show = jessicaPratt();
    primeConcert(show, { status: 500, body: "Internal Server Error", contentType: "text/plain" });

    const response = await worker.fetch(showUrl(show));
    const html = await response.text();

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("trouble loading this show");
    // The stream player survives an API outage — the radio does not.
    expect(html).toContain("https://audio-mp3.ibiblio.org/wxyc.mp3");
  });

  it("degrades to a 502 page when the fetch itself fails", async () => {
    const show = jessicaPratt();
    fetchSpy.mockImplementation(async () => {
      throw new Error("connection reset");
    });

    const response = await worker.fetch(showUrl(show));
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("trouble loading this show");
  });

  it("degrades to a 502 page when the API answers 200 with junk", async () => {
    const show = jessicaPratt();
    primeConcert(show, { body: "<html>surprise!</html>", contentType: "text/html" });

    const response = await worker.fetch(showUrl(show));
    expect(response.status).toBe(502);
  });
});

describe("GET /shows/:id — passed and off-sale states", () => {
  it("swaps the CTA row for the passed notice on shows that already happened", async () => {
    const show = jessicaPratt({ starts_on: "2020-02-01", starts_at: null, doors_at: null });
    primeConcert(show);
    const response = await worker.fetch(showUrl(show));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("This one's passed — here's what's coming up");
    expect(html).toContain("PASSED");
    expect(html).not.toContain('data-cta="tickets"');
    expect(html).toContain("See what's coming up in the WXYC app");
  });

  it("marks cancelled shows and reroutes the CTA to the venue page (iOS wording)", async () => {
    const show = jessicaPratt({ status: "cancelled" });
    primeConcert(show);
    const response = await worker.fetch(showUrl(show));
    const html = await response.text();

    expect(html).toContain("CANCELLED");
    expect(html).not.toContain("Get Tickets");
    expect(html).toContain("See the venue's page");
    expect(html).toMatch(
      /data-cta="tickets" href="https:\/\/catscradle\.com\/event\/jessica-pratt"/
    );
  });

  it("marks sold-out shows without dropping the venue link", async () => {
    const show = jessicaPratt({ status: "sold_out" });
    primeConcert(show);
    const response = await worker.fetch(showUrl(show));
    const html = await response.text();

    expect(html).toContain("SOLD OUT");
    expect(html).not.toContain("Get Tickets");
    expect(html).toContain("See Venue Page");
  });

  it("degrades an unrecognized status to no pill and cautious CTA wording", async () => {
    const show = jessicaPratt({ status: "hologram_tour" as Concert["status"] });
    primeConcert(show);
    const response = await worker.fetch(showUrl(show));
    const html = await response.text();

    expect(response.status).toBe(200);
    // Mirrors the iOS presenter: an unknown status cannot claim tickets exist.
    expect(html).toContain("See Venue Page");
    expect(html).not.toContain("Get Tickets");
    expect(html).not.toContain("hologram_tour");
  });
});

describe("GET /shows/og-card.png — the static OG image", () => {
  it("serves the embedded 1200x640 wordmark PNG", async () => {
    const response = await worker.fetch("https://wxyc.org/shows/og-card.png");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(fetchSpy).not.toHaveBeenCalled();

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(bytes.length).toBeGreaterThan(10_000);
  });
});

describe("share-page analytics snippet", () => {
  it("stays out of the page when no PostHog key is configured (the default)", async () => {
    const show = jessicaPratt();
    primeConcert(show);
    const response = await worker.fetch(showUrl(show));
    const html = await response.text();
    expect(html.toLowerCase()).not.toContain("posthog");
    expect(html).not.toContain("share_page_viewed");
  });

  it("captures share_page_viewed and share_page_cta_tapped when a key is configured", () => {
    const show = jessicaPratt();
    const html = renderShowPage(show, {
      requestOrigin: "https://wxyc.org",
      analytics: { projectKey: "phc_test123" },
    });

    expect(html).toContain('"share_page_viewed"');
    expect(html).toContain('"share_page_cta_tapped"');
    expect(html).toContain('"phc_test123"');
    expect(html).toContain("https://us.i.posthog.com");
    expect(html).toContain("concert_id");
    expect(html).toContain(String(show.id));
  });

  it("renders the event title line when the source provides one", () => {
    const html = renderShowPage(jessicaPratt({ title: "Merge 40 Kickoff" }), {
      requestOrigin: "https://wxyc.org",
    });
    expect(html).toContain("Merge 40 Kickoff");
  });
});
