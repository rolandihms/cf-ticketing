// `cf-helpdesk init`: add the help desk to an existing project (docs/EMBEDDING.md).
// Writes a small Worker package (helpdesk/), the prefixed migration SQL and, for Prisma projects,
// generated models so the host's `prisma db push` keeps the help desk tables. Re-running it is the
// upgrade path: generated files are rewritten, files meant for editing are left alone.
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { compileMigrations, renderMigrationFile, renderPrismaSchema, type SqlDialect, TABLE_PREFIX_RE } from "@cf-helpdesk/db/migrations";
import { applyEdits, type JSONPath, modify } from "jsonc-parser";
import { WORKER_NAME_RE } from "./answers";

export type InitDb = "d1" | "postgres" | "mysql" | "planetscale";

export interface InitOptions {
  /** The host project's root. */
  cwd: string;
  /** Folder for the help desk Worker, relative to cwd. */
  dir: string;
  tablePrefix: string;
  db: InitDb;
  workerName: string;
  /** Folder of the host's Prisma schema (relative to cwd), "none" to skip, or undefined to detect. */
  prismaDir?: string;
  modelPrefix?: string;
  /** How the generated package.json depends on @cf-helpdesk/*: npm versions or this checkout (file:). */
  deps: { kind: "npm"; version: string } | { kind: "file"; packagesDir: string };
  /** apps/worker/wrangler.jsonc of this repo (comments and all, like setup). */
  templatePath: string;
  /** Overwrite files meant for editing too. */
  force?: boolean;
}

export interface PlannedFile {
  path: string;
  content: string;
  /** generated: always rewritten. user: written once, then yours. */
  kind: "generated" | "user";
}

export class InitError extends Error {}

const dialectOf = (db: InitDb): SqlDialect => (db === "d1" ? "sqlite" : db === "planetscale" ? "mysql" : db);

/** The host's Prisma schema folder: the only directory (outside node_modules) holding schema.prisma, max 3 levels down. */
export function findPrismaDir(cwd: string): string | null {
  const hits: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      const p = join(dir, e);
      if (e === "schema.prisma") hits.push(dirname(p));
      else if (depth < 3 && statSync(p, { throwIfNoEntry: false })?.isDirectory()) walk(p, depth + 1);
    }
  };
  walk(cwd, 0);
  return hits.length === 1 ? relative(cwd, hits[0]!) || "." : null;
}

export async function planInit(o: InitOptions): Promise<{ files: PlannedFile[]; notes: string[] }> {
  if (!TABLE_PREFIX_RE.test(o.tablePrefix)) throw new InitError(`--table-prefix "${o.tablePrefix}": a lowercase letter, then letters, digits or "_" (max 16), e.g. hd_`);
  if (!WORKER_NAME_RE.test(o.workerName)) throw new InitError("--worker: lowercase letters, digits and dashes (max 54)");
  const dialect = dialectOf(o.db);
  const dir = o.dir.replace(/\/+$/, "");
  const files: PlannedFile[] = [];
  const notes: string[] = [];
  const at = (p: string) => join(dir, p);

  // ---- the Worker package ----
  const dep = (name: string) =>
    o.deps.kind === "npm" ? `^${o.deps.version}` : `file:${relative(resolve(o.cwd, dir), join(o.deps.packagesDir, name))}`;
  files.push({
    path: at("package.json"),
    kind: "user",
    content: `${JSON.stringify(
      {
        name: o.workerName,
        private: true,
        type: "module",
        scripts: { dev: "wrangler dev", deploy: "wrangler deploy", types: "wrangler types --strict-vars false" },
        dependencies: {
          "@cf-helpdesk/core": dep("core"),
          "@cf-helpdesk/db": dep("db"),
          "@cf-helpdesk/plugins": dep("plugins"),
          "@cf-helpdesk/worker": dep("worker"),
        },
        devDependencies: { typescript: "^5.9.0", wrangler: "^4.151.0" },
      },
      null,
      2,
    )}\n`,
  });
  files.push({
    path: at("src/index.ts"),
    kind: "user",
    content: `import { createHelpdesk } from "@cf-helpdesk/worker";
import config from "../helpdesk.config";

const helpdesk = createHelpdesk(config);

export const InboundEmailWorkflow = helpdesk.InboundEmailWorkflow;

export default {
  fetch: helpdesk.fetch,
  email: helpdesk.email,
} satisfies ExportedHandler<Env>;
`,
  });
  files.push({
    path: at("helpdesk.config.ts"),
    kind: "user",
    content: `// Help desk configuration: classification and plugins. See the cf-helpdesk docs (AI-PIPELINE.md, INTEGRATIONS.md).
import { DEFAULT_CATEGORIES, defineHelpdesk, llmClassifier, rulesClassifier } from "@cf-helpdesk/core";
import { webhooks } from "@cf-helpdesk/plugins";
import { workersAI } from "@cf-helpdesk/worker";

export default defineHelpdesk<Env>({
  ackNewTickets: true,

  classification: {
    categories: DEFAULT_CATEGORIES,
    fallback: "other",
    acceptAt: 0.75,
    classifiers: [
      rulesClassifier(),
      llmClassifier<Env>({ provider: (env) => (env.AI ? workersAI(env.AI, { model: env.AI_MODEL }) : null) }),
    ],
  },

  plugins: [
    // Tell your app what happens (signed POST; verify with verifyWebhookSignature from @cf-helpdesk/plugins).
    // Off until WEBHOOK_URL is set; the secret: \`wrangler secret put WEBHOOK_SECRET\`.
    webhooks<Env>({
      endpoints: [
        {
          name: "app",
          url: (env) => env.WEBHOOK_URL || undefined,
          secret: (env) => env.WEBHOOK_SECRET,
          events: ["ticket.created", "message.received", "ticket.classified", "ticket.assigned", "ticket.status_changed", "ticket.replied"],
        },
      ],
    }),
  ],
});
`,
  });
  files.push({
    path: at("src/env.d.ts"),
    kind: "user",
    content: `// Secrets aren't in wrangler.jsonc, so \`wrangler types\` can't see them. Declare them here.
interface Env {
  HELPDESK_SERVICE_KEY?: string;
  WEBHOOK_SECRET?: string;
  DATABASE_URL?: string;
}
`,
  });
  files.push({
    path: at("tsconfig.json"),
    kind: "user",
    content: `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2023"],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          types: ["./worker-configuration.d.ts"],
        },
        include: ["src", "helpdesk.config.ts", "worker-configuration.d.ts"],
      },
      null,
      2,
    )}\n`,
  });
  files.push({ path: at("wrangler.jsonc"), kind: "user", content: renderWrangler(await readFile(o.templatePath, "utf8"), o) });

  // ---- schema: prefixed SQL, applied by the host (never by the Worker) ----
  for (const m of compileMigrations(dialect, o.tablePrefix)) {
    files.push({ path: at(`migrations/${dialect}/${m.name}.sql`), kind: "generated", content: renderMigrationFile(dialect, m.name, m.statements, o.tablePrefix) });
  }

  // ---- Prisma ----
  const prismaDir = o.prismaDir === "none" ? null : (o.prismaDir ?? findPrismaDir(o.cwd));
  if (prismaDir) {
    if (dialect !== "mysql") {
      notes.push(`Skipped Prisma models: generation supports MySQL/PlanetScale for now (this project uses ${o.db}).`);
    } else {
      files.push({
        path: join(prismaDir, "helpdesk.prisma"),
        kind: "generated",
        content: renderPrismaSchema({ tablePrefix: o.tablePrefix, ...(o.modelPrefix ? { modelPrefix: o.modelPrefix } : {}) }),
      });
      notes.push(
        `Prisma: wrote ${join(prismaDir, "helpdesk.prisma")}. Prisma must load the whole folder (multi-file schema, Prisma 6.6+):\n` +
          "  point it at the folder: `--schema <folder>`, or `\"prisma\": { \"schema\": \"<folder>\" }` in the package.json\n" +
          "  that runs Prisma (the path is relative to that package.json).\n" +
          "  Then `prisma db push` keeps the help desk tables. The models are read-only: write through the help desk API.",
      );
    }
  } else if (o.prismaDir === undefined) {
    notes.push("No Prisma schema found (or several): pass --prisma-dir <folder> to generate models, or --prisma-dir none.");
  }

  files.push({ path: at("README.md"), kind: "generated", content: renderReadme(o, dialect, prismaDir) });
  return { files, notes };
}

function renderWrangler(template: string, o: InitOptions): string {
  // The template's header talks about `npm run setup`; start at the object.
  let text = template.slice(template.indexOf("{"));
  const set = (path: JSONPath, value: unknown) => {
    text = applyEdits(text, modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } }));
  };
  set(["$schema"], "node_modules/wrangler/config-schema.json");
  set(["name"], o.workerName);
  set(["main"], "src/index.ts");
  // Reached through your app's service binding; Email Routing needs no public URL.
  set(["workers_dev"], false);
  set(["workflows", 0, "name"], `${o.workerName}-inbound`);
  set(["r2_buckets", 0, "bucket_name"], `${o.workerName}-mail`);
  set(["define", "__HELPDESK_DB_DRIVER__"], JSON.stringify(o.db));
  set(["vars", "DB_DRIVER"], o.db);
  set(["vars", "TABLE_PREFIX"], o.tablePrefix);
  set(["vars", "TRUSTED_PRINCIPAL"], "on");
  if (o.db === "d1") {
    set(["d1_databases", 0, "database_name"], o.workerName);
    set(["d1_databases", 0, "migrations_dir"], "migrations/sqlite");
    set(["d1_databases", 0, "migrations_table"], `${o.tablePrefix}d1_migrations`);
  } else {
    set(["d1_databases"], undefined);
    if (o.db !== "planetscale") set(["hyperdrive"], [{ binding: "HYPERDRIVE", id: "<hyperdrive-id: npx wrangler hyperdrive create>" }]);
  }
  return `// Generated by \`cf-helpdesk init\`; edit freely (re-running init keeps this file).\n${text}`;
}

function renderReadme(o: InitOptions, dialect: SqlDialect, prismaDir: string | null): string {
  const dir = o.dir;
  const apply =
    o.db === "d1"
      ? `npx wrangler d1 create ${o.workerName}            # put the id into wrangler.jsonc\nnpx wrangler d1 migrations apply DB --remote`
      : o.db === "planetscale"
        ? `# Apply migrations/mysql/*.sql through a PlanetScale deploy request (with your other schema changes), then record them:\nDATABASE_URL=... npx cf-helpdesk migrate --driver mysql --table-prefix ${o.tablePrefix} --record-only`
        : `DATABASE_URL=... npx cf-helpdesk migrate --driver ${dialect} --table-prefix ${o.tablePrefix}\n# or apply migrations/${dialect}/*.sql with your own migration tool, then add --record-only`;
  return `# Help desk (cf-helpdesk)

Generated by \`cf-helpdesk init\`. The help desk runs as its own Worker (\`${o.workerName}\`) in the same Cloudflare
account as your app, stores its tables in your database with the prefix \`${o.tablePrefix}\`, and is called by your
API over a service binding. Guide: https://github.com/rolandihms/cf-ticketing/blob/main/docs/EMBEDDING.md

| File | |
|---|---|
| \`src/index.ts\`, \`helpdesk.config.ts\`, \`wrangler.jsonc\` | Yours to edit (init never overwrites them without --force) |
| \`migrations/${dialect}/*.sql\` | Generated. Apply with your schema process; never edit |${prismaDir ? `\n| \`${join(relative(dir, prismaDir), "helpdesk.prisma")}\` | Generated Prisma models (read-only) so \`prisma db push\` keeps the tables |` : ""}

## First deploy

\`\`\`bash
cd ${dir} && npm install
npx wrangler r2 bucket create ${o.workerName}-mail
${apply}
npx wrangler secret put HELPDESK_SERVICE_KEY      # long random value; give the same one to your app
npx wrangler deploy
\`\`\`

Then route your support address to the Worker (Email Routing, or \`"addresses"\` in wrangler.jsonc) and, in
your app's wrangler config, add \`"services": [{ "binding": "HELPDESK", "service": "${o.workerName}" }]\`.
Forward requests with \`forwardToHelpdesk()\` from \`@cf-helpdesk/client/server\`.

## Upgrading

Update the \`@cf-helpdesk/*\` packages, re-run \`cf-helpdesk init\` with the same options, apply any new
\`migrations/${dialect}/*.sql\` (and push the regenerated Prisma file) **before** deploying the new Worker.
`;
}

/** Write the plan. Generated files are always written; user files only if missing (or with force). */
export async function writeInit(cwd: string, files: PlannedFile[], force = false) {
  const report: { path: string; action: "created" | "updated" | "unchanged" | "kept" }[] = [];
  for (const f of files) {
    const full = resolve(cwd, f.path);
    const exists = existsSync(full);
    if (exists && f.kind === "user" && !force) {
      report.push({ path: f.path, action: "kept" });
      continue;
    }
    if (exists && (await readFile(full, "utf8")) === f.content) {
      report.push({ path: f.path, action: "unchanged" });
      continue;
    }
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, f.content);
    report.push({ path: f.path, action: exists ? "updated" : "created" });
  }
  return report;
}
