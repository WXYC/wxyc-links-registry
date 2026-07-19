// upstream.ts
//
// Fetches concerts from Backend-Service's public `GET /concerts/:id` with
// edge caching. The upstream answers `Cache-Control: public, max-age=300`,
// and `caches.default.put` honors exactly that — so a share spike hits the
// API once per ~5 minutes per show, and the page keeps rendering from cache
// while the header allows. Failures are values, not exceptions: the router
// maps them onto the not-found and degraded pages.
//
// Two ordering rules are load-bearing here:
//   1. Validate before caching. A 200 whose body does not decode into a
//      Concert is never written to the cache — otherwise one junk response
//      (maintenance page, schema drift) would pin five minutes of 502s per
//      colo after upstream has already recovered.
//   2. Bound the wait. The upstream fetch carries an abort timeout so a
//      stalled connection degrades to the branded 502 page instead of
//      hanging past every unfurler's patience.

import { parseConcert, type Concert } from "./concert";
import type { Env } from "./env";

const DEFAULT_API_ORIGIN = "https://api.wxyc.org";

/** How long to wait on Backend-Service before serving the degraded page. */
const UPSTREAM_TIMEOUT_MS = 5_000;

/** The outcome of a concert lookup, for the router to map onto pages. */
export type ConcertLookup =
  | { kind: "ok"; concert: Concert }
  | { kind: "not_found" }
  | { kind: "upstream_error" };

/**
 * The API origin, defended against the two silent-outage misconfigurations:
 * a trailing slash would double-slash the path (which Express does not
 * match — every show would 404), and an empty or non-http(s) value would
 * build a relative URL that throws in the cache layer. Anything unusable
 * falls back to the default so the share surface stays up.
 */
function apiOrigin(env: Env): string {
  const configured = env.CONCERTS_API_ORIGIN;
  if (configured === undefined || configured === "") return DEFAULT_API_ORIGIN;
  const trimmed = configured.replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:" || url.protocol === "http:") return trimmed;
  } catch {
    // Fall through to the default below.
  }
  return DEFAULT_API_ORIGIN;
}

/** Decodes a response body into a Concert, or null when it is not usable. */
function decodeConcert(body: string): Concert | null {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  return parseConcert(payload);
}

/**
 * Looks up a concert by id: edge cache first, then the API. Only a 200 whose
 * body decodes is cached (per its Cache-Control); a 404 maps to `not_found`;
 * any other status, a timeout, a network failure, or an undecodable body maps
 * to `upstream_error`.
 */
export async function fetchConcert(id: number, env: Env): Promise<ConcertLookup> {
  const upstreamUrl = `${apiOrigin(env)}/concerts/${id}`;
  const cache = caches.default;

  const cached = await cache.match(upstreamUrl);
  if (cached !== undefined) {
    let body: string | null = null;
    try {
      body = await cached.text();
    } catch {
      // Treat an unreadable entry like an undecodable one below.
    }
    const concert = body === null ? null : decodeConcert(body);
    if (concert !== null) return { kind: "ok", concert };
    // Only validated bodies are written, so this is a foreign or stale entry;
    // drop it rather than let it pin failures until its TTL, and fall through
    // to a fresh upstream consult.
    try {
      await cache.delete(upstreamUrl);
    } catch {
      // Deletion is best-effort; the refetch below still answers this request.
    }
  }

  let fetched: Response;
  try {
    fetched = await fetch(upstreamUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return { kind: "upstream_error" };
  }
  if (fetched.status === 404) return { kind: "not_found" };
  if (fetched.status !== 200) return { kind: "upstream_error" };

  let body: string;
  try {
    body = await fetched.text();
  } catch {
    return { kind: "upstream_error" };
  }
  const concert = decodeConcert(body);
  if (concert === null) return { kind: "upstream_error" };

  try {
    // The body is already buffered, so the awaited put costs only the cache
    // write — and the next request is guaranteed to see it. Honors the
    // upstream Cache-Control (max-age=300).
    await cache.put(upstreamUrl, new Response(body, { headers: fetched.headers }));
  } catch {
    // A response the cache refuses is still a response we can render.
  }
  return { kind: "ok", concert };
}
