// `@cf-helpdesk/db/migrations`: SQL generation only (no drivers, no Cloudflare types), for CLIs and build tools.
export { compileMigrations, renderMigrationFile } from "./compile";
export { TABLE_PREFIX_RE, validateTablePrefix } from "./prefix";
export { renderPrismaSchema } from "./prisma";
export type { SqlDialect } from "./types";
