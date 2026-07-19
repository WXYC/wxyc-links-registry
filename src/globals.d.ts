// globals.d.ts
//
// Wires this Worker's shapes into the ambient `Cloudflare` namespace that
// @cloudflare/workers-types consults: `Cloudflare.Env` types `env` everywhere
// (including `import { env } from "cloudflare:workers"` in tests), and
// `GlobalProps.mainModule` types `exports.default.fetch()` for integration
// tests. Hand-authored equivalent of `wrangler types` output.

import type { Env as WorkerEnv } from "./env";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
    interface GlobalProps {
      mainModule: typeof import("./index");
    }
  }
}

export {};
