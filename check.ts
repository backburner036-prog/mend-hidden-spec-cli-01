// check: run main.ts on the 100 public practice checks and compare each
// run with the expected outcome (exit code, stdout, files afterwards).
//
// Usage, from the repository root:
//   node check.ts [kitDir] [filter]
// kitDir defaults to the kit37 unpack beside this repository; filter
// limits the run to checks whose family or group contains it.
// Exits 0 when every check passes, 1 otherwise.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type PracticeCheck = {
  key: string;
  group: string;
  family: string;
  argv: string[];
  stdin: string | null;
  files: Record<string, string>;
  expect: { exit: number; stdout: string; changes: Record<string, string | null> };
};

type RunResult = { exit: number; stdout: string; files: Record<string, string> };

const RUN_TIMEOUT_MS = 10_000;

// The files a check leaves behind: its starting files overlaid with the
// expected changes (null removes a file).
function expectedFiles(c: PracticeCheck): Record<string, string> {
  const out: Record<string, string> = { ...c.files };
  for (const [p, v] of Object.entries(c.expect.changes)) {
    if (v === null) delete out[p];
    else out[p] = v;
  }
  return out;
}

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text, "utf8");
  }
}

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

function runOne(mainTs: string, c: PracticeCheck): Promise<RunResult> {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-practice-"));
    writeTree(dir, c.files);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    delete env["MAKEFUN_ENV_URL"];
    const child = spawn(process.execPath, [mainTs, ...c.argv], {
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
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Scratch left behind; harmless.
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
    if (c.stdin !== null) child.stdin.write(c.stdin);
    child.stdin.end();
  });
}

// First difference between a run and its expectation, or null on a pass.
function compare(c: PracticeCheck, r: RunResult, want: Record<string, string>): string | null {
  if (r.exit !== c.expect.exit) return `exit ${r.exit}, expected ${c.expect.exit}`;
  if (r.stdout !== c.expect.stdout) return "stdout differs";
  const wantKeys = Object.keys(want).sort();
  const gotKeys = Object.keys(r.files).sort();
  if (wantKeys.length !== gotKeys.length) {
    const missing = wantKeys.filter((k) => !Object.hasOwn(r.files, k));
    const extra = gotKeys.filter((k) => !Object.hasOwn(want, k));
    return `files differ: missing [${missing.join(", ")}] extra [${extra.join(", ")}]`;
  }
  for (const k of wantKeys) {
    if (r.files[k] !== want[k]) {
      const a = want[k];
      const b = r.files[k];
      let at = 0;
      while (at < Math.min(a.length, b.length) && a[at] === b[at]) at++;
      return `file ${k} differs at byte ${at}: expected ${JSON.stringify(a.slice(at, at + 60))} got ${JSON.stringify(b.slice(at, at + 60))}`;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const kitDir =
    process.argv[2] ??
    path.join(
      process.cwd(),
      "..",
      "hidden-spec-cli-01-run-20261122-kit37",
      "hidden-spec-cli-01-run-20261122-kit",
    );
  const filter = process.argv[3] ?? "";
  const data = JSON.parse(
    fs.readFileSync(path.join(kitDir, "program", "generator", "practice.json"), "utf8"),
  ) as { checks: PracticeCheck[] };
  const checks = data.checks.filter(
    (c) => filter === "" || c.family.includes(filter) || c.group.includes(filter),
  );
  const mainTs = path.join(process.cwd(), "main.ts");
  let passed = 0;
  const byGroup = new Map<string, [number, number]>();
  const failures: { c: PracticeCheck; why: string; got: RunResult }[] = [];
  for (const c of checks) {
    const g = byGroup.get(c.group) ?? [0, 0];
    g[1]++;
    byGroup.set(c.group, g);
    const r = await runOne(mainTs, c);
    const why = compare(c, r, expectedFiles(c));
    if (why === null) {
      passed++;
      g[0]++;
    } else {
      failures.push({ c, why, got: r });
    }
  }
  for (const [g, [p, t]] of [...byGroup.entries()].sort()) console.log(`${g}: ${p}/${t}`);
  console.log(`passed ${passed}/${checks.length} score ${Math.round((1000 * passed) / checks.length)}`);
  for (const f of failures) {
    console.log(`FAIL ${f.c.group}/${f.c.family} argv=${JSON.stringify(f.c.argv)}: ${f.why}`);
    console.log(`  expected exit ${f.c.expect.exit} stdout ${JSON.stringify(f.c.expect.stdout)}`);
    console.log(`  got      exit ${f.got.exit} stdout ${JSON.stringify(f.got.stdout)}`);
  }
  process.exitCode = passed === checks.length ? 0 : 1;
}

main().then(
  () => undefined,
  (err: unknown) => {
    process.stderr.write(`check: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
