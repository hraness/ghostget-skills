#!/usr/bin/env bun
// smoke — run every packaged program against recorded Ghostget responses and
// replay each receipt with `verify`. No provider access. Used by check.ts.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageTools, PROGRAMS_DIR, recordedDependencies, runProgram, verifyRun } from "../src/run-program.ts";
import { PLAN, recorded, type Scenario } from "../fixtures/recorded.ts";

type Case = { program: string; scenario: Scenario; args: Record<string, Record<string, unknown>>; expectOutcome?: string };

export const CASES: Case[] = [
  { program: "capability-survey", scenario: "clean", args: { src: { request: {} } } },
  { program: "plan-check", scenario: "gaps-and-retry", args: { src: { plan: PLAN } } },
  { program: "page-read", scenario: "clean", args: { src: { url: "https://example.com", "max-bytes": 4000 } } },
  { program: "auth-health", scenario: "clean", args: {} },
  { program: "drift-watch", scenario: "clean", args: { src: { request: {} } } },
  { program: "profile-stats", scenario: "clean", args: { src: { plan: PLAN, "scheduled-date": "2026-09-21" } } },
  { program: "profile-stats", scenario: "gaps-and-retry", args: { src: { plan: PLAN, "scheduled-date": "2026-09-22", timezone: "America/New_York" } } },
];

export async function smoke(verbose = false) {
  const failures: string[] = [];
  const rows: Array<{ program: string; scenario: string; outcome: string; steps: number; effects: number; verified: boolean; summary: string }> = [];
  for (const c of CASES) {
    const dir = mkdtempSync(join(tmpdir(), "ghostget-skills-smoke-"));
    const misses: string[] = [];
    const tools = packageTools(recordedDependencies(recorded(c.scenario), (key) => misses.push(key)));
    const manifestPath = join(PROGRAMS_DIR, `${c.program}.algal.json`);
    const receipt = await runProgram({ manifestPath, args: c.args as never, dir, tools });
    const report = await verifyRun(JSON.parse(JSON.stringify(receipt)), JSON.parse(readFileSync(manifestPath, "utf8")), dir);
    const outputs = (receipt as unknown as { outputs?: Record<string, unknown> }).outputs ?? {};
    const summary = typeof outputs.summary === "string" ? outputs.summary : typeof outputs.text === "string" ? outputs.text.split("\n")[0] ?? "" : "";
    rows.push({ program: c.program, scenario: c.scenario, outcome: receipt.outcome, steps: receipt.work.steps, effects: receipt.effects.length, verified: report.ok, summary });
    if (receipt.outcome !== (c.expectOutcome ?? "complete")) failures.push(`${c.program}/${c.scenario}: outcome ${receipt.outcome} ${JSON.stringify(receipt.failure ?? null)}`);
    if (!report.ok) failures.push(`${c.program}/${c.scenario}: verify failed ${JSON.stringify(report).slice(0, 300)}`);
    if (misses.length) failures.push(`${c.program}/${c.scenario}: unrecorded calls ${misses.join(" | ").slice(0, 300)}`);
    if (verbose) {
      for (const [path, cell] of Object.entries(receipt.cells)) {
        if (cell.status !== "committed") console.log(`  ${c.program} ${path} ${cell.status} ${JSON.stringify(cell.failure ?? null)}`);
      }
      console.log(`  outputs: ${JSON.stringify(outputs).slice(0, 600)}`);
    }
  }
  return { rows, failures };
}

if (import.meta.main) {
  const { rows, failures } = await smoke(process.argv.includes("--verbose"));
  for (const row of rows) console.log(`${row.outcome.padEnd(9)} ${row.program.padEnd(18)} ${row.scenario.padEnd(15)} steps=${row.steps} effects=${row.effects} verify=${row.verified} ${row.summary}`);
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
}
