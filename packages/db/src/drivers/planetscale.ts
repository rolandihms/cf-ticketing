import { cast, Client, type Config, type Connection } from "@planetscale/database";
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  type QueryResult,
  type TransactionSettings,
} from "kysely";
import { withTablePrefix } from "../prefix";
import { SqlRepo } from "../repo";
import type { Database } from "../schema";

export function createPlanetScaleRepo(url: string, tablePrefix?: string): SqlRepo {
  const dialect = new PlanetScaleDialect({
    url,
    // INT64 arrives as string; normalise to number like the other drivers.
    cast: (field, value) => (field.type === "INT64" || field.type === "UINT64" ? (value == null ? null : Number(value)) : cast(field, value)),
  });
  return new SqlRepo(withTablePrefix(new Kysely<Database>({ dialect }), tablePrefix), "mysql");
}

// Kysely dialect for PlanetScale's HTTP driver, adapted from kysely-planetscale 1.7.1
// (MIT, Copyright (c) 2022-2024 Jacob Gillespie). Kept here so it always uses the @planetscale/database
// this package pins: kysely-planetscale takes the driver as a peer, so an app whose lockfile holds 2.x
// gave it a client that rejects query parameters, and every query failed. Not supported: streaming.

class PlanetScaleDialect implements Dialect {
  constructor(private readonly config: Config) {}
  createAdapter() {
    return new MysqlAdapter();
  }
  createDriver(): Driver {
    return new PlanetScaleDriver(new Client(this.config));
  }
  createQueryCompiler() {
    return new MysqlQueryCompiler();
  }
  createIntrospector(db: Kysely<unknown>) {
    return new MysqlIntrospector(db);
  }
}

class PlanetScaleDriver implements Driver {
  constructor(private readonly client: Client) {}
  async init() {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return new PlanetScaleConnection(this.client);
  }
  async beginTransaction(conn: PlanetScaleConnection, settings: TransactionSettings) {
    await conn.begin(settings);
  }
  async commitTransaction(conn: PlanetScaleConnection) {
    await conn.end("COMMIT");
  }
  async rollbackTransaction(conn: PlanetScaleConnection) {
    await conn.end("ROLLBACK");
  }
  async releaseConnection() {}
  async destroy() {}
}

const formatDate = (d: Date) => d.toISOString().replace(/[TZ]/g, " ").trim();

class PlanetScaleConnection implements DatabaseConnection {
  /** A session-bound connection while a transaction is open; otherwise queries go through the client. */
  private tx: Connection | undefined;
  constructor(private readonly client: Client) {}

  async executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
    const params = q.parameters.map((p) => (p instanceof Date ? formatDate(p) : p));
    const res = await (this.tx ?? this.client).execute(q.sql, params);
    return {
      rows: res.rows as R[],
      ...(res.insertId != null && String(res.insertId) !== "0" ? { insertId: BigInt(res.insertId) } : {}),
      ...(res.rowsAffected != null ? { numAffectedRows: BigInt(res.rowsAffected) } : {}),
    };
  }

  async begin(settings: TransactionSettings) {
    this.tx ??= this.client.connection();
    if (settings.isolationLevel) await this.tx.execute(`SET TRANSACTION ISOLATION LEVEL ${settings.isolationLevel}`);
    await this.tx.execute("BEGIN");
  }

  async end(statement: "COMMIT" | "ROLLBACK") {
    if (!this.tx) throw new Error(`No transaction to ${statement.toLowerCase()}`);
    try {
      await this.tx.execute(statement);
    } finally {
      this.tx = undefined;
    }
  }

  // eslint-disable-next-line require-yield
  async *streamQuery(): AsyncIterableIterator<QueryResult<never>> {
    throw new Error("PlanetScale's HTTP driver does not support streaming");
  }
}
