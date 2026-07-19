// index.ts
//
// The wxyc.org universal-link Worker (WXYC/wxyc-links-registry#1). Exactly
// two things are its business, matching the two production route patterns in
// wrangler.toml:
//
//   1. GET /.well-known/apple-app-site-association — the applinks AASA,
//      exact path only (never a /.well-known/* wildcard: GitHub Pages' ACME
//      cert renewals transit /.well-known/acme-challenge/* and must keep
//      passing through to the origin).
//   2. GET /shows/<id> — OG-tagged share pages for On Tour concerts
//      (trailing-slash and zero-padded forms canonicalize to the bare id;
//      slugged or otherwise decorated paths 404 — nothing emits them),
//      backed by Backend-Service `GET /concerts/:id` with ~5-minute edge
//      caching. /shows/og-card.png serves the static OG image inside the
//      same route space.
//
// Everything else 404s here; in production it never arrives (the routes are
// exact), and on workers.dev the 404 keeps probes out of the way.

import { aasaResponse } from "./aasa";
import { MAX_CONCERT_ID } from "./concert";
import type { Env } from "./env";
import { OG_CARD_PATH, ogCardResponse } from "./og-card";
import {
  renderNotFoundPage,
  renderShowPage,
  renderUpstreamErrorPage,
  type AnalyticsConfig,
  type RenderOptions,
} from "./render";
import { fetchConcert } from "./upstream";

const AASA_PATH = "/.well-known/apple-app-site-association";

/**
 * A bare integer id with at most an optional trailing slash. Deliberately
 * nothing looser: slugged or otherwise decorated paths are not this Worker's
 * to interpret — nothing emits them, and the planned /shows calendar dispatch
 * (triangle-shows) needs every non-id path left untouched. The pattern has no
 * adjacent overlapping quantifiers, so it cannot backtrack quadratically.
 */
const SHOW_PATH_PATTERN = /^\/shows\/([0-9]+)\/?$/;

/** Longer than any real /shows path; refusing early keeps junk input cheap. */
const MAX_PATH_LENGTH = 256;

function htmlResponse(body: string, status: number, cacheControl: string): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}

function analyticsFromEnv(env: Env): AnalyticsConfig | undefined {
  if (env.POSTHOG_PROJECT_KEY === undefined || env.POSTHOG_PROJECT_KEY === "") return undefined;
  return { projectKey: env.POSTHOG_PROJECT_KEY, host: env.POSTHOG_API_HOST };
}

function notFoundResponse(renderOptions: RenderOptions): Response {
  return htmlResponse(renderNotFoundPage(renderOptions), 404, "public, max-age=60");
}

function upstreamErrorResponse(renderOptions: Partial<RenderOptions>): Response {
  return htmlResponse(renderUpstreamErrorPage(renderOptions), 502, "no-store");
}

async function handleShowPage(
  id: number,
  renderOptions: RenderOptions,
  env: Env
): Promise<Response> {
  const lookup = await fetchConcert(id, env);
  switch (lookup.kind) {
    case "ok":
      return htmlResponse(renderShowPage(lookup.concert, renderOptions), 200, "public, max-age=300");
    case "not_found":
      return notFoundResponse(renderOptions);
    case "upstream_error":
      return upstreamErrorResponse(renderOptions);
  }
}

function handleShows(url: URL, env: Env): Promise<Response> | Response {
  const renderOptions = { requestOrigin: url.origin, analytics: analyticsFromEnv(env) };
  const notFound = (): Response => notFoundResponse(renderOptions);

  // The asset route matches the path AS SENT: the AASA excludes exactly this
  // literal spelling, so a percent-encoded alias must 404 like other junk —
  // serving it would hand iOS a universal link the exclude never covers.
  if (url.pathname === OG_CARD_PATH) return ogCardResponse();

  if (url.pathname.length > MAX_PATH_LENGTH) return notFound();

  // Ids match the raw path first; percent-decoding is an id-resolution
  // fallback only (`%34821` is show 34821, never a truncated redirect).
  // Paths that are not ids fall through UNTRANSFORMED — the rest of the
  // namespace is reserved for the future calendar dispatch, which must see
  // raw paths. Sequences that do not decode are junk.
  let pathname = url.pathname;
  let match = SHOW_PATH_PATTERN.exec(pathname);
  if (match === null && pathname.includes("%")) {
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return notFound();
    }
    match = SHOW_PATH_PATTERN.exec(pathname);
  }
  if (match === null) return notFound();

  const digits = match[1] ?? "";
  const canonicalId = digits.replace(/^0+/, "") || "0";

  // Trailing slashes and leading zeros canonicalize to the bare
  // /shows/<id> — one URL per show, everywhere. The query string rides
  // along so attribution params survive the hop.
  if (pathname.endsWith("/") || canonicalId !== digits) {
    return new Response(null, {
      status: 301,
      headers: {
        location: `${url.origin}/shows/${canonicalId}${url.search}`,
        "cache-control": "public, max-age=3600",
        "x-content-type-options": "nosniff",
      },
    });
  }

  const id = Number(canonicalId);
  if (id >= 1 && id <= MAX_CONCERT_ID) {
    return handleShowPage(id, renderOptions, env);
  }
  // Digit-shaped but impossible (zero, beyond the int4 PK): still a show-
  // namespace miss. The fallthrough above must keep meaning exactly "not an
  // id at all" so the future proxy branch swaps in cleanly.
  return notFound();
}

function handle(request: Request, env: Env): Promise<Response> | Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD", "x-content-type-options": "nosniff" },
    });
  }

  const url = new URL(request.url);

  if (url.pathname === AASA_PATH) return aasaResponse();

  // Bare /shows deliberately falls through: the production route pattern
  // `wxyc.org/shows/*` never matches it (Cloudflare patterns are literal, so
  // it reaches the origin), and the Worker must not pretend otherwise on
  // hosts where every path arrives here.
  if (url.pathname.startsWith("/shows/")) {
    return handleShows(url, env);
  }

  return new Response("Not found", {
    status: 404,
    headers: { "x-content-type-options": "nosniff" },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch {
      // Belt and braces: a rendering bug degrades to the error page, never a
      // raw Worker exception. The page interpolates only throw-proof values
      // (request.url is always a valid absolute URL in workerd, and the
      // analytics config is a pair of env strings), and the plain-text
      // fallback covers even a failure of the error page itself — degraded
      // traffic stays measurable rather than vanishing from analytics.
      try {
        return upstreamErrorResponse({
          requestOrigin: new URL(request.url).origin,
          analytics: analyticsFromEnv(env),
        });
      } catch {
        return new Response("Service error", {
          status: 502,
          headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
        });
      }
    }
  },
} satisfies ExportedHandler<Env>;
