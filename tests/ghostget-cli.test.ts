// ghostget-cli boundary — deterministic, no Ghostget process.

import { describe, expect, test } from "bun:test";
import {
  callKey,
  canonicalJson,
  firstJsonDocument,
  recordedRunner,
  redactDiagnostic,
  resolveGhostgetExecutable,
} from "../src/ghostget-cli.ts";

describe("firstJsonDocument", () => {
  test("parses a whole document", () => {
    expect(firstJsonDocument('{"ok":true}\n')).toEqual({ ok: true });
  });
  test("parses the first balanced document when a discovery line follows", () => {
    const text = '{"ok":true,"nested":{"a":"}"}}\n{"schemaVersion":"hraness-support-discovery-v1"}\n';
    expect(firstJsonDocument(text)).toEqual({ ok: true, nested: { a: "}" } });
  });
  test("returns null for non-JSON output", () => {
    expect(firstJsonDocument("Example Domain\n")).toBeNull();
    expect(firstJsonDocument("")).toBeNull();
  });
});

describe("redactDiagnostic", () => {
  test("strips home paths and token-shaped strings", () => {
    const text = "failed at /Users/someone/.local/share/wrench/x with ghp_abcdefghijklmnopqrstuvwxyz";
    const redacted = redactDiagnostic(text);
    expect(redacted).not.toContain("/Users/");
    expect(redacted).not.toContain("ghp_");
    expect(redacted).toContain("<path>");
    expect(redacted).toContain("<redacted>");
  });
});

describe("resolveGhostgetExecutable", () => {
  test("rejects a relative override", () => {
    expect(() => resolveGhostgetExecutable({ GHOSTGET_BIN: "node_modules/.bin/ghostget" })).toThrow("absolute");
  });
  test("rejects a missing override", () => {
    expect(() => resolveGhostgetExecutable({ GHOSTGET_BIN: "/definitely/missing/ghostget" })).toThrow("does not exist");
  });
});

describe("callKey and canonicalJson", () => {
  test("canonical JSON sorts keys and is stable", () => {
    expect(canonicalJson({ b: 1, a: [true, null, { z: 1, y: 2 }] })).toBe('{"a":[true,null,{"y":2,"z":1}],"b":1}');
  });
  test("key omits --json and canonicalises stdin", () => {
    expect(callKey({ argv: ["invoke", "x-web", "profiles.read", "--json", "--input", "-"], stdin: '{"handle": "a"}' }))
      .toBe('invoke x-web profiles.read --input - <<< {"handle":"a"}');
  });
  test("explicit key wins", () => {
    expect(callKey({ argv: ["contracts", "check", "--plan", "/tmp/x"], key: "contracts check --plan <<< {}" })).toBe("contracts check --plan <<< {}");
  });
});

describe("recordedRunner", () => {
  test("serves exact keys, wildcard prefixes, and sequenced lists", async () => {
    const runner = recordedRunner({
      "doctor": { json: { ok: true } },
      "contracts check --plan *": { json: { contract: "ghostget.contract-check.v1" }, code: 4 },
      "invoke a b --input - <<< {}": [{ json: { status: "failed" }, code: 1 }, { json: { status: "succeeded" } }],
    });
    expect((await runner({ argv: ["doctor"] })).json).toEqual({ ok: true });
    const check = await runner({ argv: ["contracts", "check", "--plan", "/private/tmp/plan.json"], key: "contracts check --plan <<< {\"a\":1}" });
    expect(check.exit).toEqual({ kind: "exited", code: 4 });
    const first = await runner({ argv: ["invoke", "a", "b", "--input", "-"], stdin: "{}" });
    const second = await runner({ argv: ["invoke", "a", "b", "--input", "-"], stdin: "{}" });
    const third = await runner({ argv: ["invoke", "a", "b", "--input", "-"], stdin: "{}" });
    expect((first.json as { status: string }).status).toBe("failed");
    expect((second.json as { status: string }).status).toBe("succeeded");
    expect((third.json as { status: string }).status).toBe("succeeded");
  });
  test("misses fail closed and report the key", async () => {
    const misses: string[] = [];
    const runner = recordedRunner({}, (key) => misses.push(key));
    const result = await runner({ argv: ["auth", "list"] });
    expect(result.exit).toEqual({ kind: "exited", code: 2 });
    expect(result.json).toBeNull();
    expect(misses).toEqual(["auth list"]);
  });
});
