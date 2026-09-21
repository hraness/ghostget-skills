// fns — the pure, host-registered functions ghostget-skills programs compose.
//
// `fn` cells are the ALGAL primitive for reviewed deterministic logic that
// the expr language cannot express (record construction with computed
// values). They take JSON in, return JSON out, never touch IO, and replay by
// re-execution under `verify`. Every function here is total: malformed input
// yields a structured gap, never a throw, so an organism's shape decides
// what happens next.

import { builtinRegistry } from "@hraness/algal";
import type { FnRegistry, JsonValue } from "@hraness/algal";

type Json = JsonValue;
type JsonRecord = { [key: string]: Json };
type Inputs = Record<string, Json>;

export const ESCALATIONS = Object.freeze({
  "auth-repair-required": "repair-auth",
  "account-mismatch": "rebind",
  "contract-drift": "recapture",
  "cleanup-required": "doctor",
  "target-unavailable": "review-target",
  "provider-throttled": "retry-later",
  "provider-temporary": "retry-later",
  "operation-timeout": "retry-later",
} as const);

const CHECK_GAP_ESCALATIONS: Readonly<Record<string, string>> = Object.freeze({
  "adapter-missing": "install-adapter",
  "adapter-invalid": "install-adapter",
  "operation-missing": "review-plan",
  "state-mismatch": "recapture",
  "risk-mismatch": "review-plan",
  "side-effect-mismatch": "review-plan",
  "authority-mismatch": "review-plan",
  "input-invalid": "review-plan",
  "auth-missing": "repair-auth",
  "transport-disabled": "review-plan",
});

function isRecord(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

function strings(value: unknown): string[] {
  return list(value).filter((entry): entry is string => typeof entry === "string");
}

function safeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// ----------------------------------------------------------- plan rows -----

/** Flatten plan reads in order, splitting them by the check verdict. */
export function planRows(inputs: Inputs): { rows: Json; gaps: Json } {
  const plan = isRecord(inputs.plan) ? inputs.plan : {};
  const check = isRecord(inputs.check) ? inputs.check : {};
  const checkDoc = isRecord(check.check) ? check.check : check;
  const verdicts = new Map<number, Record<string, Json>>();
  for (const entry of list(checkDoc.reads)) {
    if (isRecord(entry) && typeof entry.index === "number") verdicts.set(entry.index, entry);
  }
  const checkUsable = check.ok === true || check.status === "succeeded";
  const rows: JsonRecord[] = [];
  const gaps: JsonRecord[] = [];
  let index = 0;
  for (const account of list(plan.accounts)) {
    if (!isRecord(account)) continue;
    const accountKey = str(account.accountKey) ?? `account-${index}`;
    for (const read of list(account.reads)) {
      if (!isRecord(read)) continue;
      const base: JsonRecord = {
        index,
        accountKey,
        adapter: str(read.adapter),
        operation: str(read.operation),
        authority: isRecord(read.authority) ? read.authority : { kind: "public" },
        input: isRecord(read.input) ? read.input : {},
        expectedOutput: isRecord(read.expectedOutput) ? read.expectedOutput : {},
        metricKeys: strings(read.metricKeys),
        expectedCategoricalGaps: list(read.expectedCategoricalGaps),
        requiredDelayBeforeMs: safeCount(read.requiredDelayBeforeMs) ?? 0,
      };
      const verdict = verdicts.get(index);
      if (!checkUsable) {
        gaps.push({ ...base, reason: "check-unavailable", escalation: "doctor", detail: str(check.diagnostic) ?? str(check.status) ?? "contract check did not run" });
      } else if (verdict === undefined) {
        gaps.push({ ...base, reason: "check-missing", escalation: "review-plan", detail: "contract check returned no verdict for this read" });
      } else if (verdict.verdict !== "ok") {
        const gap = isRecord(verdict.gap) ? verdict.gap : {};
        const reason = str(gap.reason) ?? "check-gap";
        gaps.push({ ...base, reason, escalation: CHECK_GAP_ESCALATIONS[reason] ?? "review-plan", detail: str(gap.detail) ?? "" });
      } else {
        rows.push({ ...base, binding: isRecord(verdict.binding) ? verdict.binding : {} });
      }
      index += 1;
    }
  }
  return { rows, gaps };
}

// ----------------------------------------------------- attempt summary -----

/** One invoke attempt → the repeat cell's stop/retry decision plus the report. */
export function attemptDecision(inputs: Inputs): { attempt: Json } {
  const raw = isRecord(inputs.report) ? inputs.report : {};
  // A failure record delivered over an on:"fail" edge ({code, message}) is a
  // tool-level failure, never a provider verdict: stop, never retry.
  const report: Record<string, Json> = typeof raw.code === "string" && raw.status === undefined
    ? { ok: false, status: "tool-failed", code: raw.code, diagnostic: str(raw.message) ?? "" }
    : raw;
  const readFailure = isRecord(report.readFailure) ? report.readFailure : null;
  const disposition = readFailure ? str(readFailure.retryDisposition) : null;
  const retry = report.ok !== true && disposition === "retry-once-after-60s";
  const attempts = safeCount(inputs["attempt-no"]) ?? 1;
  return { attempt: { next: retry ? "retry" : "stop", attempts, report } };
}

// ------------------------------------------------------- normalization -----

type MetricOutcome =
  | { kind: "value"; value: number }
  | { kind: "gap"; reason: string; expected: boolean };

function metricOutcome(metric: unknown, expectedReason: string | undefined): MetricOutcome {
  if (!isRecord(metric)) return { kind: "gap", reason: "missing", expected: false };
  if (metric.status === "available") {
    const value = safeCount(metric.value);
    if (metric.precision === "exact" && metric.unit === "count" && value !== null) return { kind: "value", value };
    return { kind: "gap", reason: "not-exact", expected: false };
  }
  const reason = str(metric.reason) ?? str(metric.status) ?? "unavailable";
  return { kind: "gap", reason, expected: expectedReason !== undefined && expectedReason === reason };
}

/** Project one row's final attempt into an exact observation or a categorical gap. */
export function normalizeRead(inputs: Inputs): { result: Json } {
  const read = isRecord(inputs.read) ? inputs.read : {};
  const attemptRecord = isRecord(inputs.attempt) ? inputs.attempt : {};
  const report = isRecord(attemptRecord.report) ? attemptRecord.report : (isRecord(inputs.report) ? inputs.report : {});
  const attempts = safeCount(attemptRecord.attempts) ?? safeCount(inputs.attempts) ?? null;
  const accountKey = str(read.accountKey) ?? "";
  const metricKeys = strings(read.metricKeys);
  const expectedGaps = new Map<string, string>();
  for (const gap of list(read.expectedCategoricalGaps)) {
    if (isRecord(gap) && typeof gap.metricKey === "string" && typeof gap.reason === "string") expectedGaps.set(gap.metricKey, gap.reason);
  }
  const base: JsonRecord = {
    accountKey,
    adapter: str(read.adapter),
    operation: str(read.operation),
    metricKeys,
    attempts,
    receipt: isRecord(report.receipt) ? report.receipt : null,
  };
  const failWith = (reason: string, escalation: string, detail: Json = null): { result: Json } => ({
    result: { ...base, status: "gap", reason, escalation, detail, metrics: {}, gaps: metricKeys.map((metricKey) => ({ metricKey, reason, expected: false })) },
  });

  if (report.ok !== true) {
    const readFailure = isRecord(report.readFailure) ? report.readFailure : null;
    const category = readFailure ? str(readFailure.category) : null;
    if (category !== null) {
      return failWith(category, ESCALATIONS[category as keyof typeof ESCALATIONS] ?? "doctor", { retryDisposition: str(readFailure?.retryDisposition) });
    }
    const status = str(report.status) ?? "invocation-failed";
    return failWith(status, status === "not-a-read" || status === "invalid-input" ? "review-plan" : "doctor", str(report.diagnostic));
  }

  const output = isRecord(report.output) ? report.output : null;
  if (!output) return failWith("output-missing", "recapture");
  const expectedOutput = isRecord(read.expectedOutput) ? read.expectedOutput : {};
  const target = isRecord(output.target) ? output.target : {};
  if (str(output.provider) !== str(expectedOutput.provider) || str(target.url) !== str(expectedOutput.targetUrl)) {
    return failWith("target-mismatch", "review-target", { provider: str(output.provider), targetUrl: str(target.url) });
  }
  const metricsRecord = isRecord(output.metrics) ? output.metrics : {};
  const metrics: JsonRecord = {};
  const gaps: JsonRecord[] = [];
  for (const metricKey of metricKeys) {
    const outcome = metricOutcome(metricsRecord[metricKey], expectedGaps.get(metricKey));
    if (outcome.kind === "value") metrics[metricKey] = outcome.value;
    else gaps.push({ metricKey, reason: outcome.reason, expected: outcome.expected });
  }
  const unexpected = gaps.filter((gap) => gap.expected !== true);
  const status = Object.keys(metrics).length > 0 ? "observed" : "gap";
  return {
    result: {
      ...base,
      status,
      reason: status === "observed" ? null : (unexpected[0] ? str(unexpected[0].reason) : "expected-categorical-gap"),
      escalation: unexpected.length > 0 ? "review-metric" : "none",
      detail: null,
      observedAt: str(output.observedAt),
      completeness: str(output.completeness),
      metrics,
      gaps,
    },
  };
}

// --------------------------------------------------------- aggregation -----

export const DEFAULT_TIMEZONE = "America/New_York";

/** Merge per-read results into a consumer run, gap list, escalations, and last-good memory. */
export function aggregateRun(inputs: Inputs): { run: Json; gaps: Json; escalations: Json; "last-good": Json; summary: string } {
  const plan = isRecord(inputs.plan) ? inputs.plan : {};
  const collectionKey = str(plan.collectionKey) ?? "collection";
  const results = list(inputs.results).filter(isRecord);
  const planGaps = list(inputs["plan-gaps"]).filter(isRecord);
  const scheduledDate = str(inputs["scheduled-date"]) ?? "";
  const timezone = str(inputs.timezone) ?? DEFAULT_TIMEZONE;
  const previous = isRecord(inputs["last-good"]) ? inputs["last-good"] : {};
  const previousCollection = isRecord(previous[collectionKey]) ? previous[collectionKey] : {};

  const observations = new Map<string, { metrics: JsonRecord; observedAt: string }>();
  const gaps: JsonRecord[] = [];
  const escalations: JsonRecord[] = [];
  for (const gap of planGaps) {
    gaps.push({ accountKey: gap.accountKey ?? null, adapter: gap.adapter ?? null, operation: gap.operation ?? null, metricKeys: gap.metricKeys ?? [], reason: gap.reason ?? "check-gap", stage: "check", detail: gap.detail ?? null });
    escalations.push({ kind: gap.escalation ?? "review-plan", accountKey: gap.accountKey ?? null, adapter: gap.adapter ?? null, operation: gap.operation ?? null, reason: gap.reason ?? "check-gap" });
  }
  for (const result of results) {
    const accountKey = str(result.accountKey) ?? "";
    const metrics = isRecord(result.metrics) ? result.metrics : {};
    if (result.status === "observed" && Object.keys(metrics).length > 0) {
      const existing = observations.get(accountKey);
      const observedAt = str(result.observedAt) ?? existing?.observedAt ?? "";
      observations.set(accountKey, { metrics: { ...(existing?.metrics ?? {}), ...metrics }, observedAt: observedAt > (existing?.observedAt ?? "") ? observedAt : (existing?.observedAt ?? observedAt) });
    }
    for (const gap of list(result.gaps).filter(isRecord)) {
      gaps.push({ accountKey, adapter: result.adapter ?? null, operation: result.operation ?? null, metricKeys: [gap.metricKey ?? null], reason: gap.reason ?? "gap", stage: "read", expected: gap.expected === true, detail: result.detail ?? null });
    }
    const escalation = str(result.escalation);
    if (escalation && escalation !== "none") {
      escalations.push({ kind: escalation, accountKey, adapter: result.adapter ?? null, operation: result.operation ?? null, reason: result.reason ?? null, attempts: result.attempts ?? null });
    }
  }
  const orderedKeys: string[] = [];
  for (const account of list(plan.accounts)) {
    if (isRecord(account) && typeof account.accountKey === "string" && !orderedKeys.includes(account.accountKey)) orderedKeys.push(account.accountKey);
  }
  for (const key of observations.keys()) if (!orderedKeys.includes(key)) orderedKeys.push(key);
  const runObservations: JsonRecord[] = [];
  const nextCollection: JsonRecord = { ...previousCollection };
  for (const accountKey of orderedKeys) {
    const observation = observations.get(accountKey);
    if (!observation) continue;
    runObservations.push({ accountKey, metrics: observation.metrics, observedAt: observation.observedAt });
    nextCollection[accountKey] = { metrics: observation.metrics, observedAt: observation.observedAt, scheduledDate };
  }
  const lastGood: JsonRecord = { ...previous, [collectionKey]: nextCollection };
  const expectedGapCount = gaps.filter((gap) => gap.expected === true).length;
  const summary = [
    `${collectionKey} ${scheduledDate}: ${runObservations.length} account${runObservations.length === 1 ? "" : "s"} observed`,
    `${gaps.length - expectedGapCount} unexpected gap${gaps.length - expectedGapCount === 1 ? "" : "s"}`,
    `${expectedGapCount} expected`,
    `${escalations.length} escalation${escalations.length === 1 ? "" : "s"}`,
  ].join(", ");
  return {
    run: { schemaVersion: 1, scheduledDate, timezone, observations: runObservations },
    gaps,
    escalations,
    "last-good": lastGood,
    summary,
  };
}

// ----------------------------------------------------- catalog survey ------

type Operation = Record<string, Json>;

function catalogAdapters(report: Record<string, Json>): Array<Record<string, Json>> {
  const catalog = isRecord(report.catalog) ? report.catalog : report;
  return list(catalog.adapters).filter(isRecord);
}

/** Compact per-adapter counts plus the R1 read list, from a catalog report. */
export function catalogSurvey(inputs: Inputs): { survey: Json; summary: string } {
  const report = isRecord(inputs.report) ? inputs.report : {};
  if (report.ok !== true && report.status !== "succeeded") {
    return { survey: { ok: false, status: report.status ?? "unavailable", adapters: [] }, summary: `catalog unavailable: ${str(report.status) ?? "unknown"}` };
  }
  const adapters: JsonRecord[] = [];
  let observed = 0;
  let captureRequired = 0;
  const reads: JsonRecord[] = [];
  for (const adapter of catalogAdapters(report)) {
    if (adapter.invalid === true) {
      adapters.push({ id: adapter.id ?? null, invalid: true });
      continue;
    }
    const operations = list(adapter.operations).filter(isRecord) as Operation[];
    const observedOps = operations.filter((operation) => operation.state === "observed");
    const captureOps = operations.filter((operation) => operation.state === "capture-required");
    observed += observedOps.length;
    captureRequired += captureOps.length;
    for (const operation of observedOps) {
      if (operation.risk === "R1") {
        reads.push({ adapter: adapter.id ?? null, operation: operation.id ?? null, authority: operation.authority ?? null, transport: operation.transport ?? null, inputs: isRecord(operation.input) ? Object.keys(isRecord(operation.input.properties) ? operation.input.properties : {}) : [] });
      }
    }
    adapters.push({
      id: adapter.id ?? null,
      version: adapter.version ?? null,
      surfaceId: adapter.surfaceId ?? null,
      observed: observedOps.map((operation) => `${str(operation.id) ?? "?"}:${str(operation.risk) ?? "?"}`),
      captureRequired: captureOps.map((operation) => str(operation.id) ?? "?"),
    });
  }
  const summary = `${adapters.length} adapters, ${observed} observed operations (${reads.length} R1 reads), ${captureRequired} capture-required`;
  return { survey: { ok: true, adapters, reads, counts: { adapters: adapters.length, observed, captureRequired, reads: reads.length } }, summary };
}

// ------------------------------------------------------ check summary ------

export function checkSummary(inputs: Inputs): { summary: Json; text: string } {
  const report = isRecord(inputs.report) ? inputs.report : {};
  const check = isRecord(report.check) ? report.check : {};
  if (report.status !== "succeeded") {
    return { summary: { ok: false, status: report.status ?? "unavailable", ok_reads: 0, gaps: [] }, text: `contract check unavailable: ${str(report.status) ?? "unknown"}${str(report.diagnostic) ? ` (${str(report.diagnostic)})` : ""}` };
  }
  const reads = list(check.reads).filter(isRecord);
  const okReads = reads.filter((read) => read.verdict === "ok");
  const gaps = reads.filter((read) => read.verdict !== "ok").map((read) => {
    const gap = isRecord(read.gap) ? read.gap : {};
    return { index: read.index ?? null, accountKey: read.accountKey ?? null, adapter: read.adapter ?? null, operation: read.operation ?? null, reason: gap.reason ?? "gap", detail: gap.detail ?? null };
  });
  const text = `${okReads.length}/${reads.length} reads ok${gaps.length ? `; gaps: ${gaps.map((gap) => `${str(gap.accountKey) ?? "?"} ${str(gap.adapter) ?? "?"} ${str(gap.operation) ?? "?"} (${str(gap.reason) ?? "gap"})`).join("; ")}` : ""}`;
  return { summary: { ok: check.ok === true, ok_reads: okReads.length, total: reads.length, gaps }, text };
}

// --------------------------------------------------------- auth health -----

export function authHealth(inputs: Inputs): { health: Json; summary: string } {
  const doctorReport = isRecord(inputs.doctor) ? inputs.doctor : {};
  const authReport = isRecord(inputs.auth) ? inputs.auth : {};
  const doctor = isRecord(doctorReport.doctor) ? doctorReport.doctor : {};
  const auth = list(authReport.auth).filter(isRecord);
  const kinds: JsonRecord = {};
  for (const entry of auth) {
    const kind = str(entry.kind) ?? "unknown";
    kinds[kind] = (typeof kinds[kind] === "number" ? (kinds[kind] as number) : 0) + 1;
  }
  const recovery = isRecord(doctor.recovery) ? doctor.recovery : {};
  const pending: string[] = [];
  for (const [name, counts] of Object.entries(recovery)) {
    if (!isRecord(counts)) continue;
    for (const key of ["active", "live", "retained", "invalid"]) {
      const value = counts[key];
      if (typeof value === "number" && value > 0) pending.push(`${name}.${key}=${value}`);
    }
  }
  const health = {
    doctorOk: doctorReport.ok === true,
    doctorStatus: doctorReport.status ?? null,
    authOk: authReport.ok === true,
    locators: auth.length,
    locatorKinds: kinds,
    locatorIds: auth.map((entry) => str(entry.id)).filter((id): id is string => id !== null),
    webSessionApiReady: doctor.webSessionApiReady ?? null,
    providerApiReady: doctor.providerApiReady ?? null,
    localCliReady: doctor.localCliReady ?? null,
    unsettledRuns: doctor.unsettledRuns ?? null,
    activeDerivations: doctor.activeDerivations ?? null,
    pendingRecovery: pending,
  };
  const summary = `doctor ${health.doctorOk ? "ok" : "not ok"}; ${auth.length} auth locators; web-session ${String(health.webSessionApiReady)}, provider-api ${String(health.providerApiReady)}, local-cli ${String(health.localCliReady)}; unsettled runs ${String(health.unsettledRuns)}${pending.length ? `; pending recovery: ${pending.join(", ")}` : ""}`;
  return { health, summary };
}

// ------------------------------------------------------- drift watch -------

function operationIdentity(adapter: Record<string, Json>, operation: Operation): JsonRecord {
  return {
    adapterVersion: adapter.version ?? null,
    manifestHash: adapter.manifestHash ?? null,
    state: operation.state ?? null,
    contractVersion: operation.contractVersion ?? null,
    contractHash: operation.contractHash ?? null,
    risk: operation.risk ?? null,
  };
}

/** Compare the live catalog against the stored baseline; emit the next baseline. */
export function catalogDrift(inputs: Inputs): { drift: Json; baseline: Json; summary: string } {
  const report = isRecord(inputs.report) ? inputs.report : {};
  const previous = isRecord(inputs.baseline) ? inputs.baseline : {};
  if (report.ok !== true && report.status !== "succeeded") {
    return { drift: { ok: false, status: report.status ?? "unavailable", changed: [], added: [], removed: [] }, baseline: previous, summary: `catalog unavailable: ${str(report.status) ?? "unknown"}; baseline kept` };
  }
  const next: JsonRecord = {};
  for (const adapter of catalogAdapters(report)) {
    if (adapter.invalid === true) continue;
    for (const operation of list(adapter.operations).filter(isRecord) as Operation[]) {
      next[`${str(adapter.id) ?? "?"}/${str(operation.id) ?? "?"}`] = operationIdentity(adapter, operation);
    }
  }
  const previousEntries = isRecord(previous.operations) ? previous.operations : {};
  const changed: JsonRecord[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [key, identity] of Object.entries(next)) {
    const before = previousEntries[key];
    if (before === undefined) {
      added.push(key);
      continue;
    }
    if (JSON.stringify(before) !== JSON.stringify(identity)) {
      const fields = isRecord(before) && isRecord(identity)
        ? Object.keys(identity).filter((field) => JSON.stringify(before[field]) !== JSON.stringify(identity[field]))
        : [];
      changed.push({ operation: key, fields, before, after: identity });
    }
  }
  for (const key of Object.keys(previousEntries)) if (!(key in next)) removed.push(key);
  const firstBaseline = Object.keys(previousEntries).length === 0;
  const summary = firstBaseline
    ? `baseline recorded: ${Object.keys(next).length} operations`
    : `${changed.length} changed, ${added.length} added, ${removed.length} removed of ${Object.keys(next).length} operations`;
  return {
    drift: { ok: true, firstBaseline, changed, added, removed, total: Object.keys(next).length },
    baseline: { operations: next },
    summary,
  };
}

// ------------------------------------------------------------ registry -----

type Port = { type: "json" | "text"; optional?: boolean };
const json: Port = { type: "json" };
const text: Port = { type: "text" };

function register(registry: FnRegistry, name: string, inputs: Record<string, Port>, outputs: Record<string, Port>, cost: number, fn: (inputs: Inputs) => Record<string, Json>): void {
  registry.set(name, { signature: { inputs, outputs, cost }, fn });
}

/** The built-in ALGAL functions plus this package's pure functions. */
export function packageFns(): FnRegistry {
  const registry = builtinRegistry();
  register(registry, "ghostget.plan.rows.v1", { plan: json, check: json }, { rows: json, gaps: json }, 50, planRows);
  register(registry, "ghostget.profile-stat.attempt.v1", { report: json, "attempt-no": { type: "json", optional: true } }, { attempt: json }, 10, attemptDecision);
  register(registry, "ghostget.profile-stat.normalize.v1", { read: json, attempt: json, attempts: { type: "json", optional: true } }, { result: json }, 50, normalizeRead);
  register(registry, "ghostget.profile-stats.aggregate.v1", { plan: json, results: json, "plan-gaps": json, "scheduled-date": json, timezone: json, "last-good": json }, { run: json, gaps: json, escalations: json, "last-good": json, summary: text }, 100, aggregateRun);
  register(registry, "ghostget.catalog.survey.v1", { report: json }, { survey: json, summary: text }, 100, catalogSurvey);
  register(registry, "ghostget.check.summary.v1", { report: json }, { summary: json, text }, 50, checkSummary);
  register(registry, "ghostget.auth.health.v1", { doctor: json, auth: json }, { health: json, summary: text }, 50, authHealth);
  register(registry, "ghostget.catalog.drift.v1", { report: json, baseline: json }, { drift: json, baseline: json, summary: text }, 100, catalogDrift);
  return registry;
}
