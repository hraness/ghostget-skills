#!/usr/bin/env bun
// ghostget-skills tools — reviewed implementations behind the tool registry.
//
// Every tool maps declared inputs onto one fixed Ghostget CLI call through
// `src/ghostget-cli.ts`, then projects the result into a secret-free `report`
// port: no cookies, tokens, subjects, cache keys, receipts hashes beyond
// contract identity, or local paths. Failures are structured records, never
// thrown, so an organism can route them by structure.
//
// Two entry points share these implementations:
//   - in-process: `src/run-program.ts` builds a ToolRegistry from `TOOLS`;
//   - `cmd:` form: `bun tools/tool.ts <name>` reads {inputs} on stdin and
//     prints the output ports on stdout (for `algal run --tools`).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  ghostgetRunner,
  type GhostgetResult,
  type GhostgetRunner,
} from "../src/ghostget-cli.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };
type Inputs = Readonly<Record<string, Json>>;

export type ToolDependencies = {
  readonly ghostget: GhostgetRunner;
  readonly sleep: (ms: number) => Promise<void>;
};

export const MAX_WAIT_MS = 120_000;
export const RETRY_DELAY_MS = 60_000;
const MAX_OUTPUT_JSON_BYTES = 100 * 1024;
const MAX_CATALOG_BYTES = 240 * 1024;
const DEFAULT_PAGE_BYTES = 16_000;
const MAX_PAGE_BYTES = 131_072;

export const READ_FAILURE_DISPOSITIONS = Object.freeze({
  "target-unavailable": "do-not-retry",
  "auth-repair-required": "repair-auth",
  "account-mismatch": "do-not-retry",
  "contract-drift": "do-not-retry",
  "cleanup-required": "do-not-retry",
  "provider-throttled": "retry-once-after-60s",
  "provider-temporary": "retry-once-after-60s",
  "operation-timeout": "retry-once-after-60s",
} as const);
export type ReadFailureCategory = keyof typeof READ_FAILURE_DISPOSITIONS;
export type RetryDisposition = (typeof READ_FAILURE_DISPOSITIONS)[ReadFailureCategory];

const ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,127}$/u;

// ------------------------------------------------------------------ helpers --

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

function failure(status: string, detail: JsonRecord = {}): JsonRecord {
  return { ok: false, status, ...detail };
}

function exitRecord(result: GhostgetResult): JsonRecord {
  const exit = result.exit;
  if (exit.kind === "exited") return { kind: "exited", code: exit.code };
  if (exit.kind === "terminated") return { kind: "terminated", signal: exit.signal };
  return { kind: "spawn-failed", message: exit.message };
}

function transportFailure(result: GhostgetResult): JsonRecord | null {
  if (result.exit.kind === "spawn-failed") {
    return failure("invocation-failed", { exit: exitRecord(result), diagnostic: result.exit.message });
  }
  if (result.exit.kind === "terminated") {
    // A consumer-forced termination may have interrupted provider cleanup;
    // Ghostget's own rule is that this is categorical and never retried.
    return failure("terminated", {
      exit: exitRecord(result),
      readFailure: { category: "cleanup-required", retryDisposition: "do-not-retry" },
      diagnostic: result.stderrTail,
    });
  }
  if (result.stdoutTruncated) {
    return failure("malformed", { exit: exitRecord(result), diagnostic: "stdout exceeded the 4 MiB bound" });
  }
  return null;
}

function parseReadFailure(value: unknown): { category: ReadFailureCategory; retryDisposition: RetryDisposition } | null {
  if (!isRecord(value) || typeof value.category !== "string") return null;
  const category = value.category as ReadFailureCategory;
  const disposition = READ_FAILURE_DISPOSITIONS[category];
  if (disposition === undefined) return null;
  // Ghostget's disposition is authoritative when present and consistent.
  if (value.retryDisposition !== undefined && value.retryDisposition !== disposition) return null;
  return { category, retryDisposition: disposition };
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/** Project a Ghostget invoke receipt to contract identity only. */
function receiptSummary(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const adapter = isRecord(value.adapter) ? value.adapter : {};
  const auth = isRecord(value.auth) ? value.auth : {};
  const out: JsonRecord = {
    runId: stringField(value, "runId"),
    operation: stringField(value, "operation"),
    risk: stringField(value, "risk"),
    status: stringField(value, "status"),
    transport: stringField(value, "transport"),
    finalOrigin: stringField(value, "finalOrigin"),
    startedAt: stringField(value, "startedAt"),
    finishedAt: stringField(value, "finishedAt"),
    adapter: {
      id: stringField(adapter, "id"),
      version: stringField(adapter, "version"),
      hash: stringField(adapter, "hash"),
    },
    authKind: stringField(auth, "kind"),
    contractHash: stringField(value, "webSessionContractHash")
      ?? stringField(value, "providerContractHash")
      ?? stringField(value, "localCliContractHash")
      ?? null,
    schemaVersion: typeof value.schemaVersion === "number" ? value.schemaVersion : null,
  };
  return out;
}

async function withPrivateFile<T>(name: string, contents: string, body: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "ghostget-skills-"));
  const path = join(directory, name);
  try {
    await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
    return await body(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------- tools --

export function buildTools(deps: ToolDependencies) {
  const call = deps.ghostget;

  async function contractsCatalog(inputs: Inputs): Promise<JsonRecord> {
    const request = isRecord(inputs.request) ? inputs.request : {};
    const adapters = request.adapters;
    const argv = ["contracts", "catalog"];
    if (adapters !== undefined && adapters !== null) {
      if (!Array.isArray(adapters) || adapters.length > 64 || !adapters.every((a) => typeof a === "string" && ID_PATTERN.test(a))) {
        return failure("invalid-input", { diagnostic: "adapters must be a list of at most 64 adapter IDs" });
      }
      for (const adapter of adapters) argv.push("--adapter", adapter as string);
    }
    const result = await call({ argv });
    const transport = transportFailure(result);
    if (transport) return transport;
    const doc = result.json;
    if (!isRecord(doc) || doc.contract !== "ghostget.contract-catalog.v1" || !Array.isArray(doc.adapters)) {
      return failure("malformed", { exit: exitRecord(result), diagnostic: result.stderrTail || "no catalog document on stdout" });
    }
    let catalog: unknown = doc;
    let descriptionsDropped = false;
    if (bytes(catalog) > MAX_CATALOG_BYTES) {
      catalog = dropDescriptions(doc);
      descriptionsDropped = true;
    }
    if (bytes(catalog) > MAX_CATALOG_BYTES) {
      return failure("too-large", { diagnostic: "catalog exceeds the tool output bound; filter with adapters" });
    }
    return { ok: doc.ok === true, status: "succeeded", descriptionsDropped, catalog: catalog as Json };
  }

  async function contractsCheck(inputs: Inputs): Promise<JsonRecord> {
    const plan = inputs.plan;
    if (!isRecord(plan)) return failure("invalid-input", { diagnostic: "plan must be a collection-plan document" });
    const authState = inputs["auth-state"] === true;
    const argv = ["contracts", "check", "--plan"];
    const key = `contracts check --plan <<< ${canonicalJson(plan)}`;
    const result = await withPrivateFile("plan.json", `${JSON.stringify(plan)}\n`, (path) =>
      call({ argv: [...argv, path, ...(authState ? ["--auth-state"] : [])], key }));
    const transport = transportFailure(result);
    if (transport) return transport;
    const doc = result.json;
    if (!isRecord(doc) || doc.contract !== "ghostget.contract-check.v1" || !Array.isArray(doc.reads)) {
      return failure("malformed", { exit: exitRecord(result), diagnostic: result.stderrTail || "no check document on stdout" });
    }
    return { ok: doc.ok === true, status: "succeeded", check: doc as Json };
  }

  async function invokeRead(inputs: Inputs): Promise<JsonRecord> {
    const read = inputs.read;
    if (!isRecord(read)) return failure("invalid-input", { diagnostic: "read must be {adapter, operation, input, authority}" });
    const adapter = stringField(read, "adapter");
    const operation = stringField(read, "operation");
    const authority = isRecord(read.authority) ? read.authority : null;
    if (!adapter || !ID_PATTERN.test(adapter) || !operation || !ID_PATTERN.test(operation) || !isRecord(read.input) || !authority) {
      return failure("invalid-input", { diagnostic: "read needs adapter, operation, object input, and authority" });
    }
    const argv = ["invoke", adapter, operation, "--input", "-"];
    if (authority.kind === "auth") {
      const authId = stringField(authority, "authId");
      if (!authId || !ID_PATTERN.test(authId)) return failure("invalid-input", { diagnostic: "authority.authId must be a locator ID" });
      argv.push("--auth", authId);
    } else if (authority.kind !== "public") {
      return failure("invalid-input", { diagnostic: "authority.kind must be public or auth" });
    }
    const result = await call({ argv, stdin: JSON.stringify(read.input) });
    const transport = transportFailure(result);
    if (transport) return transport;
    const doc = result.json;
    if (!isRecord(doc)) {
      return failure("invocation-failed", { exit: exitRecord(result), diagnostic: result.stderrTail || "no JSON envelope on stdout" });
    }
    const receipt = receiptSummary(doc.receipt);
    const status = stringField(doc, "status");
    if (receipt && receipt.risk !== null && receipt.risk !== "R1") {
      return failure("not-a-read", { receipt, diagnostic: "invoke.read only runs R1 operations" });
    }
    if (status === "succeeded" && doc.ok === true) {
      const output = doc.output as Json;
      const clipped = bytes(output) > MAX_OUTPUT_JSON_BYTES;
      return {
        ok: true,
        status: "succeeded",
        source: stringField(doc, "source"),
        replayed: doc.replayed === true,
        receipt,
        output: clipped ? { clipped: true, bytes: bytes(output) } : output,
      };
    }
    const readFailure = parseReadFailure(doc.readFailure);
    return {
      ok: false,
      status: status === "failed" ? "failed" : "invocation-failed",
      receipt,
      exit: exitRecord(result),
      ...(readFailure ? { readFailure } : {}),
      ...(readFailure ? {} : { diagnostic: stringField(doc, "error") ?? result.stderrTail ?? "" }),
    };
  }

  async function pageRead(inputs: Inputs): Promise<JsonRecord> {
    const url = inputs.url;
    if (typeof url !== "string" || !/^https?:\/\/[^\s]+$/u.test(url) || url.length > 2048) {
      return failure("invalid-input", { diagnostic: "url must be an http(s) URL" });
    }
    const maxBytesRaw = inputs["max-bytes"];
    const maxBytes = typeof maxBytesRaw === "number" && Number.isSafeInteger(maxBytesRaw)
      ? Math.min(Math.max(maxBytesRaw, 512), MAX_PAGE_BYTES)
      : DEFAULT_PAGE_BYTES;
    const result = await call({ argv: ["read", url, "--media", "none"], raw: true });
    const transport = transportFailure(result);
    if (transport) return transport;
    if (result.exit.kind === "exited" && result.exit.code !== 0) {
      return failure("read-failed", { exit: exitRecord(result), diagnostic: result.stderrTail });
    }
    const text = result.stdout ?? "";
    const parsed = splitFrontmatter(text);
    const body = Buffer.from(parsed.body, "utf8");
    const truncated = body.length > maxBytes;
    return {
      ok: true,
      status: "succeeded",
      title: parsed.fields.title ?? null,
      canonicalUrl: parsed.fields.source ?? null,
      platform: parsed.fields.platform ?? null,
      captureStatus: parsed.fields.capture_status ?? null,
      captureMethod: parsed.fields.capture_method ?? null,
      sourceBytes: body.length,
      truncated,
      markdown: truncated ? body.subarray(0, maxBytes).toString("utf8") : parsed.body,
    };
  }

  async function doctor(_inputs: Inputs): Promise<JsonRecord> {
    const result = await call({ argv: ["doctor"], deadlineMs: 300_000 });
    const transport = transportFailure(result);
    if (transport) return transport;
    const doc = result.json;
    if (!isRecord(doc) || !isRecord(doc.ghostget)) {
      return failure("malformed", { exit: exitRecord(result), diagnostic: result.stderrTail || "no doctor document on stdout" });
    }
    return { ok: doc.ok === true, status: "succeeded", doctor: doctorSummary(doc) };
  }

  async function authList(_inputs: Inputs): Promise<JsonRecord> {
    const result = await call({ argv: ["auth", "list"] });
    const transport = transportFailure(result);
    if (transport) return transport;
    const doc = result.json;
    if (!isRecord(doc) || !Array.isArray(doc.auth)) {
      return failure("malformed", { exit: exitRecord(result), diagnostic: result.stderrTail || "no auth document on stdout" });
    }
    const auth = doc.auth
      .filter(isRecord)
      .map((entry) => ({
        id: stringField(entry, "id"),
        kind: stringField(entry, "kind"),
        provider: stringField(entry, "provider"),
      }))
      .filter((entry) => entry.id !== null)
      .slice(0, 256);
    return { ok: doc.ok === true, status: "succeeded", count: auth.length, auth };
  }

  async function wait(inputs: Inputs): Promise<JsonRecord> {
    const msRaw = inputs.ms;
    if (typeof msRaw !== "number" || !Number.isSafeInteger(msRaw) || msRaw < 0) {
      return failure("invalid-input", { diagnostic: "ms must be a nonnegative integer" });
    }
    const ms = Math.min(msRaw, MAX_WAIT_MS);
    if (ms > 0) await deps.sleep(ms);
    return { ok: true, status: "succeeded", requestedMs: msRaw, waitedMs: ms, clamped: ms !== msRaw };
  }

  return {
    "ghostget.contracts.catalog.v1": contractsCatalog,
    "ghostget.contracts.check.v1": contractsCheck,
    "ghostget.invoke.read.v1": invokeRead,
    "ghostget.page.read.v1": pageRead,
    "ghostget.doctor.v1": doctor,
    "ghostget.auth.list.v1": authList,
    "time.wait.v1": wait,
  } satisfies Record<string, (inputs: Inputs) => Promise<JsonRecord>>;
}

export type ToolName = keyof ReturnType<typeof buildTools>;
export const TOOL_NAMES = Object.freeze([
  "ghostget.contracts.catalog.v1",
  "ghostget.contracts.check.v1",
  "ghostget.invoke.read.v1",
  "ghostget.page.read.v1",
  "ghostget.doctor.v1",
  "ghostget.auth.list.v1",
  "time.wait.v1",
] as const satisfies readonly ToolName[]);

/** Drop `description` strings from an input schema tree to fit the bound. */
export function dropDescriptions(value: unknown): Json {
  if (Array.isArray(value)) return value.map(dropDescriptions);
  if (isRecord(value)) {
    const out: JsonRecord = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "description" && typeof entry === "string") continue;
      out[key] = dropDescriptions(entry);
    }
    return out;
  }
  return value as Json;
}

function count(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number") return value;
  return null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function recoveryCounts(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const out: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" || typeof entry === "boolean") out[key] = entry;
    else if (Array.isArray(entry)) out[key] = entry.length;
  }
  return out;
}

/** The bounded, path-free doctor projection. */
export function doctorSummary(doc: Record<string, unknown>): JsonRecord {
  const g = isRecord(doc.ghostget) ? doc.ghostget : {};
  const capture = isRecord(doc.capture) ? doc.capture : {};
  const media = isRecord(doc.media) ? doc.media : {};
  return {
    ok: doc.ok === true,
    capture: { ok: bool(capture.ok) },
    media: { ok: bool(media.ok), archiveReady: bool(g.mediaArchiveReady) },
    installedAdapters: count(g.installedAdapters),
    configuredAuth: count(g.configuredAuth),
    webSessionApiReady: bool(g.webSessionApiReady),
    webSessionAdapters: count(g.webSessionAdapters),
    providerApiReady: bool(g.providerApiReady),
    localCliReady: bool(g.localCliReady),
    browserCaptureBootstrapReady: bool(g.browserCaptureBootstrapReady),
    activeDerivations: count(g.activeDerivations),
    unsettledRuns: count(g.unsettledRuns),
    recovery: {
      confirmationClaims: recoveryCounts(g.confirmationClaimRecovery),
      runJournals: recoveryCounts(g.runJournalRecovery),
      webSessionCleanupAdmission: recoveryCounts(g.webSessionCleanupAdmissionRecovery),
      linkedDeviceLifecycle: recoveryCounts(g.linkedDeviceLifecycleRecovery),
    },
    mutationPolicy: typeof g.mutationPolicy === "string" ? g.mutationPolicy : null,
  };
}

/** Split Ghostget's `read` text output into frontmatter fields and body. */
export function splitFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const fields: Record<string, string> = {};
  if (!text.startsWith("---\n")) return { fields, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { fields, body: text };
  for (const line of text.slice(4, end).split("\n")) {
    const match = /^([a-z_]+):\s*"?(.*?)"?\s*$/u.exec(line);
    if (match?.[1] && match[2] !== undefined) fields[match[1]] = match[2];
  }
  return { fields, body: text.slice(end + 5) };
}

// ------------------------------------------------------------- cmd: entry --

export const TOOLS = buildTools({
  ghostget: ghostgetRunner(),
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
});

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) throw new Error("stdin exceeds 1 MiB");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.main) {
  const name = process.argv[2] as ToolName | undefined;
  const impl = name ? TOOLS[name] : undefined;
  if (!name || !impl) {
    process.stderr.write(`usage: bun tools/tool.ts <${TOOL_NAMES.join("|")}>\n`);
    process.exit(2);
  }
  const request = JSON.parse(await readStdin()) as { inputs?: Inputs };
  const report = await impl(request.inputs ?? {});
  process.stdout.write(`${JSON.stringify({ report })}\n`);
}
