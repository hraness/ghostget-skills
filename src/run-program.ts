#!/usr/bin/env bun
// run-program — the ghostget-skills in-process runner.
//
// Runs a packaged (or caller-supplied) organism manifest through the ALGAL
// runtime with this package's Ghostget tools wired in-process as a
// ToolRegistry. Programs ship with zero model calls: every decision is an
// `expr` cell, every nondeterministic step is a tool effect on the receipt,
// and `verify` replays the run bit-for-bit without touching Ghostget.
//
//   runProgram({ manifestPath, args, dir, tools? }) -> RunReceipt
//   packageTools(deps?)                              -> ToolRegistry
//   verifyRun(receiptJson, manifestJson, dir)        -> VerifyReport

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  FileStore,
  parseOrganismManifest,
  parseToolSignature,
  runOrganism,
  verifyReceipt,
} from "@hraness/algal";
import type {
  JsonValue,
  RunReceipt,
  ToolRegistry,
  VerifyReport,
} from "@hraness/algal";
import registrySpec from "../tools/ghostget.tools.json" with { type: "json" };
import { buildTools, TOOL_NAMES, type ToolDependencies, type ToolName } from "../tools/tool.ts";
import { ghostgetRunner, recordedRunner, PKG, type RecordedResponses } from "./ghostget-cli.ts";
import { packageFns } from "./fns.ts";

export { PKG };
export const PROGRAMS_DIR = join(PKG, "programs");

type RegistrySpec = Record<string, { signature: unknown; exec: string }>;
const spec = registrySpec as RegistrySpec;

export function liveDependencies(environment?: Readonly<Record<string, string | undefined>>): ToolDependencies {
  return {
    ghostget: ghostgetRunner(environment === undefined ? {} : { environment }),
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  };
}

/** Recorded dependencies: fixed Ghostget responses and an instant clock. */
export function recordedDependencies(
  responses: RecordedResponses,
  onMiss?: (key: string) => void,
): ToolDependencies {
  return { ghostget: recordedRunner(responses, onMiss), sleep: async () => undefined };
}

/** In-process tool registry mirroring tools/ghostget.tools.json. */
export function packageTools(deps: ToolDependencies = liveDependencies()): ToolRegistry {
  const impls = buildTools(deps);
  const registry: ToolRegistry = new Map();
  for (const name of TOOL_NAMES) {
    const entry = spec[name];
    if (!entry) throw new Error(`tools/ghostget.tools.json is missing ${name}`);
    const impl = impls[name as ToolName];
    registry.set(name, {
      signature: parseToolSignature(entry.signature, name),
      tool: async (inputs) => {
        try {
          return { report: (await impl(inputs as Readonly<Record<string, JsonValue>>)) as JsonValue };
        } catch (error) {
          return { report: { ok: false, status: "tool-error", diagnostic: String(error).slice(0, 300) } };
        }
      },
    });
  }
  return registry;
}

export async function loadModulesInto(dir: string, store: FileStore): Promise<number> {
  let count = 0;
  for (const file of (await readdir(dir)).sort()) {
    if (!file.endsWith(".algal.json")) continue;
    await store.putManifest(parseOrganismManifest(JSON.parse(await readFile(join(dir, file), "utf8"))));
    count += 1;
  }
  return count;
}

/** Interface outputs of a receipt, resolved through the manifest's interface map. */
export function interfaceOutputs(
  manifest: { interface?: { outputs: Record<string, { cell: string; port: string }> } },
  receipt: RunReceipt,
): Record<string, JsonValue | null> {
  const outputs: Record<string, JsonValue | null> = {};
  for (const [name, target] of Object.entries(manifest.interface?.outputs ?? {})) {
    outputs[name] = receipt.cells[target.cell]?.outputs?.[target.port] ?? null;
  }
  return outputs;
}

export type RunProgramOptions = {
  readonly manifestPath: string;
  readonly args?: Record<string, Record<string, JsonValue>>;
  readonly dir?: string;
  readonly modulesDir?: string;
  readonly tools?: ToolRegistry;
};

export async function runProgram(options: RunProgramOptions): Promise<RunReceipt> {
  const store = new FileStore(resolve(options.dir ?? ".algal"));
  await loadModulesInto(options.modulesDir ?? PROGRAMS_DIR, store);
  const manifest = parseOrganismManifest(JSON.parse(await readFile(resolve(options.manifestPath), "utf8")));
  return runOrganism({
    manifest,
    args: options.args ?? {},
    fns: packageFns(),
    store,
    executors: [],
    tools: options.tools ?? packageTools(),
  });
}

export async function verifyRun(
  receiptJson: JsonValue,
  manifestJson: JsonValue,
  dir?: string,
  tools?: ToolRegistry,
): Promise<VerifyReport> {
  const store = new FileStore(resolve(dir ?? ".algal"));
  await loadModulesInto(PROGRAMS_DIR, store);
  // Verification never reaches Ghostget: recorded tool effects are served
  // verbatim, and a missing effect fails closed (EFFECT_UNBOUND).
  const replayTools = tools ?? packageTools(recordedDependencies({}));
  return verifyReceipt(receiptJson, manifestJson, store, packageFns(), undefined, replayTools);
}
