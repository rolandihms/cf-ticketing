import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("../../packages/db/migrations/sqlite");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        // Never reach real Cloudflare services (Workers AI) from tests; LLM steps are mocked.
        remoteBindings: false,
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            API_TOKEN: "test-token",
            // Integrations on, pointed at fakes (globalThis.fetch is stubbed in tests).
            GITHUB_REPO: "acme/app",
            GITHUB_TOKEN: "test-gh-token",
            WEBHOOK_URL: "https://hooks.test/helpdesk",
            WEBHOOK_SECRET: "test-webhook-secret",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
