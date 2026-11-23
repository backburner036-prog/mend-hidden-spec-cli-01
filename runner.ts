// runner: the trial side of mend.
//
// The grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set. This
// module then fetches the trial's checks from the env, runs node main.ts
// on each one in a fresh directory holding exactly that check's files
// (with the check's standard input and without MAKEFUN_ENV_URL), and
// posts every result back. A result is final once the env accepts it.
//
// Env API (see the trial prompt): GET $MAKEFUN_ENV_URL/checks lists the
// checks; POST $MAKEFUN_ENV_URL/results takes {results: [{id, exit,
// stdout, files}]}. Each run has 10 seconds; one still running then is
// stopped and reported as exit 124.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type Check = {
  id: string;
  argv: string[];
  stdin: string | null;
  files: Record<string, string>;
};

type RunResult = { exit: number; stdout: string; files: Record<string, string> };

const RUN_TIMEOUT_MS = 10_000;

function envBase(u: string): string {
  return u.endsWith("/") ? u.slice(0, -1) : u;
}

async function getChecks(base: string): Promise<Check[]> {
  const res = await fetch(`${base}/checks`);
  if (!res.ok) throw new Error(`GET /checks -> ${res.status}`);
  const data = (await res.json()) as { checks: Check[] };
  if (!Array.isArray(data.checks)) throw new Error("GET /checks: no checks list");
  return data.checks;
}

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text, "utf8");
  }
}

// Every regular file in the directory afterwards, paths relative to it
// with "/" between segments, each with its text.
function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, prefix: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) out[rel] = fs.readFileSync(full, "utf8");
    }
  };
  walk(dir, "");
  return out;
}

function runOne(mainTs: string, check: Check): Promise<RunResult> {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-check-"));
    try {
      writeTree(dir, check.files);
    } catch {
      // A malformed file list still gets its run; the check fails on its
      // own rather than hanging the trial.
    }
    // The child must not see MAKEFUN_ENV_URL: with it set, main.ts would
    // hand over to this runner again instead of running the CLI.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    delete env["MAKEFUN_ENV_URL"];
    const child = spawn(process.execPath, [mainTs, ...check.argv], {
      cwd: dir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    const finish = (exit: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let files: Record<string, string> = {};
      try {
        files = readTree(dir);
      } catch {
        files = {};
      }
      resolve({ exit, stdout, files });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      finish(124);
    }, RUN_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.on("error", () => finish(124));
    child.on("close", (code) => finish(code ?? 124));
    if (check.stdin !== null) child.stdin.write(check.stdin);
    child.stdin.end();
  });
}

export async function runTrial(envUrl: string): Promise<void> {
  const base = envBase(envUrl);
  const checks = await getChecks(base);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const mainTs = path.join(here, "main.ts");
  const results: { id: string; exit: number; stdout: string; files: Record<string, string> }[] = [];
  for (const check of checks) {
    const r = await runOne(mainTs, check);
    results.push({ id: check.id, exit: r.exit, stdout: r.stdout, files: r.files });
  }
  const res = await fetch(`${base}/results`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ results }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST /results -> ${res.status} ${text}`);
  }
  const data = (await res.json()) as { accepted?: string[]; left?: number };
  process.stderr.write(
    `runner: posted ${results.length} results, accepted ${(data.accepted ?? []).length}, left ${data.left ?? "?"}\n`,
  );
}
