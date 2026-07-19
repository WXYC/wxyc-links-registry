// env.ts
//
// The Worker's binding contract. Every binding is optional and defaulted in
// code so a bare checkout runs (and tests run) with zero configuration; set
// real values per-environment in wrangler.toml `[env.<name>.vars]` or via
// `wrangler secret put`.

/** Bindings read by the Worker. */
export interface Env {
  /** Backend-Service origin for `GET /concerts/:id`. Default: https://api.wxyc.org */
  CONCERTS_API_ORIGIN?: string;
  /**
   * PostHog project API key (`phc_...`). When unset — the default — the share
   * pages ship no analytics snippet at all.
   */
  POSTHOG_PROJECT_KEY?: string;
  /** PostHog ingest host. Default: https://us.i.posthog.com */
  POSTHOG_API_HOST?: string;
}
