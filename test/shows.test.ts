// shows.test.ts
//
// End-to-end coverage of the /shows/:id share pages through the real Worker
// in workerd (`exports.default.fetch()`), with upstream api.wxyc.org mocked
// by spying on `globalThis.fetch` — the Worker runs in the same isolate as
// the tests, and the guard throws on any unprimed outbound request, so a
// test that slips a real network call fails loudly. Covers the happy path
// (OG tags, Smart App Banner, stream, CTAs), CTA precedence, HTML-escaping
// of hostile upstream strings, trailing-slash/zero-pad canonicalization
// (slugged forms deliberately 404 — nothing emits them), unknown/absurd
// ids, upstream 404/5xx degradation, edge caching incl. header-hazard and
// negative-cache behavior, and the bundled OG card asset.
//
// Each test uses a distinct concert id: the Worker caches upstream responses
// in `caches.default`, which is shared across tests in this file, so reusing
// an id would leak one test's fixture into the next.

import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Concert } from "../src/concert";
import type { Env } from "../src/env";
import { renderNotFoundPage, renderShowPage, renderUpstreamErrorPage } from "../src/render";
import { fetchConcert } from "../src/upstream";
import { guardOutboundFetch, makeJessicaPratt, wireBody } from "./helpers";

const worker = exports.default;

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  fetchSpy = guardOutboundFetch();
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

/** The shared fixture with a fresh id per call (see test/helpers.ts). */
function jessicaPratt(overrides: Partial<Concert> = {}): Concert {
  return makeJessicaPratt({ id: nextId(), ...overrides });
}

/**
 * Primes the fetch spy to answer `GET /concerts/:id` like production does —
 * the true wire body (extra fields included), overridable status/body/headers
 * (`cacheControl: null` omits the header), and an alternate origin for the
 * CONCERTS_API_ORIGIN suite. Requested URLs are read from fetchSpy.mock.calls.
 */
function primeConcert(
  concert: Concert,
  reply: {
    status?: number;
    body?: string;
    contentType?: string;
    cacheControl?: string | null;
    headers?: Record<string, string>;
    origin?: string;
  } = {}
): void {
  const status = reply.status ?? 200;
  const body = reply.body ?? wireBody(concert);
  const origin = reply.origin ?? "https://api.wxyc.org";
  const headers = new Headers(reply.headers ?? {});
  headers.set("content-type", reply.contentType ?? "application/json; charset=utf-8");
  const cacheControl = reply.cacheControl === undefined ? "public, max-age=300" : reply.cacheControl;
  if (cacheControl !== null) headers.set("cache-control", cacheControl);
  fetchSpy.mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === origin && url.pathname === `/concerts/${concert.id}`) {
      return new Response(body, { status, headers });
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

  it("carries the Smart App Banner meta with the show as its app-argument", async () => {
    const show = jessicaPratt();
    primeConcert(show);
    const response = await worker.fetch(showUrl(show));
    const html = await response.text();
    // The app-argument is the wxyc:// scheme, not the https share URL: OPEN
    // delivers it through onOpenURL, and the https universal link is suppressed
    // when it originates on the wxyc.org apex, so only the scheme routes the
    // installed app to the concert instead of cold-launching to the home screen.
    expect(html).toContain(
      `name="apple-itunes-app" content="app-id=353182815, app-argument=wxyc://concert/${show.id}"`
    );
  });

  it("sends the standard hardening headers on page responses", async () => {
    const show = jessicaPratt();
    primeConcert(show);
    const response = await worker.fetch(showUrl(show));
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
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
    expect(html).toContain("$22–$25");
    expect(html).toContain("All Ages");
    expect(html).toContain("ON SALE");
    expect(html).toContain("<audio");
    expect(html).toContain("https://audio-mp3.ibiblio.org/wxyc.mp3");
  });

  it("labels the CTA with the entry price (mockup wording) but never '— Free'", async () => {
    const priced = jessicaPratt();
    primeConcert(priced);
    const pricedHtml = await (await worker.fetch(showUrl(priced))).text();
    expect(pricedHtml).toContain(">Get Tickets — $22<");

    const free = jessicaPratt({ price_min: 0, price_max: 0 });
    primeConcert(free);
    const freeHtml = await (await worker.fetch(showUrl(free))).text();
    expect(freeHtml).toContain(">Get Tickets<");
    expect(freeHtml).not.toContain("Get Tickets —");
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
    expect(html).toContain(`data-cta="open_app" href="wxyc://concert/${show.id}"`);
  });

  it("opens the installed app via the wxyc:// scheme, with the Smart App Banner as the no-app fallback", async () => {
    const show = jessicaPratt();
    primeConcert(show);
    const html = await (await worker.fetch(showUrl(show))).text();
    // The in-page button is a scheme link — a universal link tapped from the
    // wxyc.org apex never hands off to the app — so an installed app opens
    // straight to the show.
    expect(html).toContain(`data-cta="open_app" href="wxyc://concert/${show.id}"`);
    // No in-page JS fallback: the native Smart App Banner (the app-argument
    // above) is the installed-vs-not handler, so the live-show page ships no
    // click-timer script and carries no App Store link of its own.
    expect(html).not.toContain('[href^="wxyc:"]');
    expect(html).not.toContain("apps.apple.com");
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

  it("caches correctly even when upstream marks the body content-encoded", async () => {
    // workerd decompresses transparently but keeps the content-encoding
    // header on the response; copying it onto the rebuilt cache entry makes
    // every hit unreadable and silently turns the cache into passthrough.
    const show = jessicaPratt();
    primeConcert(show, { headers: { "content-encoding": "gzip" } });

    const first = await worker.fetch(showUrl(show));
    expect(first.status).toBe(200);
    const second = await worker.fetch(showUrl(show));
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("Jessica Pratt");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("caches correctly even when upstream sets a cookie", async () => {
    // The Cache API refuses to store any response bearing set-cookie; the
    // rebuilt entry must not inherit it or caching silently shuts off.
    const show = jessicaPratt();
    primeConcert(show, { headers: { "set-cookie": "AWSALB=abc123; Path=/" } });

    await worker.fetch(showUrl(show));
    const second = await worker.fetch(showUrl(show));
    expect(second.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("bounds staleness with its own TTL when upstream omits Cache-Control", async () => {
    // Absent upstream Cache-Control, workerd stores nothing while production
    // would pin the entry for the default edge TTL (~2h) — both wrong. The
    // Worker stamps its own bounded TTL so behavior is uniform and capped.
    const show = jessicaPratt();
    primeConcert(show, { cacheControl: null });

    await worker.fetch(showUrl(show));
    const second = await worker.fetch(showUrl(show));
    expect(second.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each(["no-store", "private", "no-cache"])(
    "never serves from cache when upstream says %s",
    async (directive) => {
      // no-cache means revalidate-before-use (RFC 9111); this Worker has no
      // conditional-request machinery, so it must not serve the entry at all
      // — it is the standard knob an operator flips during an incident.
      const show = jessicaPratt();
      primeConcert(show, { cacheControl: directive });

      await worker.fetch(showUrl(show));
      await worker.fetch(showUrl(show));
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    }
  );
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

  it("drops an http image_url to the gradient rather than emit mixed content", async () => {
    const show = jessicaPratt({ image_url: "http://insecure.example.com/poster.jpg" });
    primeConcert(show);
    const response = await worker.fetch(showUrl(show));
    const html = await response.text();

    // An http <img> on the https share page is mixed content the browser
    // blocks or force-upgrades; the hero must fall back to the poster gradient.
    expect(html).not.toContain("http://insecure.example.com/poster.jpg");
    expect(html).not.toContain("<img");
    expect(html).toContain("linear-gradient(");
  });

  it("keeps an https image_url as the hero art", async () => {
    const show = jessicaPratt({ image_url: "https://img.example.com/poster.jpg" });
    primeConcert(show);
    const response = await worker.fetch(showUrl(show));
    const html = await response.text();
    expect(html).toContain('<img class="art" src="https://img.example.com/poster.jpg"');
  });
});

describe("GET /shows/:id — canonicalization", () => {
  it("301s a trailing slash to the bare canonical form", async () => {
    const id = nextId();
    const response = await worker.fetch(`https://wxyc.org/shows/${id}/`, { redirect: "manual" });
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`https://wxyc.org/shows/${id}`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("301s leading zeros to the bare canonical form", async () => {
    const id = nextId();
    const response = await worker.fetch(`https://wxyc.org/shows/000${id}`, { redirect: "manual" });
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`https://wxyc.org/shows/${id}`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("carries the query string through the 301 so attribution params survive", async () => {
    const id = nextId();
    const response = await worker.fetch(`https://wxyc.org/shows/${id}/?utm_source=messages`, {
      redirect: "manual",
    });
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(
      `https://wxyc.org/shows/${id}?utm_source=messages`
    );
  });

  it("serves percent-encoded digits as the decoded id — never a truncated redirect", async () => {
    const show = jessicaPratt();
    primeConcert(show);
    // Encode every digit (0-9 -> %30..%39): /shows/%34%38%32%31 style.
    const encoded = String(show.id)
      .split("")
      .map((digit) => `%3${digit}`)
      .join("");
    const response = await worker.fetch(`https://wxyc.org/shows/${encoded}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Jessica Pratt");
  });

  it("resolves a partially encoded id to the full id, not the raw-digit prefix", async () => {
    const show = jessicaPratt();
    primeConcert(show);
    // Encode only the second digit: the historical failure 301'd this to the
    // one-digit prefix — a different concert entirely.
    const text = String(show.id);
    const mixed = `${text[0]}%3${text[1]}${text.slice(2)}`;
    const response = await worker.fetch(`https://wxyc.org/shows/${mixed}`, {
      redirect: "manual",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Jessica Pratt");
  });
});

describe("GET /shows/:id — misses and junk ids", () => {
  it("renders a friendly 404 with an upcoming pointer when the API knows no such show", async () => {
    const missing = jessicaPratt();
    primeConcert(missing, {
      status: 404,
      body: JSON.stringify({ message: `No concert with id ${missing.id}` }),
    });

    const response = await worker.fetch(showUrl(missing));
    const html = await response.text();

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(html).toContain("couldn't find that show");
    expect(html).toContain("what's coming up");
    // No show to hand off, so the Smart App Banner stays bare.
    expect(html).toContain('name="apple-itunes-app" content="app-id=353182815"');
    expect(html).not.toContain("app-argument");
  });

  it("negatively caches upstream 404s so a dead shared link cannot hammer the API", async () => {
    const missing = jessicaPratt();
    primeConcert(missing, {
      status: 404,
      body: JSON.stringify({ message: `No concert with id ${missing.id}` }),
    });

    const first = await worker.fetch(showUrl(missing));
    expect(first.status).toBe(404);
    const second = await worker.fetch(showUrl(missing));
    expect(second.status).toBe(404);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["https://wxyc.org/shows/jessica-pratt", "non-numeric id"],
    ["https://wxyc.org/shows/6101-jessica-pratt", "slugged id (nothing emits slugs)"],
    ["https://wxyc.org/shows/6102-", "dangling hyphen"],
    ["https://wxyc.org/shows/99999999999999999999", "overflow id"],
    ["https://wxyc.org/shows/0", "zero id"],
    ["https://wxyc.org/shows/", "no id"],
    ["https://wxyc.org/shows/%E0%A4%A", "malformed percent-encoding"],
    ["https://wxyc.org/shows/2026-08-01", "date-shaped path (future calendar namespace)"],
    ["https://wxyc.org/shows/og%2Dcard.png", "percent-encoded og-card alias (AASA excludes only the literal path)"],
  ])("404s %s locally without calling upstream (%s)", async (url) => {
    const response = await worker.fetch(url);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("couldn't find that show");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaves bare /shows to the generic 404 — the production route pattern never matches it", async () => {
    // Cloudflare's `wxyc.org/shows/*` requires the trailing slash, so bare
    // /shows falls through to the origin in production; the Worker must not
    // pretend otherwise on hosts where every path reaches it.
    const response = await worker.fetch("https://wxyc.org/shows");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("404s an absurdly long digit run quickly instead of grinding the matcher", async () => {
    const started = performance.now();
    const response = await worker.fetch(`https://wxyc.org/shows/${"9".repeat(20_000)}/x`);
    const elapsed = performance.now() - started;
    expect(response.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    // The old adjacent-quantifier pattern took ~200ms+ here; the length cap
    // plus the residue-free pattern keeps this in noise territory.
    expect(elapsed).toBeLessThan(50);
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
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
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

  it("recovers immediately once upstream heals — a junk 200 must not poison the cache", async () => {
    const show = jessicaPratt();

    primeConcert(show, { body: "<html>surprise!</html>", contentType: "text/html" });
    const poisoned = await worker.fetch(showUrl(show));
    expect(poisoned.status).toBe(502);

    primeConcert(show);
    const healed = await worker.fetch(showUrl(show));
    expect(healed.status).toBe(200);
    expect(await healed.text()).toContain("Jessica Pratt");
    // The junk body was never cached, so the healed request re-consulted upstream.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("bounds the upstream wait with an abort signal so a stalled API cannot hang the page", async () => {
    const show = jessicaPratt();
    primeConcert(show);
    await worker.fetch(showUrl(show));
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("fetchConcert — CONCERTS_API_ORIGIN hygiene", () => {
  /** URLs the spy actually received, straight from the mock's call log. */
  function requestedUrls(): string[] {
    return fetchSpy.mock.calls.map(([input, init]) => new Request(input, init).url);
  }

  it.each([
    ["https://api.wxyc.org/", "trailing slash (Express would 404 the double-slash path)"],
    ["", "empty string (a relative URL would throw in the cache layer)"],
    ["api.wxyc.org", "scheme-less value"],
    [" https://api.wxyc.org/ ", "whitespace padding (URL parsing strips it; the composed string must too)"],
    ["https://api.wxyc.org?x=1", "query residue (the path would land inside the query string)"],
    ["https://api.wxyc.org#frag", "fragment residue (fetch would GET the API root)"],
    ["https://api.wxyc.org#", "empty fragment (normalizes to the clean origin)"],
  ])("falls back to a clean default for %j (%s)", async (configured) => {
    const show = jessicaPratt();
    primeConcert(show);
    const lookup = await fetchConcert(show.id, { CONCERTS_API_ORIGIN: configured });
    expect(lookup.kind).toBe("ok");
    expect(requestedUrls()).toEqual([`https://api.wxyc.org/concerts/${show.id}`]);
  });

  it("honors a well-formed override verbatim", async () => {
    const show = jessicaPratt();
    primeConcert(show, { origin: "https://staging.api.wxyc.org" });
    const env: Env = { CONCERTS_API_ORIGIN: "https://staging.api.wxyc.org" };
    const lookup = await fetchConcert(show.id, env);
    expect(lookup.kind).toBe("ok");
    expect(requestedUrls()).toEqual([`https://staging.api.wxyc.org/concerts/${show.id}`]);
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

  it("marks rescheduled shows with the app's exact caption wording", async () => {
    const show = jessicaPratt({ status: "rescheduled" });
    primeConcert(show);
    const response = await worker.fetch(showUrl(show));
    const html = await response.text();

    expect(html).toContain("RESCHEDULED");
    expect(html).toContain(">Get Tickets — $22<");
    // BoxOfficeTicketPresenter re-authors the sentence with a lowercase
    // "opens"; the share page must match it word for word.
    expect(html).toContain("Rescheduled — opens Cat&#39;s Cradle's event page");
    expect(html).not.toContain("Rescheduled — Opens");
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
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(fetchSpy).not.toHaveBeenCalled();

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(bytes.length).toBeGreaterThan(10_000);

    // The IHDR dimensions must match the og:image:width/height metas the
    // pages declare — a swapped-in asset at other dimensions would make
    // every share card lie to unfurl renderers.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(16)).toBe(1200);
    expect(view.getUint32(20)).toBe(640);
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
    // Pin the embedded value specifically — String(show.id) alone also
    // matches the id in og:url/canonical/app-argument, so it would pass even
    // if the snippet emitted the wrong concert_id.
    expect(html).toContain(`var concertId = ${show.id};`);
  });

  it("renders the event title line when the source provides one", () => {
    const html = renderShowPage(jessicaPratt({ title: "Merge 40 Kickoff" }), {
      requestOrigin: "https://wxyc.org",
    });
    expect(html).toContain("Merge 40 Kickoff");
  });

  it("instruments the not-found page too, with a null concert_id", () => {
    const html = renderNotFoundPage({
      requestOrigin: "https://wxyc.org",
      analytics: { projectKey: "phc_test123" },
    });
    expect(html).toContain('"share_page_viewed"');
    expect(html).toContain("var concertId = null;");
  });

  it("instruments the degraded error page when the router has analytics config", () => {
    const html = renderUpstreamErrorPage({
      requestOrigin: "https://wxyc.org",
      analytics: { projectKey: "phc_test123" },
    });
    expect(html).toContain('"share_page_viewed"');
    expect(html).toContain("var concertId = null;");
  });

  it("treats an empty-string PostHog host as unset instead of beaconing into the void", () => {
    const html = renderShowPage(jessicaPratt(), {
      requestOrigin: "https://wxyc.org",
      analytics: { projectKey: "phc_test123", host: "" },
    });
    expect(html).toContain("https://us.i.posthog.com/i/v0/e/");
  });

  it("rejects a scheme-less PostHog host — a relative endpoint would beacon into this Worker", () => {
    const html = renderShowPage(jessicaPratt(), {
      requestOrigin: "https://wxyc.org",
      analytics: { projectKey: "phc_test123", host: "us.i.posthog.com" },
    });
    expect(html).toContain("https://us.i.posthog.com/i/v0/e/");
    expect(html).not.toContain('"us.i.posthog.com/i/v0/e/"');
  });

  it("normalizes a whitespace-padded PostHog host — a mid-URL space throws client-side", () => {
    const html = renderShowPage(jessicaPratt(), {
      requestOrigin: "https://wxyc.org",
      analytics: { projectKey: "phc_test123", host: "https://eu.i.posthog.com " },
    });
    expect(html).toContain('"https://eu.i.posthog.com/i/v0/e/"');
  });
});

describe("degraded error page og:image", () => {
  it("points og:image at the serving origin, not a hardcoded apex", () => {
    const html = renderUpstreamErrorPage({
      requestOrigin: "https://wxyc-links-registry.workers.dev",
    });
    expect(html).toContain(
      'property="og:image" content="https://wxyc-links-registry.workers.dev/shows/og-card.png"'
    );
  });

  it("still renders with no options at all — the top-level catch depends on it", () => {
    const html = renderUpstreamErrorPage();
    expect(html).toContain("trouble loading this show");
    expect(html).toContain('property="og:image" content="https://wxyc.org/shows/og-card.png"');
  });
});
