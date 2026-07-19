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
import { ogCardResponse } from "./og-card";
import {
  renderNotFoundPage,
  renderShowPage,
  renderUpstreamErrorPage,
  type AnalyticsConfig,
} from "./render";
import { fetchConcert } from "./upstream";

const AASA_PATH = "/.well-known/apple-app-site-association";
const OG_CARD_PATH = "/shows/og-card.png";

/** Leading integer, then anything without a slash, then an optional slash. */
const SHOW_PATH_PATTERN = /^\/shows\/([0-9]+)([^/]*)\/?$/;

/** The concerts PK is a PostgreSQL int4; beyond it, no show can exist. */
const MAX_CONCERT_ID = 2_147_483_647;

function htmlResponse(body: string, status: number, cacheControl: string): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": cacheControl,
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

async function handleShowPage(id: number, url: URL, env: Env): Promise<Response> {
  const renderOptions = { requestOrigin: url.origin, analytics: analyticsFromEnv(env) };

  const lookup = await fetchConcert(id, env);
  switch (lookup.kind) {
    case "ok":
      return htmlResponse(renderShowPage(lookup.concert, renderOptions), 200, "public, max-age=300");
    case "not_found":
      return htmlResponse(renderNotFoundPage(renderOptions), 404, "public, max-age=60");
    case "upstream_error":
      return htmlResponse(renderUpstreamErrorPage(), 502, "no-store");
  }
}

function handleShows(url: URL, env: Env): Promise<Response> | Response {
  if (url.pathname === OG_CARD_PATH) return ogCardResponse();

  const match = SHOW_PATH_PATTERN.exec(url.pathname);
  if (match !== null) {
    const digits = match[1] ?? "";
    const rest = match[2] ?? "";
    const canonicalId = digits.replace(/^0+/, "") || "0";

    // Slugs, trailing slashes, dangling hyphens, and leading zeros all
    // canonicalize to the bare /shows/<id> — one URL per show, everywhere.
    if (rest !== "" || url.pathname.endsWith("/") || canonicalId !== digits) {
      return new Response(null, {
        status: 301,
        headers: {
          location: `${url.origin}/shows/${canonicalId}`,
          "cache-control": "public, max-age=3600",
        },
      });
    }

    const id = Number(canonicalId);
    if (id >= 1 && id <= MAX_CONCERT_ID) {
      return handleShowPage(id, url, env);
    }
  }

  const renderOptions = { requestOrigin: url.origin, analytics: analyticsFromEnv(env) };
  return htmlResponse(renderNotFoundPage(renderOptions), 404, "public, max-age=60");
}

function handle(request: Request, env: Env): Promise<Response> | Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }

  const url = new URL(request.url);

  if (url.pathname === AASA_PATH) return aasaResponse();

  if (url.pathname === "/shows" || url.pathname.startsWith("/shows/")) {
    return handleShows(url, env);
  }

  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch {
      // Belt and braces: a rendering bug degrades to the static error page,
      // never a raw Worker exception. renderUpstreamErrorPage interpolates
      // nothing, so it cannot itself throw.
      return htmlResponse(renderUpstreamErrorPage(), 502, "no-store");
    }
  },
} satisfies ExportedHandler<Env>;
