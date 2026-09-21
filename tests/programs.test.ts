// Programs — admission, digests, recorded runs, replay, and the behaviours
// the skills promise. No Ghostget process, no network.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestCanonical, manifestToJson, parseOrganismManifest } from "@hraness/algal";
import type { JsonValue, RunReceipt } from "@hraness/algal";
import { interfaceOutputs, packageTools, PROGRAMS_DIR, recordedDependencies, runProgram, verifyRun } from "../src/run-program.ts";
import { aggregateRun, catalogDrift, normalizeRead, planRows } from "../src/fns.ts";
import { PLAN, recorded, catalogDocument, checkDocument, planReads, succeededEnvelope, failedEnvelope, invokeKey } from "../fixtures/recorded.ts";
import { pinAll } from "../scripts/pin-digests.ts";
import { CASES, smoke } from "../scripts/smoke.ts";

const manifestJson = (id: string) => JSON.parse(readFileSync(join(PROGRAMS_DIR, `${id}.algal.json`), "utf8"));
const manifestPath = (id: string) => join(PROGRAMS_DIR, `${id}.algal.json`);
const outputsOf = (id: string, receipt: RunReceipt) => interfaceOutputs(manifestJson(id), receipt) as Record<string, JsonValue>;

async function run(id: string, args: Record<string, Record<string, unknown>>, scenario: Parameters<typeof recorded>[0], dir = mkdtempSync(join(tmpdir(), "ghostget-skills-test-"))) {
  const misses: string[] = [];
  const receipt = await runProgram({ manifestPath: manifestPath(id), args: args as never, dir, tools: packageTools(recordedDependencies(recorded(scenario), (key) => misses.push(key))) });
  return { receipt, outputs: outputsOf(id, receipt), misses, dir };
}

describe("admission", () => {
  const files = readdirSync(PROGRAMS_DIR).filter((file) => file.endsWith(".algal.json"));
  test("every manifest parses and declares zero agent calls", () => {
    expect(files.length).toBe(8);
    for (const file of files) {
      const manifest = parseOrganismManifest(JSON.parse(readFileSync(join(PROGRAMS_DIR, file), "utf8")));
      expect(manifest.contract).toBe("algal.organism.v1");
      expect(manifest.budgets.maxAgentCalls).toBe(0);
    }
  });
  test("embedded digests are pinned to the canonical inner manifests", () => {
    const digest = (id: string) => digestCanonical(manifestToJson(parseOrganismManifest(manifestJson(id))));
    expect(manifestJson("profile-stat-read").cells.find((cell: { id: string }) => cell.id === "attempts").manifest).toBe(digest("profile-stat-attempt"));
    expect(manifestJson("profile-stats").cells.find((cell: { id: string }) => cell.id === "collect").manifest).toBe(digest("profile-stat-read"));
    expect(pinAll("check").stale).toEqual([]);
  });
  test("index.json names every fixed program", () => {
    const index = JSON.parse(readFileSync(join(PROGRAMS_DIR, "index.json"), "utf8")) as { programs: Array<{ id: string }> };
    expect(index.programs.map((program) => program.id).sort()).toEqual(files.map((file) => file.replace(".algal.json", "")).sort());
  });
});

describe("smoke and replay", () => {
  test("every packaged case completes and verifies bit-for-bit", async () => {
    const { rows, failures } = await smoke();
    expect(failures).toEqual([]);
    expect(rows.length).toBe(CASES.length);
    for (const row of rows) {
      expect(row.outcome).toBe("complete");
      expect(row.verified).toBe(true);
    }
  }, 120_000);
});

describe("profile-stats", () => {
  let clean: Awaited<ReturnType<typeof run>>;
  let gappy: Awaited<ReturnType<typeof run>>;
  beforeAll(async () => {
    clean = await run("profile-stats", { src: { plan: PLAN, "scheduled-date": "2026-09-21" } }, "clean");
    gappy = await run("profile-stats", { src: { plan: PLAN, "scheduled-date": "2026-09-22" } }, "gaps-and-retry");
  });
  test("clean run observes every account in plan order with the consumer run shape", () => {
    expect(clean.receipt.outcome).toBe("complete");
    expect(clean.misses).toEqual([]);
    const run = clean.outputs.run as { schemaVersion: number; scheduledDate: string; timezone: string; observations: Array<{ accountKey: string; metrics: Record<string, number>; observedAt: string }> };
    expect(run.schemaVersion).toBe(1);
    expect(run.timezone).toBe("America/New_York");
    expect(run.observations.map((o) => o.accountKey)).toEqual(PLAN.accounts.map((account) => account.accountKey));
    const substack = run.observations.find((o) => o.accountKey === "substack-hraness")!;
    expect(Object.keys(substack.metrics).sort()).toEqual(["followers", "freeSubscribers", "paidSubscribers"]);
    expect((clean.outputs.escalations as unknown[]).length).toBe(0);
    const gaps = clean.outputs.gaps as Array<Record<string, unknown>>;
    expect(gaps).toEqual([{ accountKey: "threads-hraness", adapter: "threads-web", operation: "profiles.read", metricKeys: ["recentViews"], reason: "not-authorized", stage: "read", expected: true, detail: null }]);
  });
  test("reads run sequentially in plan order and the LinkedIn company read waits 60 s", () => {
    const waits = Object.entries(clean.receipt.cells).filter(([path]) => /^collect\/i\d+\/attempts\/r0\/wait$/u.test(path)).map(([path, cell]) => [path, (cell.outputs?.report as { waitedMs: number }).waitedMs]);
    expect(waits[3]).toEqual(["collect/i3/attempts/r0/wait", 60000]);
    expect(waits.filter(([, ms]) => ms !== 0).length).toBe(1);
    const invokeOrder = clean.receipt.effects.filter((effect) => effect.executor === "tool:ghostget.invoke.read.v1").length;
    expect(invokeOrder).toBe(15);
  });
  test("check gaps never spend a provider read and escalate by kind", () => {
    const escalations = gappy.outputs.escalations as Array<Record<string, unknown>>;
    expect(escalations).toContainEqual({ kind: "recapture", accountKey: "linkedin-personal", adapter: "linkedin-web", operation: "profiles.read", reason: "state-mismatch" });
    expect(escalations).toContainEqual({ kind: "repair-auth", accountKey: "linkedin-company-hraness", adapter: "linkedin-web", operation: "organizations.read", reason: "auth-missing" });
    const linkedinInvokes = gappy.receipt.effects.filter((effect) => JSON.stringify(effect.output ?? {}).includes("linkedin.com"));
    expect(linkedinInvokes.length).toBe(0);
  });
  test("retry-once-after-60s earns exactly one retry round; repair-auth never retries", () => {
    // Check gaps (both LinkedIn reads) never reach the each cell, so item
    // indexes are plan indexes minus the gap rows before them.
    const rows = planReads().filter((read) => read.adapter !== "linkedin-web");
    const instagram = rows.findIndex((read) => read.adapter === "instagram-web");
    const tiktok = rows.findIndex((read) => read.adapter === "tiktok-web");
    const aichartsio = rows.findIndex((read) => read.adapter === "x-web" && read.input.handle === "aichartsio");
    expect(gappy.receipt.cells[`collect/i${instagram}/attempts`]?.rounds).toBe(2);
    expect((gappy.receipt.cells[`collect/i${instagram}/attempts/r1/wait`]?.outputs?.report as { waitedMs: number }).waitedMs).toBe(60000);
    expect(gappy.receipt.cells[`collect/i${tiktok}/attempts`]?.rounds).toBe(2);
    expect(gappy.receipt.cells[`collect/i${aichartsio}/attempts`]?.rounds).toBeUndefined();
    const run = gappy.outputs.run as { observations: Array<{ accountKey: string }> };
    expect(run.observations.some((o) => o.accountKey === "instagram-hraness")).toBe(true);
    expect(run.observations.some((o) => o.accountKey === "tiktok-hraness")).toBe(false);
    const escalations = gappy.outputs.escalations as Array<{ kind: string; accountKey: string; attempts: number | null }>;
    expect(escalations.find((e) => e.accountKey === "tiktok-hraness")).toMatchObject({ kind: "retry-later", attempts: 2 });
    expect(escalations.find((e) => e.accountKey === "x-aichartsio")).toMatchObject({ kind: "repair-auth", attempts: 1 });
  });
  test("last-good memory persists across runs and keeps prior accounts", async () => {
    const again = await run("profile-stats", { src: { plan: PLAN, "scheduled-date": "2026-09-23" } }, "gaps-and-retry", clean.dir);
    const memory = (again.outputs["last-good"] as Record<string, Record<string, { scheduledDate: string }>>)[PLAN.collectionKey]!;
    expect(memory["linkedin-personal"]?.scheduledDate).toBe("2026-09-21");
    expect(memory["instagram-hraness"]?.scheduledDate).toBe("2026-09-23");
    expect(again.receipt.cells.memory?.slot).toEqual({ name: "profile-stats-last-good", mode: "read" });
  });
  test("a throwing tool is handled by the on:fail edge, never fails the run", async () => {
    const tools = packageTools(recordedDependencies(recorded("clean")));
    const entry = tools.get("ghostget.invoke.read.v1")!;
    tools.set("ghostget.invoke.read.v1", { ...entry, tool: async () => { throw new Error("boom"); } });
    const receipt = await runProgram({ manifestPath: manifestPath("profile-stats"), args: { src: { plan: PLAN, "scheduled-date": "2026-09-21" } } as never, dir: mkdtempSync(join(tmpdir(), "ghostget-skills-test-")), tools });
    expect(receipt.outcome).toBe("complete");
    const outputs = outputsOf("profile-stats", receipt);
    expect((outputs.run as { observations: unknown[] }).observations).toEqual([]);
    const escalations = outputs.escalations as Array<{ kind: string; reason: string }>;
    expect(escalations.length).toBe(15);
    expect(escalations.every((e) => e.kind === "doctor" && e.reason === "tool-failed")).toBe(true);
  });
  test("the receipt replays without Ghostget and fails closed on a tampered effect", async () => {
    const manifest = manifestJson("profile-stats");
    const ok = await verifyRun(JSON.parse(JSON.stringify(clean.receipt)), manifest, clean.dir);
    expect(ok.ok).toBe(true);
    const tampered = JSON.parse(JSON.stringify(clean.receipt)) as RunReceipt;
    const effect = tampered.effects.find((e) => e.executor === "tool:ghostget.invoke.read.v1")!;
    (effect.output as { report: { output: { metrics: { followers: { value: number } } } } }).report.output.metrics.followers.value += 1;
    const bad = await verifyRun(tampered as unknown as JsonValue, manifest, clean.dir);
    expect(bad.ok).toBe(false);
  });
});

describe("other programs", () => {
  test("capability-survey reduces the catalog to counts and R1 reads", async () => {
    const { outputs } = await run("capability-survey", { src: { request: {} } }, "clean");
    expect(outputs.summary).toBe("4 adapters, 5 observed operations (4 R1 reads), 2 capture-required");
    const survey = outputs.survey as { reads: Array<{ adapter: string; authority: string }> };
    expect(survey.reads.map((read) => `${read.adapter}:${read.authority}`)).toEqual(["bluesky-web:public", "github-web:public", "github-web:public", "x-web:auth"]);
  });
  test("plan-check summarises verdicts", async () => {
    const { outputs } = await run("plan-check", { src: { plan: PLAN } }, "gaps-and-retry");
    expect(outputs.text).toBe("13/15 reads ok; gaps: linkedin-personal linkedin-web profiles.read (state-mismatch); linkedin-company-hraness linkedin-web organizations.read (auth-missing)");
  });
  test("page-read formats provenance then the body", async () => {
    const { outputs } = await run("page-read", { src: { url: "https://example.com", "max-bytes": 4000 } }, "clean");
    expect(String(outputs.text).startsWith("[Example Domain · https://example.com/ · 168B]\n# Example Domain")).toBe(true);
  });
  test("auth-health never leaks subjects or the state home", async () => {
    const { outputs } = await run("auth-health", {}, "clean");
    const text = JSON.stringify(outputs);
    expect(text).not.toContain("subject");
    expect(text).not.toContain("state-home");
    expect(outputs.summary).toContain("3 auth locators");
  });
  test("drift-watch reports no drift when the catalog is unchanged", async () => {
    // The baseline round-trips through the store, which canonicalises key
    // order; a naive string compare reported every operation as drift.
    const first = await run("drift-watch", { src: { request: {} } }, "clean");
    expect((first.outputs.drift as { firstBaseline: boolean }).firstBaseline).toBe(true);
    const second = await run("drift-watch", { src: { request: {} } }, "clean", first.dir);
    const drift = second.outputs.drift as { firstBaseline: boolean; changed: unknown[]; added: unknown[]; removed: unknown[]; total: number };
    expect(drift.firstBaseline).toBe(false);
    expect(drift.changed).toEqual([]);
    expect(drift.added).toEqual([]);
    expect(drift.removed).toEqual([]);
    expect(second.outputs.summary).toBe(`0 changed, 0 added, 0 removed of ${String(drift.total)} operations`);
  });
  test("drift-watch records a baseline, then reports drift on a changed contract", async () => {
    const first = await run("drift-watch", { src: { request: {} } }, "clean");
    expect((first.outputs.drift as { firstBaseline: boolean }).firstBaseline).toBe(true);
    const second = await run("drift-watch", { src: { request: {} } }, "drift", first.dir);
    const drift = second.outputs.drift as { changed: Array<{ operation: string; fields: string[] }>; added: string[]; removed: string[] };
    expect(drift.changed.map((c) => c.operation).sort()).toEqual(["bluesky-web/messaging.list", "bluesky-web/posts.publish", "bluesky-web/profiles.read", "github-web/organizations.read", "github-web/profiles.read", "x-web/articles.publish", "x-web/profiles.read"]);
    expect(drift.changed.find((c) => c.operation === "x-web/profiles.read")?.fields).toEqual(["state", "contractHash"]);
    expect(second.outputs.summary).toBe("7 changed, 0 added, 0 removed of 7 operations");
  });
});

describe("pure functions", () => {
  const read = planReads().find((r) => r.adapter === "threads-web")!;
  test("normalizeRead accepts exact counts and classifies expected gaps", () => {
    const attempt = { next: "stop", attempts: 1, report: { ok: true, status: "succeeded", output: succeededEnvelope(read, { followers: 93, recentViews: { unavailable: "not-authorized" } }).output } };
    const { result } = normalizeRead({ read: read as never, attempt: attempt as never }) as { result: Record<string, unknown> };
    expect(result.status).toBe("observed");
    expect(result.metrics).toEqual({ followers: 93 });
    expect(result.gaps).toEqual([{ metricKey: "recentViews", reason: "not-authorized", expected: true }]);
    expect(result.escalation).toBe("none");
  });
  test("normalizeRead rejects rounded, negative, and mismatched-target values", () => {
    const rounded = succeededEnvelope(read, { followers: 93 }).output as { metrics: Record<string, unknown>; target: { url: string } };
    rounded.metrics.followers = { precision: "rounded", status: "available", unit: "count", value: 100 };
    rounded.metrics.recentViews = { precision: "exact", status: "available", unit: "count", value: -1 };
    const { result } = normalizeRead({ read: read as never, attempt: { report: { ok: true, output: rounded } } as never }) as { result: Record<string, unknown> };
    expect(result.status).toBe("gap");
    expect(result.escalation).toBe("review-metric");
    rounded.target.url = "https://www.threads.com/@someone-else";
    const mismatch = normalizeRead({ read: read as never, attempt: { report: { ok: true, output: rounded } } as never }).result as Record<string, unknown>;
    expect(mismatch.reason).toBe("target-mismatch");
  });
  test("normalizeRead maps every closed failure category to an escalation", () => {
    for (const [category, escalation] of Object.entries({ "auth-repair-required": "repair-auth", "account-mismatch": "rebind", "contract-drift": "recapture", "cleanup-required": "doctor", "target-unavailable": "review-target", "provider-throttled": "retry-later" })) {
      const failed = failedEnvelope(read, category, "do-not-retry");
      const { result } = normalizeRead({ read: read as never, attempt: { report: { ok: false, status: "failed", readFailure: { category, retryDisposition: failed.readFailure.retryDisposition } } } }) as { result: Record<string, unknown> };
      expect(result.escalation).toBe(escalation);
      expect(result.reason).toBe(category);
    }
  });
  test("planRows routes check-unavailable plans entirely to gaps", () => {
    const { rows, gaps } = planRows({ plan: PLAN as never, check: { ok: false, status: "malformed", diagnostic: "no check document" } }) as { rows: unknown[]; gaps: Array<{ reason: string }> };
    expect(rows).toEqual([]);
    expect(gaps.length).toBe(15);
    expect(gaps.every((gap) => gap.reason === "check-unavailable")).toBe(true);
    const good = planRows({ plan: PLAN as never, check: { ok: true, status: "succeeded", check: checkDocument() } }) as { rows: unknown[] };
    expect(good.rows.length).toBe(15);
  });
  test("aggregateRun merges same-account reads and keeps plan order", () => {
    const { run, summary } = aggregateRun({ plan: PLAN as never, results: [
      { accountKey: "substack-hraness", status: "observed", metrics: { freeSubscribers: 1 }, observedAt: "2026-09-21T00:00:02.000Z", gaps: [], escalation: "none" },
      { accountKey: "substack-hraness", status: "observed", metrics: { followers: 2 }, observedAt: "2026-09-21T00:00:01.000Z", gaps: [], escalation: "none" },
      { accountKey: "x-hraness", status: "observed", metrics: { followers: 3 }, observedAt: "2026-09-21T00:00:03.000Z", gaps: [], escalation: "none" },
    ], "plan-gaps": [], "scheduled-date": "2026-09-21", timezone: "America/New_York", "last-good": {} }) as unknown as { run: { observations: Array<{ accountKey: string; metrics: Record<string, number>; observedAt: string }> }; summary: string };
    expect(run.observations.map((o) => o.accountKey)).toEqual(["x-hraness", "substack-hraness"]);
    expect(run.observations[1]).toEqual({ accountKey: "substack-hraness", metrics: { freeSubscribers: 1, followers: 2 }, observedAt: "2026-09-21T00:00:02.000Z" });
    expect(summary).toBe("hraness-social-profile-statistics 2026-09-21: 2 accounts observed, 0 unexpected gaps, 0 expected, 0 escalations");
  });
  test("catalogDrift keeps the baseline when the catalog is unavailable", () => {
    const { drift, baseline } = catalogDrift({ report: { ok: false, status: "malformed" }, baseline: { operations: { "a/b": {} } } }) as unknown as { drift: { ok: boolean }; baseline: unknown };
    expect(drift.ok).toBe(false);
    expect(baseline).toEqual({ operations: { "a/b": {} } });
    const first = catalogDrift({ report: { ok: true, status: "succeeded", catalog: catalogDocument() as never }, baseline: {} }) as unknown as { drift: { firstBaseline: boolean; total: number } };
    expect(first.drift.firstBaseline).toBe(true);
    expect(first.drift.total).toBe(7);
  });
});
