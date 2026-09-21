// Recorded Ghostget responses for offline runs: tests, the check gate, and the
// bench. Shapes follow the real `ghostget … --json` envelopes (invoke result
// schemaVersion 4 receipts, profile-stat output v1) and the frozen contracts
// documents from docs/seam.md. Values are synthetic; identifiers are the
// public Hraness handles already published on hraness.com. No cookies,
// subjects, paths, or run identifiers beyond fixed synthetic ones.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, type RecordedResponse, type RecordedResponses } from "../src/ghostget-cli.ts";

const FIXTURES = new URL(".", import.meta.url).pathname;
export const PLAN = JSON.parse(readFileSync(join(FIXTURES, "plan.hraness.json"), "utf8")) as {
  collectionKey: string;
  accounts: Array<{ accountKey: string; reads: Array<Record<string, unknown>> }>;
};

type Read = {
  index: number;
  accountKey: string;
  adapter: string;
  operation: string;
  authority: { kind: "public" } | { kind: "auth"; authId: string };
  input: Record<string, unknown>;
  expectedOutput: { provider: string; targetUrl: string };
  metricKeys: string[];
};

export function planReads(plan = PLAN): Read[] {
  const reads: Read[] = [];
  let index = 0;
  for (const account of plan.accounts) {
    for (const read of account.reads) {
      reads.push({ index, accountKey: account.accountKey, ...(read as Omit<Read, "index" | "accountKey">) });
      index += 1;
    }
  }
  return reads;
}

export function invokeKey(read: Read): string {
  const auth = read.authority.kind === "auth" ? ` --auth ${read.authority.authId}` : "";
  return `invoke ${read.adapter} ${read.operation} --input -${auth} <<< ${canonicalJson(read.input)}`;
}

const HASH = (seed: string) => {
  let h = 0x811c9dc5;
  for (const char of seed) h = Math.imul(h ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(8);
};

export function succeededEnvelope(read: Read, metrics: Record<string, number | { unavailable: string }>, at = "2026-09-21T15:25:00.000Z") {
  const metricRecords: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metrics)) {
    metricRecords[key] = typeof value === "number"
      ? { precision: "exact", status: "available", unit: "count", value }
      : { status: "unavailable", reason: value.unavailable };
  }
  const authKind = read.authority.kind === "auth" ? "browser-profile" : "public-web-session";
  return {
    ok: true,
    status: "succeeded",
    runId: `00000000-0000-4000-8000-${HASH(invokeKey(read)).slice(0, 12)}`,
    replayed: false,
    receipt: {
      runId: `00000000-0000-4000-8000-${HASH(invokeKey(read)).slice(0, 12)}`,
      planDigest: null,
      adapter: { id: read.adapter, version: "1.0.0", hash: HASH(`adapter:${read.adapter}`) },
      operation: read.operation,
      risk: "R1",
      inputHash: HASH(canonicalJson(read.input)),
      auth: { id: read.authority.kind === "auth" ? read.authority.authId : `public-${HASH("public").slice(0, 32)}`, hash: HASH("auth"), kind: authKind },
      status: "succeeded",
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
      startedAt: at,
      finishedAt: at,
      finalOrigin: new URL(read.expectedOutput.targetUrl).origin,
      error: null,
      schemaVersion: 4,
      transport: "web-session-api",
      webSessionContractHash: HASH(`contract:${read.adapter}/${read.operation}`),
    },
    output: {
      completeness: "complete",
      metadata: { handle: String(Object.values(read.input)[0] ?? "") },
      metrics: metricRecords,
      observedAt: at,
      provider: read.expectedOutput.provider,
      schemaVersion: 1,
      target: { id: HASH(read.expectedOutput.targetUrl).slice(0, 16), kind: read.operation === "organizations.read" ? "organization" : "profile", url: read.expectedOutput.targetUrl },
    },
    source: "live",
    cache: { status: "stored", publication: { key: HASH("cache"), dataRevision: HASH("rev"), validatedAt: at, dataChangedAt: at, disposition: "created" } },
  };
}

export function failedEnvelope(read: Read, category: string, retryDisposition: string) {
  const base = succeededEnvelope(read, {});
  return {
    ok: false,
    status: "failed",
    runId: base.runId,
    replayed: false,
    receipt: { ...base.receipt, status: "failed", error: { code: category } },
    readFailure: { category, retryDisposition },
    source: "live",
  };
}

/** Synthetic metric values per account (stable, plausible, public). */
const METRICS: Record<string, Record<string, number | { unavailable: string }>> = {
  "x-web/profiles.read/hraness": { followers: 10702, following: 7714 },
  "x-web/profiles.read/aichartsio": { followers: 412, following: 18 },
  "linkedin-web/profiles.read": { followers: 2510, connections: 1820 },
  "linkedin-web/organizations.read": { followers: 96 },
  "youtube-web/profiles.read": { subscribers: 11, videos: 19, views: 3319 },
  "twitch-web/profiles.read": { followers: 0 },
  "bluesky-web/profiles.read": { followers: 63, following: 214, posts: 62 },
  "instagram-web/profiles.read": { followers: 154, following: 61, posts: 23 },
  "threads-web/profiles.read": { followers: 93, recentViews: { unavailable: "not-authorized" } },
  "substack-web/profiles.read": { followers: 224 },
  "substack-web/organizations.read": { freeSubscribers: 166, paidSubscribers: 6 },
  "github-web/profiles.read": { followers: 166, following: 118, publicRepositories: 92 },
  "github-web/organizations.read": { stars: 70, followers: 13 },
  "tiktok-web/profiles.read": { followers: 40, following: 46, likes: 129 },
  "reddit-web/profiles.read": { followers: 8, karma: 878, contributions: 183 },
};

function metricsFor(read: Read): Record<string, number | { unavailable: string }> {
  const handle = String(read.input.handle ?? "");
  return METRICS[`${read.adapter}/${read.operation}/${handle}`] ?? METRICS[`${read.adapter}/${read.operation}`] ?? Object.fromEntries(read.metricKeys.map((key) => [key, 1]));
}

/** The check document the frozen `ghostget contracts check` emits. */
export function checkDocument(plan = PLAN, gaps: Record<number, { reason: string; detail: string }> = {}) {
  const reads = planReads(plan).map((read) => {
    const gap = gaps[read.index];
    return gap
      ? { index: read.index, accountKey: read.accountKey, adapter: read.adapter, operation: read.operation, verdict: "gap", gap }
      : {
          index: read.index, accountKey: read.accountKey, adapter: read.adapter, operation: read.operation, verdict: "ok",
          binding: { adapterVersion: "1.0.0", contractVersion: 1, contractHash: HASH(`contract:${read.adapter}/${read.operation}`), transport: "web-session-api", authority: read.authority.kind },
        };
  });
  return {
    ok: Object.keys(gaps).length === 0,
    contract: "ghostget.contract-check.v1",
    ghostget: { version: "0.18.23" },
    plan: { collectionKey: plan.collectionKey, reads: reads.length },
    reads,
  };
}

/** A compact catalog document with four adapters. */
export function catalogDocument(options: { drift?: boolean } = {}) {
  const op = (id: string, risk: string, state: string, authority: string, inputs: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id, transport: "web-session-api", authority, risk, sideEffect: risk === "R1" ? "none" : "Publishes one post.", idempotency: risk === "R1" ? "none" : "local-at-most-once",
    dedupeWindowMs: risk === "R1" ? 0 : 86400000, state, contractVersion: 1, contractHash: HASH(`contract:${id}${options.drift ? ":v2" : ""}`),
    input: { properties: inputs, required: Object.keys(inputs) }, ...extra,
  });
  return {
    ok: true,
    contract: "ghostget.contract-catalog.v1",
    ghostget: { version: "0.18.23" },
    generatedAt: "2026-09-21T15:00:00.000Z",
    vocabulary: {
      risks: ["R1", "R2", "R3", "R4"], states: ["observed", "capture-required"],
      transports: ["web-session-api", "provider-api", "local-cli", "reviewed-template-api"], authorities: ["public", "auth"],
      readFailure: { "target-unavailable": "do-not-retry", "auth-repair-required": "repair-auth", "account-mismatch": "do-not-retry", "contract-drift": "do-not-retry", "cleanup-required": "do-not-retry", "provider-throttled": "retry-once-after-60s", "provider-temporary": "retry-once-after-60s", "operation-timeout": "retry-once-after-60s" },
      invokeStatuses: ["succeeded", "failed"],
    },
    adapters: [
      { id: "bluesky-web", version: "1.7.0", surfaceId: "bluesky", manifestHash: HASH("bluesky"), origins: ["https://bsky.app"], operations: [
        op("profiles.read", "R1", "observed", "public", { handle: { type: "string", description: "Bluesky handle", minLength: 1, maxLength: 253 } }),
        op("posts.publish", "R3", "observed", "auth", { text: { type: "string", description: "Post text", minLength: 1, maxLength: 300 } }),
        op("messaging.list", "R1", "capture-required", "auth", {}),
      ] },
      { id: "github-web", version: "1.2.0", surfaceId: "github", manifestHash: HASH("github"), origins: ["https://github.com"], operations: [
        op("profiles.read", "R1", "observed", "public", { username: { type: "string", description: "GitHub login", minLength: 1, maxLength: 39 } }),
        op("organizations.read", "R1", "observed", "public", { organization: { type: "string", description: "GitHub organization", minLength: 1, maxLength: 39 } }),
      ] },
      { id: "x-web", version: "1.14.0", surfaceId: "x", manifestHash: HASH("x"), origins: ["https://x.com"], operations: [
        op("profiles.read", "R1", options.drift ? "capture-required" : "observed", "auth", { handle: { type: "string", description: "X handle", minLength: 1, maxLength: 15 } }),
        op("articles.publish", "R3", "capture-required", "auth", { draft_id: { type: "string", description: "Draft", minLength: 1, maxLength: 19 } }),
      ] },
      { id: "broken-web", invalid: true, issues: ["manifest.operations must be an object"] },
    ],
  };
}

export function doctorDocument() {
  return {
    ok: true,
    capture: { schemaVersion: 2, bun: { status: "ready" } , ok: true },
    media: { ok: true, checks: [] },
    ghostget: {
      home: "<state-home>", mediaArchiveReady: true, installedAdapters: 23,
      configuredAuth: [{ id: "x-chrome", kind: "cookie-source" }, { id: "linkedin-chrome", kind: "browser-profile" }, { id: "gmail-main", kind: "oauth-token-file" }],
      browserCaptureBootstrapReady: true, browserActionReady: false, providerApiReady: false, webSessionApiReady: true,
      webSessionAdapters: ["bluesky-web", "github-web", "x-web"], webSessionSites: [], localCliReady: true, localCliProviders: [],
      reviewedTemplateApiReady: false, officialProviders: [], linkedDeviceProtocols: [], activeDerivations: [], unsettledRuns: [{ runId: "r1" }, { runId: "r2" }],
      confirmationClaimRecovery: { inspected: 0, released: 0, invalid: 0, active: 0 },
      runJournalRecovery: { inspected: 4, repaired: 0, projected: 4, invalid: 0, issues: [] },
      webSessionCleanupAdmissionRecovery: { scanned: 0, repaired: 0, active: 0, retained: 1, invalid: 0, issues: [] },
      linkedDeviceLifecycleRecovery: { scanned: 0, complete: 0, live: 0, repairedSafeRetry: 0, repairedIndeterminate: 0, invalid: 0, blockedAuthIds: [], blockedRealmKeys: [], issues: [] },
      mutationPolicy: "R2/R3 preview+digest confirmation; R4 blocked",
    },
  };
}

export function authListDocument() {
  return {
    ok: true,
    auth: [
      { id: "x-chrome", kind: "cookie-source", realmFingerprint: HASH("x"), subject: "<redacted-by-fixture>", provider: null },
      { id: "linkedin-chrome", kind: "browser-profile", realmFingerprint: HASH("li"), subject: "<redacted-by-fixture>", provider: null },
      { id: "gmail-main", kind: "oauth-token-file", realmFingerprint: HASH("g"), subject: "<redacted-by-fixture>", provider: "gmail" },
    ],
  };
}

export const PAGE_TEXT = `---
title: "Example Domain"
source: "https://example.com/"
clipped: "2026-09-21"
platform: "generic"
capture_status: "complete"
capture_method: "http"
capture_scope: "page"
---
# Example Domain

This domain is for use in documentation examples without needing permission. Avoid use in operations.

[Learn more](https://iana.org/domains/example)
`;

export type Scenario = "clean" | "gaps-and-retry" | "drift";

/** Build the recorded response map for one scenario. */
export function recorded(scenario: Scenario = "clean"): RecordedResponses {
  const reads = planReads();
  const responses: Record<string, RecordedResponse | RecordedResponse[]> = {};
  const gaps: Record<number, { reason: string; detail: string }> = {};
  if (scenario === "gaps-and-retry") {
    // LinkedIn personal is parked capture-required; the company read has no locator.
    const linkedinPersonal = reads.find((read) => read.adapter === "linkedin-web" && read.operation === "profiles.read")!;
    const linkedinCompany = reads.find((read) => read.adapter === "linkedin-web" && read.operation === "organizations.read")!;
    gaps[linkedinPersonal.index] = { reason: "state-mismatch", detail: "installed state is capture-required; plan requires observed" };
    gaps[linkedinCompany.index] = { reason: "auth-missing", detail: "auth locator linkedin-chrome is not stored" };
  }
  responses["contracts check --plan *"] = { json: checkDocument(PLAN, gaps), code: Object.keys(gaps).length ? 4 : 0 };
  responses["contracts catalog"] = { json: catalogDocument({ drift: scenario === "drift" }) };
  responses["contracts catalog --adapter bluesky-web"] = { json: { ...catalogDocument(), adapters: catalogDocument().adapters.filter((a) => a.id === "bluesky-web") } };
  responses["doctor"] = { json: doctorDocument() };
  responses["auth list"] = { json: authListDocument() };
  responses["read https://example.com --media none"] = { stdout: PAGE_TEXT };
  for (const read of reads) {
    const key = invokeKey(read);
    if (scenario === "gaps-and-retry" && read.adapter === "instagram-web") {
      // First attempt times out, the retry succeeds — exercises the repeat cell.
      responses[key] = [
        { json: failedEnvelope(read, "operation-timeout", "retry-once-after-60s"), code: 1 },
        { json: succeededEnvelope(read, metricsFor(read), "2026-09-21T15:27:30.000Z") },
      ];
    } else if (scenario === "gaps-and-retry" && read.adapter === "x-web" && read.input.handle === "aichartsio") {
      // Auth repair: never retried, escalated.
      responses[key] = { json: failedEnvelope(read, "auth-repair-required", "repair-auth"), code: 1 };
    } else if (scenario === "gaps-and-retry" && read.adapter === "tiktok-web") {
      // Throttled twice: the retry budget is one, so this stays a gap.
      responses[key] = { json: failedEnvelope(read, "provider-throttled", "retry-once-after-60s"), code: 1 };
    } else {
      responses[key] = { json: succeededEnvelope(read, metricsFor(read)) };
    }
  }
  return responses;
}

if (import.meta.main) {
  const scenario = (process.argv[2] ?? "clean") as Scenario;
  process.stdout.write(`${JSON.stringify(recorded(scenario), null, 1)}\n`);
}
