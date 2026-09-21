#!/usr/bin/env bun
// run-bench — the ghostget-skills measured comparison.
//
// For every workflow we measure what would enter an agent's context:
//
//   baseline — the raw bytes an agent ingests doing the same job by hand:
//              the full Ghostget JSON envelopes it would read (catalog,
//              contract check, every invoke result, doctor, auth list, the
//              page capture), plus the skill prose it would re-read to plan
//              the sequence (the social-profile-stats reference) where that
//              applies.
//   program  — the bytes of the program's interface outputs, which is all a
//              consumer or model needs, plus receipt work counts.
//
// Deterministic: baselines are the recorded fixture documents themselves, so
// the comparison is byte-for-byte reproducible without provider access.
// Token figures are labelled estimates (ceil(bytes/4)); this is evidence
// about bytes and calls, not a billing or task-success claim.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../src/ghostget-cli.ts";
import { interfaceOutputs, packageTools, PKG, PROGRAMS_DIR, recordedDependencies, runProgram } from "../src/run-program.ts";
import { PLAN, planReads, invokeKey, recorded, type Scenario } from "../fixtures/recorded.ts";

const bytes = (value: unknown) => Buffer.byteLength(typeof value === "string" ? value : canonicalJson(value), "utf8");
const est = (b: number) => Math.ceil(b / 4);

/** Fingerprint of the sources the report depends on. */
export function benchFingerprint(): string {
  const hash = createHash("sha256");
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (!path.includes("/report/")) hash.update(path.replace(PKG, "")).update(readFileSync(path));
    }
  };
  for (const top of ["programs", "src", "tools", "fixtures", "bench"]) walk(join(PKG, top));
  return `sha256:${hash.digest("hex")}`;
}

type Workflow = {
  id: string;
  program: string;
  scenario: Scenario;
  args: Record<string, Record<string, unknown>>;
  /** Raw documents an agent would read by hand. */
  baseline: () => Array<{ label: string; bytes: number }>;
  /** The interface outputs a consumer or model actually reads; audit-only
   * echoes (the full check document, the memory slot) are excluded. */
  consumerOutputs: string[];
  assumptions: string[];
};

const responses = (scenario: Scenario) => recorded(scenario) as Record<string, { json?: unknown; stdout?: string } | Array<{ json?: unknown }>>;
const doc = (scenario: Scenario, key: string) => {
  const hit = responses(scenario)[key];
  if (hit === undefined) throw new Error(`missing fixture ${key}`);
  const one = Array.isArray(hit) ? hit[hit.length - 1]! : hit;
  return "stdout" in one && one.stdout !== undefined ? one.stdout : one.json;
};
const SOCIAL_STATS_REFERENCE_BYTES = readFileSync(join(PKG, "node_modules", "@hraness", "ghostget", "skills", "ghostget", "references", "social-profile-stats.md")).length;

const WORKFLOWS: Workflow[] = [
  {
    id: "capability-survey", program: "capability-survey", scenario: "clean", args: { src: { request: {} } }, consumerOutputs: ["survey", "summary"],
    baseline: () => [{ label: "contracts catalog --json (fixture, 4 adapters)", bytes: bytes(doc("clean", "contracts catalog")) }],
    assumptions: ["The fixture catalog has 4 adapters; the real installed catalog on a developer Mac measured 423,883 bytes from `ghostget capabilities --json` (23 adapters) on 2026-09-21, so the live reduction is larger than the fixture shows."],
  },
  {
    id: "plan-check", program: "plan-check", scenario: "gaps-and-retry", args: { src: { plan: PLAN } }, consumerOutputs: ["summary", "text"],
    baseline: () => [{ label: "contracts check --json", bytes: bytes(doc("gaps-and-retry", "contracts check --plan *")) }],
    assumptions: [],
  },
  {
    id: "profile-stats", program: "profile-stats", scenario: "clean", args: { src: { plan: PLAN, "scheduled-date": "2026-09-21" } }, consumerOutputs: ["run", "gaps", "escalations", "summary"],
    baseline: () => [
      { label: "social-profile-stats.md reference (re-read to plan the sequence)", bytes: SOCIAL_STATS_REFERENCE_BYTES },
      { label: "contracts check --json", bytes: bytes(doc("clean", "contracts check --plan *")) },
      ...planReads().map((read) => ({ label: `invoke ${read.adapter} ${read.operation} --json`, bytes: bytes(doc("clean", invokeKey(read))) })),
    ],
    assumptions: ["Baseline assumes the agent reads each invoke envelope once and the reference once per run; it does not count retry re-planning or the agent's own reasoning tokens."],
  },
  {
    id: "profile-stats-with-retry", program: "profile-stats", scenario: "gaps-and-retry", args: { src: { plan: PLAN, "scheduled-date": "2026-09-22" } }, consumerOutputs: ["run", "gaps", "escalations", "summary"],
    baseline: () => [
      { label: "social-profile-stats.md reference", bytes: SOCIAL_STATS_REFERENCE_BYTES },
      { label: "contracts check --json", bytes: bytes(doc("gaps-and-retry", "contracts check --plan *")) },
      ...planReads().filter((read) => read.adapter !== "linkedin-web").flatMap((read) => {
        const hit = responses("gaps-and-retry")[invokeKey(read)];
        const docs = Array.isArray(hit) ? hit : [hit];
        return docs.map((entry, index) => ({ label: `invoke ${read.adapter} ${read.operation} --json${docs.length > 1 ? ` (attempt ${index + 1})` : ""}`, bytes: bytes((entry as { json?: unknown })?.json) }));
      }),
    ],
    assumptions: ["Same as profile-stats; the retried read counts both envelopes."],
  },
  {
    id: "page-read", program: "page-read", scenario: "clean", args: { src: { url: "https://example.com", "max-bytes": 4000 } }, consumerOutputs: ["text"],
    baseline: () => [{ label: "ghostget read (text)", bytes: bytes(doc("clean", "read https://example.com --media none")) }],
    assumptions: ["example.com is tiny; page-read only wins on pages above the byte cap, and can measure negative on small pages."],
  },
  {
    id: "auth-health", program: "auth-health", scenario: "clean", args: {}, consumerOutputs: ["health", "summary"],
    baseline: () => [{ label: "doctor --json", bytes: bytes(doc("clean", "doctor")) }, { label: "auth list --json", bytes: bytes(doc("clean", "auth list")) }],
    assumptions: ["The fixture doctor document is small; the real `ghostget doctor --json` measured 245,286 bytes on 2026-09-21."],
  },
  {
    id: "drift-watch", program: "drift-watch", scenario: "drift", args: { src: { request: {} } }, consumerOutputs: ["drift", "summary"],
    baseline: () => [{ label: "contracts catalog --json (now)", bytes: bytes(doc("drift", "contracts catalog")) }, { label: "contracts catalog --json (baseline, re-read)", bytes: bytes(doc("clean", "contracts catalog")) }],
    assumptions: ["Baseline assumes the agent compares two catalog dumps by reading both."],
  },
];

async function main() {
  const workflows: Array<Record<string, unknown>> = [];
  let baselineTotal = 0;
  let programTotal = 0;
  for (const workflow of WORKFLOWS) {
    const dir = mkdtempSync(join(tmpdir(), "ghostget-skills-bench-"));
    const tools = packageTools(recordedDependencies(recorded(workflow.scenario)));
    const manifestPath = join(PROGRAMS_DIR, `${workflow.program}.algal.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (workflow.id === "drift-watch") {
      await runProgram({ manifestPath, args: workflow.args as never, dir, tools: packageTools(recordedDependencies(recorded("clean"))) });
    }
    const receipt = await runProgram({ manifestPath, args: workflow.args as never, dir, tools });
    const outputs = interfaceOutputs(manifest, receipt);
    const baseline = workflow.baseline();
    const baselineBytes = baseline.reduce((sum, entry) => sum + entry.bytes, 0);
    const consumed = Object.fromEntries(workflow.consumerOutputs.map((name) => [name, outputs[name] ?? null]));
    const programBytes = bytes(consumed);
    baselineTotal += baselineBytes;
    programTotal += programBytes;
    workflows.push({
      id: workflow.id, program: workflow.program, scenario: workflow.scenario, outcome: receipt.outcome,
      baseline_context_bytes: baselineBytes, baseline_items: baseline,
      program_context_bytes: programBytes, consumer_outputs: workflow.consumerOutputs, context_reduction_pct: Number((100 * (1 - programBytes / baselineBytes)).toFixed(1)),
      est_baseline_tokens: est(baselineBytes), est_program_tokens: est(programBytes),
      agent_calls: receipt.work.agentCalls, steps: receipt.work.steps, work_units: receipt.work.units, effects: receipt.effects.length,
      assumptions: workflow.assumptions,
    });
  }
  const report = {
    package: "ghostget-skills",
    generated_at: new Date().toISOString().slice(0, 10),
    source_fingerprint: benchFingerprint(),
    methodology: {
      baseline: "bytes of the raw Ghostget JSON/text an agent would read by hand for the same job, from the recorded fixtures (plus the skill reference where the agent must re-plan a sequence)",
      program: "bytes of the interface outputs a consumer reads (audit-only echoes such as the full check document and the memory slot are excluded)",
      tokens: "est = ceil(bytes/4); a labelled estimate, not provider usage",
      caveats: [
        "Fixtures are synthetic and small; live catalog and doctor documents are far larger, so live reductions for capability-survey and auth-health exceed the fixture figures.",
        "Byte reduction is not a task-success, latency, or billing claim.",
        "page-read only wins above its byte cap.",
      ],
    },
    totals: { baseline_context_bytes: baselineTotal, program_context_bytes: programTotal, context_reduction_pct: Number((100 * (1 - programTotal / baselineTotal)).toFixed(1)), agent_calls: 0 },
    workflows,
  };
  mkdirSync(join(PKG, "bench", "report"), { recursive: true });
  writeFileSync(join(PKG, "bench", "report", "bench-report.json"), `${JSON.stringify(report, null, 1)}\n`);
  console.log(`${report.totals.context_reduction_pct}% context-byte reduction across ${workflows.length} workflows (${baselineTotal} → ${programTotal} bytes)`);
  for (const row of workflows) console.log(`  ${String(row.id).padEnd(26)} ${String(row.baseline_context_bytes).padStart(7)} → ${String(row.program_context_bytes).padStart(6)}  ${String(row.context_reduction_pct).padStart(6)}%`);
}

if (import.meta.main) await main();
