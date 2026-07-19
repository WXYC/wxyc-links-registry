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
//   2. GET /shows/<id>[-slug] — OG-tagged share pages for On Tour concerts,
//      canonicalized to the bare /shows/<id> form, backed by Backend-Service
//      `GET /concerts/:id` with ~5-minute edge caching. /shows/og-card.png
//      serves the static OG image inside the same route space.
//
// Everything else 404s here; in production it never arrives (the routes are
// exact), and on workers.dev the 404 keeps probes out of the way.

import { aasaResponse } from "./aasa";
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

/** The concerts PK is a PostgreSQL int4; beyond it, no show can exist. */
const MAX_CONCERT_ID = 2_147_483_647;

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
  return {
    projectKey: env.POSTHOG_PROJECT_KEY,
    ...(env.POSTHOG_API_HOST === undefined ? {} : { host: env.POSTHOG_API_HOST }),
  };
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
      return htmlResponse(renderNotFoundPage(renderOptions), 404, "public, max-age=60");
    case "upstream_error":
      return htmlResponse(renderUpstreamErrorPage(renderOptions), 502, "no-store");
  }
}

function handleShows(url: URL, env: Env): Promise<Response> | Response {
  const renderOptions = { requestOrigin: url.origin, analytics: analyticsFromEnv(env) };
  const notFound = (): Response =>
    htmlResponse(renderNotFoundPage(renderOptions), 404, "public, max-age=60");

  if (url.pathname.length > MAX_PATH_LENGTH) return notFound();

  // Unfurlers and pasted links sometimes percent-encode path characters, and
  // WHATWG pathnames arrive still-encoded; ids are matched against the decoded
  // form so `%34821` is show 34821, never a truncated redirect. Sequences that
  // do not decode are junk.
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return notFound();
  }

  if (pathname === OG_CARD_PATH) return ogCardResponse();

  const match = SHOW_PATH_PATTERN.exec(pathname);
  if (match !== null) {
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
        },
      });
    }

    const id = Number(canonicalId);
    if (id >= 1 && id <= MAX_CONCERT_ID) {
      return handleShowPage(id, renderOptions, env);
    }
  }

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

  if (url.pathname === "/shows" || url.pathname.startsWith("/shows/")) {
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
      // (an origin string), and the plain-text fallback below covers even a
      // failure of the error page itself.
      try {
        let origin: string | undefined;
        try {
          origin = new URL(request.url).origin;
        } catch {
          origin = undefined;
        }
        return htmlResponse(
          renderUpstreamErrorPage(origin === undefined ? {} : { requestOrigin: origin }),
          502,
          "no-store"
        );
      } catch {
        return new Response("Service error", {
          status: 502,
          headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
        });
      }
    }
  },
} satisfies ExportedHandler<Env>;
