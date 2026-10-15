import { Kysely } from "kysely";
import { D1Dialect } from "./d1-dialect";
import { D1Repo, type HelpdeskRepo } from "./repo";
import type { Database } from "./schema";
import type { DbDriver } from "./types";

/**
 * Build-time driver selection. Set in wrangler.jsonc:
 *   "define": { "__HELPDESK_DB_DRIVER__": "\"d1\"" }   // d1 | postgres | mysql | planetscale | all
 * esbuild replaces the identifier with the literal and removes the branches (and their dynamic
 * imports) for every other driver, so a D1 build ships none of pg / mysql2 / PlanetScale.
 * "all" bundles every driver and lets the DB_DRIVER var choose at runtime.
 */
declare const __HELPDESK_DB_DRIVER__: string;

/**
 * Environment the repo factory reads. Only the bindings for the chosen driver need to exist.
 * - d1:          DB (D1 binding)
 * - postgres:    HYPERDRIVE (Hyperdrive binding) or DATABASE_URL
 * - mysql:       HYPERDRIVE (Hyperdrive binding, MySQL origin) or DATABASE_URL
 * - planetscale: DATABASE_URL (mysql://user:pass@host/db), uses the HTTP driver
 */
export interface DbEnv {
  DB_DRIVER?: string;
  DB?: D1Database;
  HYPERDRIVE?: { connectionString: string };
  DATABASE_URL?: string;
}

const DRIVERS: DbDriver[] = ["d1", "postgres", "mysql", "planetscale"];

/** The driver baked in at build time, or "all". Falls back to "all" outside a wrangler build. */
export function buildDriver(): DbDriver | "all" {
  return typeof __HELPDESK_DB_DRIVER__ === "string" ? (__HELPDESK_DB_DRIVER__ as DbDriver | "all") : "all";
}

/** Runtime driver: DB_DRIVER if set, otherwise the build-time driver (d1 for an "all" build). */
export function driverOf(env: DbEnv): DbDriver {
  const built = buildDriver();
  const d = (env.DB_DRIVER || (built === "all" ? "d1" : built)).toLowerCase() as DbDriver;
  if (!DRIVERS.includes(d)) {
    throw new Error(`Unsupported DB_DRIVER "${env.DB_DRIVER}" (expected ${DRIVERS.join(" | ")})`);
  }
  if (built !== "all" && d !== built) {
    throw new Error(
      `DB_DRIVER=${d} but this Worker was built with only the "${built}" driver. ` +
        `Set "define": { "__HELPDESK_DB_DRIVER__": "\\"${d}\\"" } in wrangler.jsonc (or "\\"all\\"") and redeploy.`,
    );
  }
  return d;
}

function connectionString(env: DbEnv, driver: DbDriver): string {
  const url = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!url) throw new Error(`DB_DRIVER=${driver} needs a HYPERDRIVE binding or DATABASE_URL secret`);
  return url;
}

/**
 * Create a repository for the configured driver. Call `repo.close()` when done (no-op on D1).
 * Each non-D1 branch compares the define directly so esbuild can fold it and drop the import.
 * The `typeof` guard keeps this usable without a define (Node, other bundlers): everything is included.
 */
export async function createRepo(env: DbEnv): Promise<HelpdeskRepo> {
  const driver = driverOf(env);
  if (driver === "d1") {
    if (!env.DB) throw new Error("DB_DRIVER=d1 needs a D1 binding named DB");
    return new D1Repo(env.DB, new Kysely<Database>({ dialect: new D1Dialect(env.DB) }));
  }
  if ((typeof __HELPDESK_DB_DRIVER__ === "undefined" || __HELPDESK_DB_DRIVER__ === "postgres" || __HELPDESK_DB_DRIVER__ === "all") && driver === "postgres") {
    const { createPostgresRepo } = await import("./drivers/postgres");
    return createPostgresRepo(connectionString(env, driver));
  }
  if ((typeof __HELPDESK_DB_DRIVER__ === "undefined" || __HELPDESK_DB_DRIVER__ === "mysql" || __HELPDESK_DB_DRIVER__ === "all") && driver === "mysql") {
    const { createMysqlRepo } = await import("./drivers/mysql");
    return createMysqlRepo(connectionString(env, driver));
  }
  if ((typeof __HELPDESK_DB_DRIVER__ === "undefined" || __HELPDESK_DB_DRIVER__ === "planetscale" || __HELPDESK_DB_DRIVER__ === "all") && driver === "planetscale") {
    if (!env.DATABASE_URL) throw new Error("DB_DRIVER=planetscale needs a DATABASE_URL secret");
    const { createPlanetScaleRepo } = await import("./drivers/planetscale");
    return createPlanetScaleRepo(env.DATABASE_URL);
  }
  throw new Error(`driver "${driver}" is not included in this build`);
}

/** Run `fn` with a repo and always release its connections. */
export async function withRepo<T>(env: DbEnv, fn: (repo: HelpdeskRepo) => Promise<T>): Promise<T> {
  const repo = await createRepo(env);
  try {
    return await fn(repo);
  } finally {
    await repo.close();
  }
}
