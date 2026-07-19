// aasa.test.ts
//
// The AASA contract from WXYC/wxyc-links-registry#1: served at exactly
// /.well-known/apple-app-site-association with Content-Type application/json,
// HTTP 200, no redirect, and the applinks body verbatim. Exactness matters
// twice over — Apple's CDN rejects redirects, and anything broader than the
// exact path would shadow GitHub Pages' ACME cert-renewal challenges under
// /.well-known/acme-challenge/*.

import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardOutboundFetch } from "./helpers";

const worker = exports.default;
const AASA_URL = "https://wxyc.org/.well-known/apple-app-site-association";

// The AASA path never talks to the network; the guard proves it.
beforeEach(() => {
  guardOutboundFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AASA route", () => {
  it("serves the applinks association verbatim with application/json and no redirect", async () => {
    const response = await worker.fetch(AASA_URL, { redirect: "manual" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toEqual({
      applinks: {
        details: [
          {
            // Release and Debug bundle ids: Debug is Xcode's default run
            // configuration, and developer-mode testing does not waive appID
            // matching — omit it and every dev-build tap opens Safari.
            appIDs: ["92V374HC38.org.wxyc.iphoneapp", "92V374HC38.org.wxyc.iphoneappdebug"],
            components: [
              // Ordered: the OG image is an asset, not a share page — it must
              // fall through to the browser, so its exclude precedes the wildcard.
              { "/": "/shows/og-card.png", exclude: true },
              { "/": "/shows/*" },
            ],
          },
        ],
      },
    });
  });

  it("marks the association cacheable (dj-site AASA precedent: an hour)", async () => {
    const response = await worker.fetch(AASA_URL);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("answers HEAD like GET, minus the body", async () => {
    const response = await worker.fetch(AASA_URL, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("does not answer on near-miss paths — the route is exact", async () => {
    for (const path of [
      "/.well-known/apple-app-site-association/",
      "/.well-known/apple-app-site-association.json",
      "/apple-app-site-association",
    ]) {
      const response = await worker.fetch(`https://wxyc.org${path}`);
      expect(response.status, path).toBe(404);
    }
  });

  it("stays out of the ACME renewal path (GitHub Pages origin traffic)", async () => {
    const response = await worker.fetch("https://wxyc.org/.well-known/acme-challenge/token123");
    expect(response.status).toBe(404);
  });

  it("rejects mutating methods", async () => {
    const response = await worker.fetch(AASA_URL, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("has no business on the rest of the apex", async () => {
    const response = await worker.fetch("https://wxyc.org/");
    expect(response.status).toBe(404);
  });
});
