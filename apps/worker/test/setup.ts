import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
      API_TOKEN: string;
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
