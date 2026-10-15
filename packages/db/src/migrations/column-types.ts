import { sql, type ColumnDataType, type Expression } from "kysely";
import type { SqlDialect } from "../types";

type DataType = ColumnDataType | Expression<unknown>;

/**
 * Portable column types. The rules (see docs/DATABASE.md):
 * - ids are app-generated ULIDs (26 chars)
 * - timestamps are epoch milliseconds in BIGINT, set by the app (no DB defaults)
 * - JSON is stored as text and parsed in the app
 * - booleans are small integers (0/1)
 * - indexed strings are VARCHAR(n) on MySQL (InnoDB cannot index TEXT without a prefix)
 * - MySQL strings use utf8mb4_bin: byte-exact comparison like SQLite/Postgres. The default
 *   (utf8mb4_0900_ai_ci) would make `jose@x` = `josé@x` and Message-IDs case-insensitive.
 */
export function columnTypes(d: SqlDialect) {
  const bin = (type: string): DataType => sql.raw(`${type} character set utf8mb4 collate utf8mb4_bin`);
  const str = (n: number): DataType =>
    d === "sqlite" ? "text" : d === "mysql" ? bin(`varchar(${n})`) : (`varchar(${n})` as ColumnDataType);
  return {
    id: str(26),
    str,
    /** Unbounded text that is never indexed. MySQL TEXT caps at 64 KiB, so use MEDIUMTEXT there. */
    text: (d === "mysql" ? sql`mediumtext` : "text") as DataType,
    json: (d === "mysql" ? sql`mediumtext` : "text") as DataType,
    int: "integer" as DataType,
    bigint: "bigint" as DataType,
    bool: (d === "postgres" ? "smallint" : d === "mysql" ? sql`tinyint` : "integer") as DataType,
    hash: (d === "sqlite" ? "text" : d === "mysql" ? bin("char(64)") : "char(64)") as DataType,
  };
}
