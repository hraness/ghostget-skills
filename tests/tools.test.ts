// Tool projections — every report must be secret-free and structurally
// routable. Runs against the recorded runner only.

import { describe, expect, test } from "bun:test";
import { recordedRunner } from "../src/ghostget-cli.ts";
import { buildTools, doctorSummary, dropDescriptions, splitFrontmatter, TOOL_NAMES } from "../tools/tool.ts";
import { authListDocument, catalogDocument, doctorDocument, failedEnvelope, PAGE_TEXT, planReads, invokeKey, succeededEnvelope } from "../fixtures/recorded.ts";
import registrySpec from "../tools/ghostget.tools.json" with { type: "json" };

const bluesky = planReads().find((read) => read.adapter === "bluesky-web")!;
const x = planReads().find((read) => read.adapter === "x-web")!;

function tools(responses: Parameters<typeof recordedRunner>[0], sleeps: number[] = []) {
  return buildTools({ ghostget: recordedRunner(responses), sleep: async (ms) => { sleeps.push(ms); } });
}

describe("registry", () => {
  test("every implemented tool has a signature and vice versa", () => {
    expect(Object.keys(registrySpec).sort()).toEqual([...TOOL_NAMES].sort());
    for (const entry of Object.values(registrySpec)) {
      expect(entry.signature.effect).toBe("read");
      expect(entry.exec.startsWith("cmd:bun __PKG__/tools/tool.ts ")).toBe(true);
    }
  });
});

describe("ghostget.invoke.read.v1", () => {
  test("projects a succeeded envelope to output plus contract identity only", async () => {
    const envelope = succeededEnvelope(bluesky, { followers: 63 });
    const report = await tools({ [invokeKey(bluesky)]: { json: envelope } })["ghostget.invoke.read.v1"]({ read: bluesky as never });
    expect(report.ok).toBe(true);
    expect(report.status).toBe("succeeded");
    expect((report.output as { metrics: unknown }).metrics).toEqual(envelope.output.metrics);
    const receipt = report.receipt as Record<string, unknown>;
    expect(receipt.risk).toBe("R1");
    expect(receipt.contractHash).toBe(envelope.receipt.webSessionContractHash);
    expect(receipt.authKind).toBe("public-web-session");
    const text = JSON.stringify(report);
    expect(text).not.toContain("cache");
    expect(text).not.toContain(envelope.receipt.auth.hash);
    expect(text).not.toContain(envelope.cache.publication.key);
  });
  test("passes the auth locator and input on stdin for authenticated reads", async () => {
    const seen: string[] = [];
    const impl = buildTools({
      ghostget: async (call) => { seen.push(call.argv.join(" "), call.stdin ?? ""); return { exit: { kind: "exited", code: 0 }, json: succeededEnvelope(x, { followers: 1 }), stdoutBytes: 0, stdoutTruncated: false, stderrTail: "", durationMs: 0 }; },
      sleep: async () => undefined,
    });
    await impl["ghostget.invoke.read.v1"]({ read: x as never });
    expect(seen[0]).toBe("invoke x-web profiles.read --input - --auth x-chrome");
    expect(seen[1]).toBe(JSON.stringify(x.input));
  });
  test("keeps Ghostget's closed readFailure category and disposition", async () => {
    const report = await tools({ [invokeKey(x)]: { json: failedEnvelope(x, "auth-repair-required", "repair-auth"), code: 1 } })["ghostget.invoke.read.v1"]({ read: x as never });
    expect(report.ok).toBe(false);
    expect(report.status).toBe("failed");
    expect(report.readFailure).toEqual({ category: "auth-repair-required", retryDisposition: "repair-auth" });
  });
  test("rejects an inconsistent disposition instead of trusting it", async () => {
    const report = await tools({ [invokeKey(x)]: { json: failedEnvelope(x, "contract-drift", "retry-once-after-60s"), code: 1 } })["ghostget.invoke.read.v1"]({ read: x as never });
    expect(report.readFailure).toBeUndefined();
    expect(report.status).toBe("failed");
  });
  test("a terminated child is a categorical cleanup-required gap", async () => {
    const report = await tools({ [invokeKey(x)]: { exit: { kind: "terminated", signal: "SIGTERM" } } })["ghostget.invoke.read.v1"]({ read: x as never });
    expect(report.status).toBe("terminated");
    expect(report.readFailure).toEqual({ category: "cleanup-required", retryDisposition: "do-not-retry" });
  });
  test("refuses a non-R1 receipt", async () => {
    const envelope = succeededEnvelope(x, { followers: 1 });
    envelope.receipt.risk = "R3";
    const report = await tools({ [invokeKey(x)]: { json: envelope } })["ghostget.invoke.read.v1"]({ read: x as never });
    expect(report.status).toBe("not-a-read");
    expect(report.ok).toBe(false);
  });
  test("rejects malformed read requests without spawning", async () => {
    const impl = tools({});
    expect((await impl["ghostget.invoke.read.v1"]({ read: { adapter: "x web", operation: "profiles.read", input: {}, authority: { kind: "public" } } })).status).toBe("invalid-input");
    expect((await impl["ghostget.invoke.read.v1"]({ read: { adapter: "x-web", operation: "profiles.read", input: {}, authority: { kind: "auth" } } })).status).toBe("invalid-input");
    expect((await impl["ghostget.invoke.read.v1"]({ read: "nope" })).status).toBe("invalid-input");
  });
});

describe("ghostget.contracts.*", () => {
  test("catalog passes the document through and drops descriptions only when oversized", async () => {
    const report = await tools({ "contracts catalog": { json: catalogDocument() } })["ghostget.contracts.catalog.v1"]({ request: {} });
    expect(report.ok).toBe(true);
    expect(report.descriptionsDropped).toBe(false);
    expect((report.catalog as { contract: string }).contract).toBe("ghostget.contract-catalog.v1");
  });
  test("catalog filters adapters through fixed --adapter arguments", async () => {
    const seen: string[][] = [];
    const impl = buildTools({ ghostget: async (call) => { seen.push([...call.argv]); return { exit: { kind: "exited", code: 0 }, json: catalogDocument(), stdoutBytes: 0, stdoutTruncated: false, stderrTail: "", durationMs: 0 }; }, sleep: async () => undefined });
    await impl["ghostget.contracts.catalog.v1"]({ request: { adapters: ["x-web", "github-web"] } });
    expect(seen[0]).toEqual(["contracts", "catalog", "--adapter", "x-web", "--adapter", "github-web"]);
    expect((await impl["ghostget.contracts.catalog.v1"]({ request: { adapters: ["x web"] } })).status).toBe("invalid-input");
  });
  test("check writes the plan to a private file and keys the recording on plan content", async () => {
    const seen: string[] = [];
    const impl = buildTools({ ghostget: async (call) => { seen.push(call.argv.join(" "), call.key ?? ""); return { exit: { kind: "exited", code: 4 }, json: { contract: "ghostget.contract-check.v1", ok: false, reads: [] }, stdoutBytes: 0, stdoutTruncated: false, stderrTail: "", durationMs: 0 }; }, sleep: async () => undefined });
    const report = await impl["ghostget.contracts.check.v1"]({ plan: { schemaVersion: 1 }, "auth-state": true });
    expect(seen[0]).toMatch(/^contracts check --plan \/.+plan\.json --auth-state$/u);
    expect(seen[1]).toBe('contracts check --plan <<< {"schemaVersion":1}');
    expect(report.ok).toBe(false);
    expect(report.status).toBe("succeeded");
  });
  test("a missing contracts command is a structured malformed report", async () => {
    const report = await tools({})["ghostget.contracts.catalog.v1"]({ request: {} });
    expect(report.ok).toBe(false);
    expect(report.status).toBe("malformed");
  });
  test("dropDescriptions removes only description strings", () => {
    expect(dropDescriptions({ description: "x", input: { properties: { a: { type: "string", description: "y" } } } })).toEqual({ input: { properties: { a: { type: "string" } } } });
  });
});

describe("ghostget.page.read.v1", () => {
  test("splits frontmatter and clips the body", async () => {
    const report = await tools({ "read https://example.com --media none": { stdout: PAGE_TEXT } })["ghostget.page.read.v1"]({ url: "https://example.com", "max-bytes": 600 });
    expect(report.ok).toBe(true);
    expect(report.title).toBe("Example Domain");
    expect(report.canonicalUrl).toBe("https://example.com/");
    expect(report.captureMethod).toBe("http");
    expect(report.truncated).toBe(false);
    const clipped = await tools({ "read https://example.com --media none": { stdout: PAGE_TEXT } })["ghostget.page.read.v1"]({ url: "https://example.com", "max-bytes": 512 });
    expect(clipped.truncated).toBe(false);
    expect(splitFrontmatter("no frontmatter").fields).toEqual({});
  });
  test("rejects non-http URLs without a request", async () => {
    expect((await tools({})["ghostget.page.read.v1"]({ url: "file:///etc/passwd" })).status).toBe("invalid-input");
  });
});

describe("ghostget.doctor.v1 and ghostget.auth.list.v1", () => {
  test("doctor summary carries counts, never the state home", async () => {
    const report = await tools({ doctor: { json: doctorDocument() } })["ghostget.doctor.v1"]({});
    expect(report.ok).toBe(true);
    const text = JSON.stringify(report);
    expect(text).not.toContain("state-home");
    expect(text).not.toContain("home");
    expect((report.doctor as { configuredAuth: number }).configuredAuth).toBe(3);
    expect((report.doctor as { unsettledRuns: number }).unsettledRuns).toBe(2);
    expect(doctorSummary({}).installedAdapters).toBeNull();
  });
  test("auth list strips subjects and fingerprints", async () => {
    const report = await tools({ "auth list": { json: authListDocument() } })["ghostget.auth.list.v1"]({});
    expect(report.count).toBe(3);
    const text = JSON.stringify(report);
    expect(text).not.toContain("subject");
    expect(text).not.toContain("realmFingerprint");
    expect((report.auth as Array<{ id: string }>)[0]?.id).toBe("x-chrome");
  });
});

describe("time.wait.v1", () => {
  test("waits the requested time, clamped to the bound", async () => {
    const sleeps: number[] = [];
    const impl = tools({}, sleeps);
    expect(await impl["time.wait.v1"]({ ms: 250 })).toMatchObject({ ok: true, waitedMs: 250, clamped: false });
    expect(await impl["time.wait.v1"]({ ms: 999_999 })).toMatchObject({ ok: true, waitedMs: 120_000, clamped: true });
    expect(await impl["time.wait.v1"]({ ms: 0 })).toMatchObject({ ok: true, waitedMs: 0 });
    expect(sleeps).toEqual([250, 120_000]);
    expect((await impl["time.wait.v1"]({ ms: -1 })).status).toBe("invalid-input");
  });
});
