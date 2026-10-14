// Minimal Kysely dialect for Cloudflare D1.
// Adapted from kysely-d1 (MIT, https://github.com/aidenwallis/kysely-d1), vendored to avoid an
// unmaintained dependency. D1 has no interactive transactions: use D1Database.batch() for atomicity.
import {
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";

export class D1Dialect implements Dialect {
  constructor(private readonly database: D1Database) {}
  createAdapter() {
    return new SqliteAdapter();
  }
  createDriver(): Driver {
    return new D1Driver(this.database);
  }
  createQueryCompiler() {
    return new SqliteQueryCompiler();
  }
  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

class D1Driver implements Driver {
  constructor(private readonly database: D1Database) {}
  async init() {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return new D1Connection(this.database);
  }
  async beginTransaction(): Promise<void> {
    throw new Error("D1 does not support interactive transactions; use D1Database.batch()");
  }
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}
  async releaseConnection() {}
  async destroy() {}
}

class D1Connection implements DatabaseConnection {
  constructor(private readonly database: D1Database) {}

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const res = await this.database
      .prepare(compiled.sql)
      .bind(...compiled.parameters.map((p) => (p === undefined ? null : p)))
      .all<R>();
    const changes = res.meta.changes ?? 0;
    return {
      rows: res.results ?? [],
      numAffectedRows: changes > 0 ? BigInt(changes) : undefined,
      insertId: res.meta.last_row_id ? BigInt(res.meta.last_row_id) : undefined,
    };
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("D1 does not support streaming queries");
  }
}

/** Turn a compiled Kysely query into a D1 prepared statement, for use in D1Database.batch(). */
export function toD1Statement(database: D1Database, q: CompiledQuery): D1PreparedStatement {
  return database.prepare(q.sql).bind(...q.parameters.map((p) => (p === undefined ? null : p)));
}
