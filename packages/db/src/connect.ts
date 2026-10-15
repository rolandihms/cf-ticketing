import { Kysely, MysqlDialect, PostgresDialect } from "kysely";
import { D1Dialect } from "./d1-dialect";
import { D1Repo, type HelpdeskRepo, SqlRepo } from "./repo";
import type { Database } from "./schema";
import type { DbDriver } from "./types";

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

export function driverOf(env: DbEnv): DbDriver {
  const d = (env.DB_DRIVER || "d1").toLowerCase();
  if (d === "d1" || d === "postgres" || d === "mysql" || d === "planetscale") return d;
  throw new Error(`Unsupported DB_DRIVER "${env.DB_DRIVER}" (expected d1 | postgres | mysql | planetscale)`);
}

function connectionString(env: DbEnv, driver: DbDriver): string {
  const url = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!url) throw new Error(`DB_DRIVER=${driver} needs a HYPERDRIVE binding or DATABASE_URL secret`);
  return url;
}

/**
 * Create a repository for the configured driver. Drivers are imported lazily so a D1 deployment
 * never *initialises* pg/mysql2 — but note they are still bundled (~1.4 MB) because wrangler emits a
 * single chunk; see docs/DATABASE.md "Bundle size". Call `repo.close()` when done (no-op on D1).
 */
export async function createRepo(env: DbEnv): Promise<HelpdeskRepo> {
  const driver = driverOf(env);
  switch (driver) {
    case "d1": {
      if (!env.DB) throw new Error("DB_DRIVER=d1 needs a D1 binding named DB");
      return new D1Repo(env.DB, new Kysely<Database>({ dialect: new D1Dialect(env.DB) }));
    }
    case "postgres": {
      const pg = await import("pg");
      const Pool = pg.Pool ?? pg.default.Pool;
      const globalTypes = pg.types ?? pg.default.types;
      // BIGINT (int8) comes back as string by default; our timestamps fit in a JS number.
      // Per-pool override, so we don't mutate pg's process-global parser registry.
      const types = {
        getTypeParser: (oid: number, format?: "text" | "binary") =>
          oid === 20 ? (v: string) => Number(v) : globalTypes.getTypeParser(oid, format as "text"),
      };
      // Hyperdrive does the real pooling; a pool per invocation is what its docs recommend.
      const pool = new Pool({ connectionString: connectionString(env, driver), max: 2, types: types as never });
      return new SqlRepo(new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }), "postgres");
    }
    case "mysql": {
      const mysql = await import("mysql2");
      const createPool = mysql.createPool ?? mysql.default.createPool;
      const pool = createPool({ uri: connectionString(env, driver), connectionLimit: 2, disableEval: true } as never);
      return new SqlRepo(new Kysely<Database>({ dialect: new MysqlDialect({ pool }) }), "mysql");
    }
    case "planetscale": {
      const { PlanetScaleDialect } = await import("kysely-planetscale");
      const { cast } = await import("@planetscale/database");
      if (!env.DATABASE_URL) throw new Error("DB_DRIVER=planetscale needs a DATABASE_URL secret");
      const dialect = new PlanetScaleDialect({
        url: env.DATABASE_URL,
        // INT64 arrives as string; normalise to number like the other drivers. This replaces
        // kysely-planetscale's default date inflation, which we don't need (no DATETIME columns).
        cast: (field, value) => (field.type === "INT64" || field.type === "UINT64" ? (value == null ? null : Number(value)) : cast(field, value)),
      });
      return new SqlRepo(new Kysely<Database>({ dialect }), "mysql");
    }
  }
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
