// format.test.ts
//
// Unit tests for the share page's formatting and safety helpers: HTML
// escaping (every upstream string transits it), outbound-URL sanitization
// (upstream URLs are external data — javascript:/data: schemes must die
// here), venue-local date/time rendering, price ranges, and the
// og:description composition the unfurl cards are authored from.

import { describe, expect, it } from "vitest";
import {
  buildDescription,
  directionsUrl,
  escapeHtml,
  formatEventDate,
  formatPrice,
  formatTimeNY,
  initialGrapheme,
  isPast,
  ogTitle,
  safeHttpUrl,
} from "../src/format";
import type { Concert } from "../src/concert";
import { makeJessicaPratt } from "./helpers";

/** The shared fixture pinned to a fixed id and 2026 dates for the injected now. */
function jessicaPratt(overrides: Partial<Concert> = {}): Concert {
  return makeJessicaPratt({
    id: 4821,
    starts_on: "2026-08-01",
    starts_at: "2026-08-02T00:00:00.000Z",
    doors_at: "2026-08-01T23:00:00.000Z",
    ...overrides,
  });
}

const now = new Date("2026-07-18T21:00:00.000Z");

describe("escapeHtml", () => {
  it("escapes the five HTML metacharacters", () => {
    expect(escapeHtml(`<script>alert("x&y'z")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&amp;y&#39;z&quot;)&lt;/script&gt;"
    );
  });

  it("passes ordinary band names through untouched", () => {
    expect(escapeHtml("Nilüfer Yanya")).toBe("Nilüfer Yanya");
  });
});

describe("safeHttpUrl", () => {
  it("accepts absolute http(s) URLs", () => {
    expect(safeHttpUrl("https://catscradle.com/event/1")).toBe("https://catscradle.com/event/1");
    expect(safeHttpUrl("http://local506.com")).toBe("http://local506.com/");
  });

  it("rejects script-scheme and non-http URLs", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,<script>")).toBeNull();
    expect(safeHttpUrl("vbscript:x")).toBeNull();
    expect(safeHttpUrl("//catscradle.com/event")).toBeNull();
    expect(safeHttpUrl("/relative/path")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});

describe("formatEventDate", () => {
  it("renders the venue-local calendar date without a year when it is this year", () => {
    expect(formatEventDate("2026-08-01", now)).toBe("Sat, Aug 1");
  });

  it("appends the year when the show is in another year", () => {
    expect(formatEventDate("2027-03-05", now)).toBe("Fri, Mar 5, 2027");
  });
});

describe("formatTimeNY", () => {
  it("renders whole hours without minutes, in venue-local Eastern time", () => {
    // 23:00 UTC on Aug 1 is 7 PM EDT.
    expect(formatTimeNY("2026-08-01T23:00:00.000Z")).toBe("7 PM");
  });

  it("keeps minutes when they are non-zero", () => {
    expect(formatTimeNY("2026-08-02T00:30:00.000Z")).toBe("8:30 PM");
  });

  it("respects standard time in winter", () => {
    // 00:00 UTC on Dec 16 is 7 PM EST on Dec 15.
    expect(formatTimeNY("2026-12-16T00:00:00.000Z")).toBe("7 PM");
  });
});

describe("formatPrice", () => {
  it("renders a range with a dollar sign on both numbers, like the app's priceLabel", () => {
    expect(formatPrice(22, 25)).toBe("$22–$25");
  });

  it("renders a single price", () => {
    expect(formatPrice(22, null)).toBe("$22");
    expect(formatPrice(null, 30)).toBe("$30");
  });

  it("keeps cents only when they exist", () => {
    expect(formatPrice(22.5, null)).toBe("$22.50");
  });

  it("labels free shows Free (price_min = 0 per the API contract)", () => {
    expect(formatPrice(0, null)).toBe("Free");
    expect(formatPrice(0, 0)).toBe("Free");
  });

  it("returns null when no price is known", () => {
    expect(formatPrice(null, null)).toBeNull();
  });
});

describe("isPast", () => {
  it("treats earlier venue-local dates as passed", () => {
    expect(isPast("2026-07-17", now)).toBe(true);
  });

  it("keeps today and future dates live", () => {
    // now is 2026-07-18T21:00Z = 5 PM EDT on Jul 18.
    expect(isPast("2026-07-18", now)).toBe(false);
    expect(isPast("2026-07-19", now)).toBe(false);
  });
});

describe("ogTitle", () => {
  it("composes artist at venue with the station credit", () => {
    expect(ogTitle(jessicaPratt())).toBe("Jessica Pratt at Cat's Cradle — WXYC");
  });
});

describe("buildDescription", () => {
  it("composes date · doors · price · age plus the station credit", () => {
    expect(buildDescription(jessicaPratt(), now)).toBe(
      "Sat, Aug 1 · Doors 7 PM · $22–$25 · All Ages. Heard on WXYC 89.3 FM Chapel Hill."
    );
  });

  it("omits unknown segments instead of writing placeholders", () => {
    const sparse = jessicaPratt({
      doors_at: null,
      starts_at: null,
      price_min: null,
      price_max: null,
      age_restriction: null,
    });
    expect(buildDescription(sparse, now)).toBe("Sat, Aug 1. Heard on WXYC 89.3 FM Chapel Hill.");
  });

  it("falls back to the show time when doors are unknown", () => {
    const noDoors = jessicaPratt({ doors_at: null });
    expect(buildDescription(noDoors, now)).toBe(
      "Sat, Aug 1 · 8 PM · $22–$25 · All Ages. Heard on WXYC 89.3 FM Chapel Hill."
    );
  });

  it("leads with the lifecycle state when it is not on sale", () => {
    expect(buildDescription(jessicaPratt({ status: "cancelled" }), now)).toMatch(/^Cancelled · /);
    expect(buildDescription(jessicaPratt({ status: "sold_out" }), now)).toMatch(/^Sold out · /);
    expect(buildDescription(jessicaPratt({ status: "rescheduled" }), now)).toMatch(
      /^Rescheduled · /
    );
  });

  it("leads with the passed notice for shows that already happened", () => {
    const past = jessicaPratt({ starts_on: "2026-06-13" });
    expect(buildDescription(past, now)).toMatch(/^This one's passed · /);
  });
});

describe("directionsUrl", () => {
  it("mirrors the app's Apple Maps search query: name, address, city, state", () => {
    const url = directionsUrl(jessicaPratt());
    expect(url).toBe(
      "https://maps.apple.com/?q=Cat's%20Cradle%2C%20300%20E%20Main%20St%2C%20Carrboro%2C%20NC%2027510%2C%20Carrboro%2C%20NC"
    );
  });

  it("skips the address when the venue has none", () => {
    const bare = jessicaPratt();
    bare.venue = { ...bare.venue, address: null };
    expect(directionsUrl(bare)).toBe("https://maps.apple.com/?q=Cat's%20Cradle%2C%20Carrboro%2C%20NC");
  });
});

describe("initialGrapheme", () => {
  it("takes the first grapheme of the headliner, uppercased", () => {
    expect(initialGrapheme("Jessica Pratt")).toBe("J");
    expect(initialGrapheme("of Montreal")).toBe("O");
  });

  it("handles diacritics and non-Latin initials", () => {
    expect(initialGrapheme("Csillagrablók")).toBe("C");
    expect(initialGrapheme("坂本龍一")).toBe("坂");
  });

  it("falls back to a music note for blank billing", () => {
    expect(initialGrapheme("  ")).toBe("♪");
  });
});
