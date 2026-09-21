#!/usr/bin/env bun
// check — the ghostget-skills gate. Every claim the package makes has a gate
// here: typecheck, tests, manifest admission, pinned embedded digests,
// recorded smoke runs with replay, bench report currency, privacy scan, and
// npm pack scope. Exit 0 when all pass.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseOrganismManifest } from "@hraness/algal";
import { PKG, PROGRAMS_DIR } from "../src/run-program.ts";
import { pinAll } from "./pin-digests.ts";
import { smoke } from "./smoke.ts";
import { benchFingerprint } from "../bench/run-bench.ts";

const results: Array<{ gate: string; ok: boolean; detail: string }> = [];

async function gate(name: string, fn: () => string | Promise<string>) {
  try {
    results.push({ gate: name, ok: true, detail: await fn() });
  } catch (error) {
    results.push({ gate: name, ok: false, detail: String(error).slice(0, 600) });
  }
}

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd: PKG, encoding: "utf8", timeout: 600_000 });
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
  if (r.error || r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.error ?? text.slice(-1200)}`);
  const tests = text.match(/(\d+) pass\s+(\d+) fail/);
  if (tests) return `${tests[1]} pass, ${tests[2]} fail`;
  return text.split("\n").slice(-2).join(" ") || "clean";
}

await gate("typecheck", () => run("bunx", ["tsc", "--noEmit"]));
await gate("tests", () => run("bun", ["test", "tests/"]));
await gate("manifests", () => {
  const files = readdirSync(PROGRAMS_DIR).filter((file) => file.endsWith(".algal.json"));
  for (const file of files) {
    const manifest = parseOrganismManifest(JSON.parse(readFileSync(join(PROGRAMS_DIR, file), "utf8")));
    if (manifest.budgets.maxAgentCalls !== 0) throw new Error(`${file} declares model calls`);
  }
  return `${files.length} manifests admit with zero agent calls`;
});
await gate("embedded-digests", () => {
  const { stale } = pinAll("check");
  if (stale.length) throw new Error(`stale: ${stale.join(", ")} — run bun scripts/pin-digests.ts`);
  return "pinned digests current";
});
await gate("recorded-smoke-and-replay", async () => {
  const { rows, failures } = await smoke();
  if (failures.length) throw new Error(failures.join("\n"));
  return `${rows.length} recorded runs complete and replay bit-for-bit`;
});
await gate("bench-report-current", () => {
  const path = join(PKG, "bench", "report", "bench-report.json");
  if (!existsSync(path)) throw new Error("missing — run bun bench/run-bench.ts");
  const report = JSON.parse(readFileSync(path, "utf8")) as { source_fingerprint: string; totals: { context_reduction_pct: number }; workflows: unknown[] };
  if (report.source_fingerprint !== benchFingerprint()) throw new Error("source changed; regenerate with bun bench/run-bench.ts");
  return `${report.totals.context_reduction_pct}% context-byte reduction across ${report.workflows.length} recorded workflows (labelled estimate)`;
});
await gate("skills", () => {
  const folders = readdirSync(join(PKG, "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const folder of folders) {
    const content = readFileSync(join(PKG, "skills", folder.name, "SKILL.md"), "utf8");
    const header = content.match(/^---\n([\s\S]*?)\n---/u);
    if (!header) throw new Error(`${folder.name}: missing frontmatter`);
    const meta = Bun.YAML.parse(header[1]!) as Record<string, unknown>;
    if (meta.name !== folder.name || typeof meta.description !== "string" || !meta.description.trim()) throw new Error(`${folder.name}: invalid metadata`);
    if (Object.keys(meta).some((key) => !["name", "description", "argument-hint", "allowed-tools", "license", "metadata"].includes(key))) throw new Error(`${folder.name}: unsupported frontmatter`);
    if (content.split("\n").length > 60) throw new Error(`${folder.name}: skill exceeds 60 lines`);
  }
  return `${folders.length} skills with valid frontmatter`;
});
await gate("privacy-scan", () => {
  const bad: string[] = [];
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]);
  const patterns = [/\/Users\/[a-z]+\//u, /\/home\/[a-z]+\//u, /\.local\/share\/(?:wrench|ghostget)/u, /sk-[a-zA-Z0-9]{20,}/u, /ghp_[a-zA-Z0-9]{20,}/u, /npm_[a-zA-Z0-9]{20,}/u, /realmFingerprint":\s*"[0-9a-f]{64}/u];
  // tests/ carries deliberate redaction probes and is never packed (see npm-pack-scope).
  for (const top of ["bin", "src", "tools", "programs", "skills", "fixtures", "bench", "docs", "scripts", "README.md", "AGENTS.md", "package.json"]) {
    const path = join(PKG, top);
    if (!existsSync(path)) continue;
    const files = /\.(?:md|json)$/u.test(top) ? [path] : walk(path);
    for (const file of files) {
      if (file.endsWith(".png")) continue;
      const text = readFileSync(file, "utf8");
      for (const pattern of patterns) if (pattern.test(text)) bad.push(`${file.replace(PKG, ".")}: ${pattern}`);
    }
  }
  if (bad.length) throw new Error(bad.join("\n"));
  return "no private paths, state homes, fingerprints, or secret patterns";
});
await gate("npm-pack-scope", () => {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: PKG, encoding: "utf8" });
  const text = `${r.stdout}\n${r.stderr}`;
  const start = text.search(/^\s*\[/mu);
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error(`unexpected npm output: ${text.slice(0, 200)}`);
  const packed = JSON.parse(text.slice(start, end + 1))[0] as { files: Array<{ path: string }>; entryCount: number; size: number };
  for (const file of packed.files) {
    if (!/^(?:bin\/|src\/|tools\/|programs\/|skills\/|fixtures\/|bench\/report\/|docs\/|README\.md$|LICENSE$|AGENTS\.md$|package\.json$)/u.test(file.path)) throw new Error(`unexpected public file: ${file.path}`);
    if (/\.test\.ts$/u.test(file.path)) throw new Error(`test file in package: ${file.path}`);
  }
  return `${packed.entryCount} files, ${(packed.size / 1024).toFixed(1)} KiB`;
});

let failed = 0;
for (const result of results) {
  if (!result.ok) failed += 1;
  console.log(`${result.ok ? "PASS" : "FAIL"} ${result.gate.padEnd(28)} ${result.detail.split("\n")[0]}`);
  if (!result.ok) console.log(result.detail.split("\n").slice(1).map((line) => `     ${line}`).join("\n"));
}
process.exit(failed ? 1 : 0);
