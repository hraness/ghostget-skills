// ghostget-cli boundary — deterministic, no Ghostget process.

import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callKey,
  canonicalJson,
  firstJsonDocument,
  pinnedGhostgetCandidates,
  recordedRunner,
  redactDiagnostic,
  resolveGhostgetExecutable,
  resolvePackageManifest,
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

describe("dependency resolution across install layouts", () => {
  // A package manager nests dependencies under this package in a development
  // checkout and hoists them beside it in an ordinary consumer install.
  const consumer = mkdtempSync(join(tmpdir(), "ghostget-skills-layout-"));
  const root = join(consumer, "node_modules", "ghostget-skills");
  mkdirSync(join(root, "node_modules"), { recursive: true });
  mkdirSync(join(consumer, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(consumer, "node_modules", "@hraness", "algal"), { recursive: true });
  writeFileSync(join(consumer, "node_modules", ".bin", "ghostget"), "#!/bin/sh\n");
  writeFileSync(join(consumer, "node_modules", "@hraness", "algal", "package.json"), '{"version":"9.9.9"}');

  test("candidates include the nested and the hoisted layout, nearest first", () => {
    const candidates = pinnedGhostgetCandidates(root);
    expect(candidates[0]).toBe(join(root, "node_modules", ".bin", "ghostget"));
    expect(candidates).toContain(join(consumer, "node_modules", ".bin", "ghostget"));
    expect(new Set(candidates).size).toBe(candidates.length);
  });
  test("a hoisted binary resolves when nothing is nested", () => {
    // Resolution returns a realpath, so compare against one.
    expect(resolveGhostgetExecutable({}, root)).toBe(realpathSync(join(consumer, "node_modules", ".bin", "ghostget")));
  });
  test("a hoisted package manifest resolves", () => {
    expect(resolvePackageManifest("@hraness/algal", root)).toBe(join(consumer, "node_modules", "@hraness", "algal", "package.json"));
    expect(resolvePackageManifest("@hraness/not-installed", root)).toBeNull();
  });
  test("no candidate anywhere is an explicit, actionable failure", () => {
    const empty = mkdtempSync(join(tmpdir(), "ghostget-skills-empty-"));
    expect(() => resolveGhostgetExecutable({}, empty)).toThrow("set GHOSTGET_BIN");
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
