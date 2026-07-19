import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Runs the whole suite inside workerd via the Workers Vitest integration; the
// Worker under test (wrangler.toml `main`) shares the test isolate, so tests
// mock upstream traffic by spying on `globalThis.fetch`.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
    }),
  ],
});
