import {
  type CreateIndexNode,
  type DropIndexNode,
  IdentifierNode,
  type KyselyPlugin,
  OperationNodeTransformer,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type PrimaryKeyConstraintNode,
  type QueryResult,
  type TableNode,
  type UniqueConstraintNode,
  type UnknownRow,
} from "kysely";

/** Prefixes are short identifiers: a lowercase letter, then letters, digits or "_" (e.g. "hd_"). */
export const TABLE_PREFIX_RE = /^[a-z][a-z0-9_]{0,15}$/;

export function validateTablePrefix(prefix: string | undefined): string {
  if (!prefix) return "";
  if (!TABLE_PREFIX_RE.test(prefix)) throw new Error(`Invalid table prefix "${prefix}" (expected ${TABLE_PREFIX_RE}, e.g. "hd_")`);
  return prefix;
}

/**
 * Nodes this plugin produced. Kysely transforms a nested builder (e.g. a subquery in
 * INSERT … SELECT) when it is embedded and again when the outer query compiles; skipping our own
 * output keeps the prefix from being applied twice ("hd_hd_tickets").
 */
const prefixed = new WeakSet<object>();
const mark = <T extends object>(n: T): T => (prefixed.add(n), n);

class PrefixTransformer extends OperationNodeTransformer {
  constructor(private readonly prefix: string) {
    super();
  }

  private id(node: IdentifierNode): IdentifierNode {
    return IdentifierNode.create(this.prefix + node.name);
  }

  // Every table reference: FROM/INTO/UPDATE targets, qualified columns ("tickets.id"), sql.table(),
  // and the schema builder's CREATE/ALTER TABLE.
  protected override transformTable(node: TableNode): TableNode {
    if (prefixed.has(node)) return node;
    const t = super.transformTable(node);
    return mark({ ...t, table: { ...t.table, identifier: this.id(t.table.identifier) } });
  }

  // Index and constraint names are global per schema on SQLite and Postgres, so they need the prefix too.
  protected override transformCreateIndex(node: CreateIndexNode): CreateIndexNode {
    if (prefixed.has(node)) return node;
    const n = super.transformCreateIndex(node);
    return mark({ ...n, name: this.id(n.name) });
  }

  protected override transformDropIndex(node: DropIndexNode): DropIndexNode {
    if (prefixed.has(node)) return node;
    const n = super.transformDropIndex(node);
    return mark({ ...n, name: { ...n.name, identifier: this.id(n.name.identifier) } });
  }

  protected override transformUniqueConstraint(node: UniqueConstraintNode): UniqueConstraintNode {
    if (prefixed.has(node)) return node;
    const n = super.transformUniqueConstraint(node);
    return mark(n.name ? { ...n, name: this.id(n.name) } : n);
  }

  protected override transformPrimaryKeyConstraint(node: PrimaryKeyConstraintNode): PrimaryKeyConstraintNode {
    if (prefixed.has(node)) return node;
    const n = super.transformPrimaryKeyConstraint(node);
    return mark(n.name ? { ...n, name: this.id(n.name) } : n);
  }
}

/**
 * Prefix every table, index and named unique/primary-key constraint, so the help desk can live in
 * another application's database ("hd_" → hd_tickets, hd_tickets_status_idx). Raw SQL must reference
 * tables with sql.table() for the prefix to apply. Limits: table aliases ("tickets as t") and CTE
 * names would be prefixed too, so repo queries don't use them; foreign-key and check constraints
 * must stay unnamed.
 */
export class TablePrefixPlugin implements KyselyPlugin {
  readonly #transformer: PrefixTransformer;

  constructor(prefix: string) {
    this.#transformer = new PrefixTransformer(validateTablePrefix(prefix));
  }

  transformQuery(args: PluginTransformQueryArgs) {
    return this.#transformer.transformNode(args.node, args.queryId);
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}

/** Apply a prefix to a Kysely instance (no-op for an empty prefix). */
export function withTablePrefix<K extends { withPlugin(p: KyselyPlugin): K }>(db: K, prefix: string | undefined): K {
  return prefix ? db.withPlugin(new TablePrefixPlugin(prefix)) : db;
}
