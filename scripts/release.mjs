// Build, stage and publish the @rolandihms/helpdesk-* packages.
//
//   node scripts/release.mjs build             dist/ for every package (esbuild bundle + tsc declarations)
//   node scripts/release.mjs stage             .release/<pkg>/: dist, README, LICENSE and a publishable package.json
//   node scripts/release.mjs publish [--dry-run]   npm publish the staged packages, dependencies first
//
// In the repo the packages export their TypeScript sources (tests, typecheck and the apps use them directly).
// The staged package.json points at dist/ instead, pins the sibling packages to this version, and drops
// "private"; the sources stay private so a stray `npm publish` in packages/* fails.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(root, ".release");
const REPO = "https://github.com/rolandihms/cf-ticketing";

/** Dependency order (publish order). */
const PACKAGES = {
  core: "Core types, configuration and classifiers for CF Helpdesk, a help desk on Cloudflare.",
  db: "Database layer for CF Helpdesk: D1, Postgres, MySQL and PlanetScale through Kysely, migrations, table prefixes and Prisma models.",
  plugins: "Plugins for CF Helpdesk: GitHub issues and signed webhooks.",
  client: "Typed, framework-agnostic client for the CF Helpdesk API (browser, Workers, Node), plus a server-side proxy helper.",
  worker: "The CF Helpdesk Worker as a library: createHelpdesk() gives you fetch, email and the inbound Workflow.",
  cli: "cf-helpdesk: add CF Helpdesk to an existing project (init) and apply its migrations (migrate).",
};

const pkgJson = (name) => JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8"));
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

/** Entry points: export subpath → source file. The CLI is a bin, not a library. */
function entries(name) {
  const p = pkgJson(name);
  if (name === "cli") return { bin: "./src/index.ts" };
  return Object.fromEntries(Object.entries(p.exports).map(([sub, src]) => [sub, src]));
}
const distOf = (src) => src.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, ".js");
const typesOf = (src) => src.replace(/^\.\/src\//, "./dist/types/").replace(/\.ts$/, ".d.ts");

async function buildPackage(name) {
  const dir = join(root, "packages", name);
  rmSync(join(dir, "dist"), { recursive: true, force: true });
  const { metafile } = await build({
    absWorkingDir: dir,
    metafile: true,
    entryPoints: Object.values(entries(name)),
    outdir: "dist",
    outbase: "src",
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    // Dependencies stay imports (the consumer's bundler resolves them); Workers and Node built-ins too.
    packages: "external",
    external: ["node:*", "cloudflare:*"],
    banner: name === "cli" ? { js: "#!/usr/bin/env node" } : undefined,
    logLevel: "warning",
  });
  if (name !== "cli") {
    const tsconfig = join(dir, "tsconfig.release.json");
    writeFileSync(
      tsconfig,
      JSON.stringify({
        extends: "./tsconfig.json",
        compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: "dist/types", rootDir: "src" },
        include: ["src"],
      }),
    );
    try {
      run(join(root, "node_modules/.bin/tsc"), ["-p", tsconfig]);
    } finally {
      rmSync(tsconfig);
    }
  }
  checkImports(name, metafile);
}

/** Every bare import left in dist/ (JS from esbuild's metafile, declarations by scanning) must be a declared dependency. */
function checkImports(name, metafile) {
  const p = pkgJson(name);
  const allowed = new Set([...Object.keys(p.dependencies ?? {}), ...Object.keys(p.peerDependencies ?? {}), ...builtinModules]);
  const bad = new Set();
  const check = (spec, file) => {
    if (spec.startsWith(".") || /^(node|cloudflare):/.test(spec)) return;
    const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    if (!allowed.has(pkg)) bad.add(`${spec} (${file})`);
  };
  for (const [file, out] of Object.entries(metafile.outputs)) for (const i of out.imports) if (i.external) check(i.path, file);
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const f = join(d, e);
      if (statSync(f).isDirectory()) walk(f);
      else if (e.endsWith(".d.ts")) {
        for (const [, a, b] of readFileSync(f, "utf8").matchAll(/^(?:import|export)\b[^;]*?from\s*["']([^"']+)["']|import\(["']([^"']+)["']\)/gm)) check(a ?? b, relative(root, f));
      }
    }
  };
  walk(join(root, "packages", name, "dist"));
  if (bad.size) throw new Error(`${name}: dist imports undeclared packages:\n  ${[...bad].join("\n  ")}`);
}

function stagePackage(name, version) {
  const src = pkgJson(name);
  const from = join(root, "packages", name);
  const to = join(releaseDir, name);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  cpSync(join(from, "dist"), join(to, "dist"), { recursive: true });
  cpSync(join(root, "LICENSE"), join(to, "LICENSE"));

  const pin = (deps) =>
    deps && Object.fromEntries(Object.entries(deps).map(([k, v]) => [k, k.startsWith("@rolandihms/helpdesk-") ? `^${version}` : v]));
  const out = {
    name: src.name,
    version,
    description: PACKAGES[name],
    license: "MIT",
    author: "Roland Ihms",
    type: "module",
    repository: { type: "git", url: `git+${REPO}.git`, directory: `packages/${name}` },
    homepage: `${REPO}#readme`,
    bugs: `${REPO}/issues`,
    keywords: ["cloudflare", "workers", "helpdesk", "ticketing", "email"],
    engines: { node: ">=20" },
    files: ["dist", "templates"],
    dependencies: pin(src.dependencies),
    peerDependencies: pin(src.peerDependencies),
    publishConfig: { access: "public" },
  };
  if (name === "cli") {
    out.bin = { "cf-helpdesk": "./dist/index.js" };
    // init's wrangler.jsonc template (the CLI reads apps/worker/wrangler.jsonc in a checkout).
    mkdirSync(join(to, "templates"));
    cpSync(join(root, "apps/worker/wrangler.jsonc"), join(to, "templates/wrangler.jsonc"));
  } else {
    out.exports = Object.fromEntries(
      Object.entries(entries(name)).map(([sub, file]) => [sub, { types: typesOf(file), default: distOf(file) }]),
    );
    out.exports["./package.json"] = "./package.json";
  }
  writeFileSync(join(to, "package.json"), JSON.stringify(out, null, 2) + "\n");
  writeFileSync(join(to, "README.md"), readme(name, out));
}

function readme(name, p) {
  const usage =
    name === "cli"
      ? "```bash\nnpx @rolandihms/helpdesk-cli init --db planetscale --table-prefix hd_\n```"
      : `\`\`\`bash\nnpm install ${p.name}\n\`\`\``;
  return `# ${p.name}

${p.description}

${usage}

Part of [CF Helpdesk](${REPO}), an open-source help desk on Cloudflare (Email Routing → Workflows → tickets).
Embedding it in an existing app: [docs/EMBEDDING.md](${REPO}/blob/main/docs/EMBEDDING.md).
API reference: [docs/AGENT-API.md](${REPO}/blob/main/docs/AGENT-API.md).

The packages ship ES modules for bundlers (Wrangler, Vite and others), with TypeScript declarations.

MIT licensed.
`;
}

const [command, ...flags] = process.argv.slice(2);
const versions = new Set(Object.keys(PACKAGES).map((n) => pkgJson(n).version));
if (versions.size !== 1) throw new Error(`packages disagree on the version: ${[...versions].join(", ")}`);
const [version] = versions;

if (command === "build") {
  for (const name of Object.keys(PACKAGES)) {
    await buildPackage(name);
    console.log(`built ${name}`);
  }
} else if (command === "stage") {
  for (const name of Object.keys(PACKAGES)) {
    if (!existsSync(join(root, "packages", name, "dist"))) throw new Error(`packages/${name}/dist is missing: run build first`);
    stagePackage(name, version);
    console.log(`staged ${name}@${version} → ${relative(root, join(releaseDir, name))}`);
  }
} else if (command === "publish") {
  for (const name of Object.keys(PACKAGES)) run("npm", ["publish", ...flags], join(releaseDir, name));
} else {
  console.error("usage: node scripts/release.mjs build | stage | publish [--dry-run]");
  process.exitCode = 1;
}
