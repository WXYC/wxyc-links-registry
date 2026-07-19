// upstream.ts
//
// Fetches concerts from Backend-Service's public `GET /concerts/:id` with
// edge caching. The upstream answers `Cache-Control: public, max-age=300`,
// and `caches.default.put` honors exactly that — so a share spike hits the
// API once per ~5 minutes per show, and the page keeps rendering from cache
// while the header allows. Failures are values, not exceptions: the router
// maps them onto the not-found and degraded pages.

import { parseConcert, type Concert } from "./concert";
import type { Env } from "./env";

const DEFAULT_API_ORIGIN = "https://api.wxyc.org";

/** The outcome of a concert lookup, for the router to map onto pages. */
export type ConcertLookup =
  | { kind: "ok"; concert: Concert }
  | { kind: "not_found" }
  | { kind: "upstream_error" };

/**
 * Looks up a concert by id: edge cache first, then the API. A 200 is cached
 * per its Cache-Control; a 404 maps to `not_found`; any other status, a
 * network failure, or an undecodable body maps to `upstream_error`.
 */
export async function fetchConcert(id: number, env: Env): Promise<ConcertLookup> {
  const origin = env.CONCERTS_API_ORIGIN ?? DEFAULT_API_ORIGIN;
  const upstreamUrl = `${origin}/concerts/${id}`;
  const cache = caches.default;

  let response = await cache.match(upstreamUrl);
  if (response === undefined) {
    let fetched: Response;
    try {
      fetched = await fetch(upstreamUrl, { headers: { accept: "application/json" } });
    } catch {
      return { kind: "upstream_error" };
    }
    if (fetched.status === 200) {
      try {
        // Honors the upstream Cache-Control (max-age=300). Awaited so a
        // request's cache write is visible to the next request.
        await cache.put(upstreamUrl, fetched.clone());
      } catch {
        // A response the cache refuses is still a response we can render.
      }
    }
    response = fetched;
  }

  if (response.status === 404) return { kind: "not_found" };
  if (response.status !== 200) return { kind: "upstream_error" };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: "upstream_error" };
  }
  const concert = parseConcert(payload);
  return concert === null ? { kind: "upstream_error" } : { kind: "ok", concert };
}
