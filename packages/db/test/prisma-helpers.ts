// Run the Prisma CLI (v6, the version our first host uses) against generated schemas.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPrismaSchema } from "../src/prisma";

const HOST_SCHEMA = `datasource db {
  provider     = "mysql"
  url          = env("DATABASE_URL")
  relationMode = "prisma"
}

model User {
  id String @id
}
`;

/** A multi-file Prisma schema folder: the host's schema.prisma plus our generated helpdesk.prisma. */
export function prismaFolder(opts: { prefix?: string; withHelpdesk?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hd-prisma-"));
  writeFileSync(join(dir, "schema.prisma"), HOST_SCHEMA);
  if (opts.withHelpdesk !== false) writeFileSync(join(dir, "helpdesk.prisma"), renderPrismaSchema({ tablePrefix: opts.prefix ?? "hd_" }));
  return dir;
}

export const prisma = (args: string[], env: Record<string, string> = {}) =>
  execFileSync(process.execPath, [createRequire(import.meta.url).resolve("prisma/build/index.js"), ...args], {
    encoding: "utf8",
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1", CHECKPOINT_DISABLE: "1", DATABASE_URL: "mysql://u:p@localhost:3306/x", ...env },
  });

