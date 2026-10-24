import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Written to stdin (e.g. a secret value), then stdin is closed. */
  input?: string;
}

/** Executes wrangler commands. Injected so the setup flow can be tested without Cloudflare. */
export interface Wrangler {
  run(args: string[], opts?: RunOptions): Promise<RunResult>;
}

const ANSI = /\u001b\[[0-9;]*m/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

/** First wrangler `✘ [ERROR]` line, or the last non-empty stderr line. */
export function errorText(r: RunResult): string {
  const all = `${r.stdout}\n${r.stderr}`;
  const m = all.match(/\[ERROR\]\s*(.+)/);
  if (m) return m[1]!.trim();
  return all.trim().split("\n").filter(Boolean).pop() ?? `exit code ${r.code}`;
}

/** Wrangler surfaces some failures (e.g. unknown zone) on stdout with exit code 0, so check both. */
export const failed = (r: RunResult) => r.code !== 0 || /^\s*(?:✘\s*)?\[ERROR\]/m.test(r.stdout + r.stderr);

/** Absolute path of the repo's wrangler CLI entry (its package `bin`; the subpath isn't exported). */
export function wranglerBin(cwd: string): string {
  const req = createRequire(join(resolvePath(cwd), "package.json"));
  let pkgPath: string;
  try {
    pkgPath = req.resolve("wrangler/package.json");
  } catch {
    // Fallback when package.json isn't exported: walk from the main entry up to the package root.
    let dir = dirname(req.resolve("wrangler"));
    while (!readFileSync(join(dir, "package.json"), "utf8").includes('"name": "wrangler"')) dir = dirname(dir);
    pkgPath = join(dir, "package.json");
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin: string | Record<string, string> };
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.wrangler!;
  return join(dirname(pkgPath), rel);
}

export function realWrangler(opts: { cwd: string; accountId?: () => string | undefined }): Wrangler {
  return {
    run(args, runOpts = {}) {
      return new Promise((resolve, reject) => {
        const accountId = opts.accountId?.();
        // Run the repo's own wrangler with this Node binary: no npx, works the same on Windows.
        const bin = wranglerBin(opts.cwd);
        const child = spawn(process.execPath, [bin, ...args], {
          cwd: opts.cwd,
          env: {
            ...process.env,
            ...(accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {}),
            NO_COLOR: "1",
            FORCE_COLOR: "0",
            WRANGLER_SEND_METRICS: "false",
            CI: process.env.CI ?? "1", // never block on interactive prompts
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code: code ?? 1, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) }));
        if (runOpts.input !== undefined) child.stdin.write(runOpts.input);
        child.stdin.end();
      });
    },
  };
}
