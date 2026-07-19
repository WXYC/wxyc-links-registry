// upstream.ts
//
// Fetches concerts from Backend-Service's public `GET /concerts/:id` with
// edge caching. Failures are values, not exceptions: the router maps them
// onto the not-found and degraded pages.
//
// Ordering and header rules here are load-bearing:
//   1. Validate before caching. A 200 whose body does not decode into a
//      Concert is never written to the cache — otherwise one junk response
//      (maintenance page, schema drift) would pin five minutes of 502s per
//      colo after upstream has already recovered.
//   2. Never copy upstream headers onto a rebuilt entry. The body is stored
//      as decoded text, so a passed-through content-encoding would mislabel
//      it (every hit reads garbage and the cache degrades to passthrough),
//      a set-cookie makes the Cache API silently refuse the write, and the
//      original content-length lies. The entry carries exactly what this
//      module needs: content-type and a bounded cache-control.
//   3. Bound the wait and the staleness. The upstream fetch carries an abort
//      timeout, and stored entries get an explicit TTL (upstream's max-age
//      capped at 300s; 300s when upstream is silent) so a dropped upstream
//      header can never pin entries for a runtime-default lifetime. 404s are
//      negatively cached for 60s so a dead shared link cannot hammer the API.

import { parseConcert, type Concert } from "./concert";
import type { Env } from "./env";

const DEFAULT_API_ORIGIN = "https://api.wxyc.org";

/** How long to wait on Backend-Service before serving the degraded page. */
const UPSTREAM_TIMEOUT_MS = 5_000;

/** Ceiling (and silent-upstream default) for positive entries, seconds. */
const POSITIVE_TTL_CAP_S = 300;

/** Damping TTL for upstream 404s, seconds. */
const NEGATIVE_TTL_S = 60;

/** The outcome of a concert lookup, for the router to map onto pages. */
export type ConcertLookup =
  | { kind: "ok"; concert: Concert }
  | { kind: "not_found" }
  | { kind: "upstream_error" };

/**
 * The API origin, defended against silent-outage misconfigurations. The
 * value must be a PURE http(s) origin: padding and trailing slashes are
 * tolerated and normalized away, but query/fragment/path residue means the
 * composed `/concerts/:id` would land somewhere else entirely, so anything
 * impure falls back to the default and the share surface stays up. The
 * return value is derived from the PARSED URL (`url.origin`), never the
 * configured string — WHATWG parsing strips edge whitespace, so validating
 * the raw string would bless a padded value the composed URL chokes on.
 */
function apiOrigin(env: Env): string {
  const configured = env.CONCERTS_API_ORIGIN;
  if (configured === undefined) return DEFAULT_API_ORIGIN;
  const trimmed = configured.trim().replace(/\/+$/, "");
  if (trimmed === "") return DEFAULT_API_ORIGIN;
  try {
    const url = new URL(trimmed);
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    ) {
      return url.origin;
    }
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
 * The cache-control for a rebuilt positive entry: upstream's max-age capped
 * at the ceiling, the ceiling itself when upstream is silent, and null (do
 * not cache) when upstream says no-store, no-cache, or private.
 */
function positiveCacheControl(fetched: Response): string | null {
  const upstream = fetched.headers.get("cache-control") ?? "";
  // no-cache means revalidate-before-use; with no conditional-request
  // machinery here, that collapses to do-not-serve-from-cache — and it is
  // the standard knob an operator flips mid-incident to stop stale serving.
  if (/no-store|no-cache|private/i.test(upstream)) return null;
  const maxAge = /max-age=(\d+)/i.exec(upstream);
  const ttl = Math.min(maxAge === null ? POSITIVE_TTL_CAP_S : Number(maxAge[1]), POSITIVE_TTL_CAP_S);
  return `public, max-age=${ttl}`;
}

/**
 * Looks up a concert by id: edge cache first, then the API. Only a 200 whose
 * body decodes is positively cached; upstream 404s are negatively cached for
 * a minute; any other status, a timeout, a network failure, or an
 * undecodable body maps to `upstream_error` and is never cached.
 */
export async function fetchConcert(id: number, env: Env): Promise<ConcertLookup> {
  const upstreamUrl = `${apiOrigin(env)}/concerts/${id}`;
  const cache = caches.default;

  const cached = await cache.match(upstreamUrl);
  if (cached !== undefined) {
    // Negative entries are checked before any body work — their bodies are
    // empty and must not fall into the undecodable-entry recovery below.
    if (cached.status === 404) return { kind: "not_found" };
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

  if (fetched.status === 404) {
    try {
      await cache.put(
        upstreamUrl,
        new Response(null, {
          status: 404,
          headers: { "cache-control": `public, max-age=${NEGATIVE_TTL_S}` },
        })
      );
    } catch {
      // An unstorable sentinel just means the next request re-asks upstream.
    }
    return { kind: "not_found" };
  }
  if (fetched.status !== 200) return { kind: "upstream_error" };

  let body: string;
  try {
    body = await fetched.text();
  } catch {
    return { kind: "upstream_error" };
  }
  const concert = decodeConcert(body);
  if (concert === null) return { kind: "upstream_error" };

  const cacheControl = positiveCacheControl(fetched);
  if (cacheControl !== null) {
    const headers = new Headers({ "cache-control": cacheControl });
    const contentType = fetched.headers.get("content-type");
    if (contentType !== null) headers.set("content-type", contentType);
    try {
      // The body is already buffered, so the awaited put costs only the
      // cache write — and the next request is guaranteed to see it.
      await cache.put(upstreamUrl, new Response(body, { headers }));
    } catch {
      // A response the cache refuses is still a response we can render.
    }
  }
  return { kind: "ok", concert };
}
