import { cast } from "@planetscale/database";
import { Kysely } from "kysely";
import { PlanetScaleDialect } from "kysely-planetscale";
import { withTablePrefix } from "../prefix";
import { SqlRepo } from "../repo";
import type { Database } from "../schema";

export function createPlanetScaleRepo(url: string, tablePrefix?: string): SqlRepo {
  const dialect = new PlanetScaleDialect({
    url,
    // INT64 arrives as string; normalise to number like the other drivers. This replaces
    // kysely-planetscale's default date inflation, which we don't need (no DATETIME columns).
    cast: (field, value) => (field.type === "INT64" || field.type === "UINT64" ? (value == null ? null : Number(value)) : cast(field, value)),
  });
  return new SqlRepo(withTablePrefix(new Kysely<Database>({ dialect }), tablePrefix), "mysql");
}
