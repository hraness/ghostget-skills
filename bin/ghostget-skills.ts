#!/usr/bin/env bun
// ghostget-skills — package entry point.
//
//   ghostget-skills list                                   packaged programs
//   ghostget-skills run <program> --args <json|@file>      run in-process
//        [--dir <store>] [--recorded <scenario|@file>] [--receipt] [--quiet]
//   ghostget-skills verify <receipt.json> [manifest] [--dir <store>]
//   ghostget-skills tools                                  resolved cmd: tool registry
//   ghostget-skills doctor [--json]                        pinned Ghostget + runtime readiness
//   ghostget-skills install-skills [--target <dir>]        copy skills/ into a skill registry
//
// `run` prints one JSON document: { program, outcome, outputs, receipt }.
// Add --receipt to print only the receipt (for `verify`), --quiet for
// outputs only. Exit 0 on a complete run, 1 when the run failed, 2 on usage.
// `doctor` prints text for people and JSON with --json or for an agent; it
// exits 1 when Ghostget is missing or lacks its contracts commands.

import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { JsonValue } from "@hraness/algal";
import {
  interfaceOutputs,
  liveDependencies,
  packageTools,
  PKG,
  PROGRAMS_DIR,
  recordedDependencies,
  runProgram,
  verifyRun,
} from "../src/run-program.ts";
import { resolveGhostgetExecutable, resolvePackageManifest } from "../src/ghostget-cli.ts";
import {
  COMMAND_HELP,
  doctorReady,
  programHelp,
  renderDoctor,
  style,
  USAGE,
  wantsJson,
  type DoctorReport,
  type ProgramManifest,
} from "../src/cli-text.ts";

const SKILLS = join(PKG, "skills");

/** Write to a stream and wait for the flush. Bun's pipe writes are async, so
 * a large document followed by an immediate `process.exit` is truncated at the
 * pipe buffer. Every command's output goes through these. */
async function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    stream.write(text, (error) => {
      // A reader that stopped early (`| head`) is not a failure.
      if (error && (error as NodeJS.ErrnoException).code !== "EPIPE") rejectWrite(error);
      else resolveWrite();
    });
  });
}
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
});

const out = (text: string) => write(process.stdout, text);
const err = (text: string) => write(process.stderr, text);
/** One-line usage error plus the help command to read next. */
async function usageError(message: string, command?: string): Promise<number> {
  const s = style(process.stderr);
  await err(`${s.fail} ${message}\n${s.next} ghostget-skills ${command === undefined ? "" : `${command} `}--help\n`);
  return 2;
}

type Flags = Record<string, string[] | true>;

function flags(rest: string[]): { flags: Flags; positional: string[] } {
  const out: Flags = {};
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === "-h") {
      out.help = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const name = argument.slice(2);
    const next = rest[index + 1];
    if (["receipt", "quiet", "help", "json"].includes(name) || next === undefined || next.startsWith("--")) {
      out[name] = true;
      continue;
    }
    const existing = out[name];
    out[name] = Array.isArray(existing) ? [...existing, next] : [next];
    index += 1;
  }
  return { flags: out, positional };
}

function flagValue(f: Flags, name: string): string | undefined {
  const value = f[name];
  return Array.isArray(value) ? value[0] : undefined;
}

async function readJsonArgument(value: string | undefined): Promise<unknown> {
  if (value === undefined) return undefined;
  const raw = value.startsWith("@") ? await readFile(resolve(value.slice(1)), "utf8") : value;
  return JSON.parse(raw) as unknown;
}

async function list(): Promise<void> {
  const rows: Array<Record<string, unknown>> = [];
  for (const file of readdirSync(PROGRAMS_DIR).filter((entry) => entry.endsWith(".algal.json")).sort()) {
    const manifest = JSON.parse(await readFile(join(PROGRAMS_DIR, file), "utf8")) as { key: string; note?: string; budgets?: { maxAgentCalls?: number }; interface?: { inputs?: Record<string, unknown>; outputs?: Record<string, unknown> } };
    rows.push({
      id: file.replace(".algal.json", ""),
      key: manifest.key,
      agent_calls: manifest.budgets?.maxAgentCalls ?? "?",
      inputs: Object.keys(manifest.interface?.inputs ?? {}),
      outputs: Object.keys(manifest.interface?.outputs ?? {}),
      note: manifest.note ?? "",
    });
  }
  await out(`${JSON.stringify({ package: "ghostget-skills", programs: rows }, null, 1)}\n`);
}

async function resolvedToolsFile(): Promise<string> {
  const raw = await readFile(join(PKG, "tools", "ghostget.tools.json"), "utf8");
  const resolved = raw.replaceAll("__PKG__", PKG);
  const name = `ghostget-skills-${createHash("sha256").update(PKG).digest("hex").slice(0, 12)}.tools.json`;
  const path = join(tmpdir(), name);
  writeFileSync(path, resolved, { mode: 0o600 });
  return path;
}

async function recordedTools(spec: string) {
  if (spec.startsWith("@")) {
    const responses = JSON.parse(await readFile(resolve(spec.slice(1)), "utf8")) as Parameters<typeof recordedDependencies>[0];
    return packageTools(recordedDependencies(responses));
  }
  const { recorded } = await import("../fixtures/recorded.ts");
  return packageTools(recordedDependencies(recorded(spec as Parameters<typeof recorded>[0])));
}

async function run(rest: string[]): Promise<number> {
  const { flags: f, positional } = flags(rest);
  const program = positional[0];
  if (!program) {
    if (f.help === true) {
      await out(COMMAND_HELP.run!);
      return 0;
    }
    return usageError("Name a program to run, such as ghostget-skills run page-read.", "run");
  }
  const manifestPath = program.endsWith(".algal.json") ? resolve(program) : join(PROGRAMS_DIR, `${program}.algal.json`);
  if (!existsSync(manifestPath)) {
    const s = style(process.stderr);
    await err(`${s.fail} No program named "${program}".\n${s.next} ghostget-skills list\n`);
    return 2;
  }
  if (f.help === true) {
    await out(programHelp(program.replace(/\.algal\.json$/u, ""), JSON.parse(await readFile(manifestPath, "utf8")) as ProgramManifest));
    return 0;
  }
  const args = (await readJsonArgument(flagValue(f, "args"))) as Record<string, Record<string, JsonValue>> | undefined;
  const recordedSpec = flagValue(f, "recorded");
  const tools = recordedSpec === undefined ? packageTools(liveDependencies()) : await recordedTools(recordedSpec);
  const receipt = await runProgram({
    manifestPath,
    ...(args === undefined ? {} : { args }),
    ...(flagValue(f, "dir") === undefined ? {} : { dir: flagValue(f, "dir")! }),
    tools,
  });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Parameters<typeof interfaceOutputs>[0];
  const outputs = interfaceOutputs(manifest, receipt);
  if (f.receipt === true) await out(`${JSON.stringify(receipt)}\n`);
  else if (f.quiet === true) await out(`${JSON.stringify(outputs)}\n`);
  else await out(`${JSON.stringify({ program: program.replace(/\.algal\.json$/u, ""), outcome: receipt.outcome, ...(receipt.failure ? { failure: receipt.failure } : {}), outputs, receipt })}\n`);
  return receipt.outcome === "complete" ? 0 : 1;
}

async function verify(rest: string[]): Promise<number> {
  const { flags: f, positional } = flags(rest);
  const receiptFile = positional[0];
  if (f.help === true) {
    await out(COMMAND_HELP.verify!);
    return 0;
  }
  if (!receiptFile) return usageError("Name the receipt file to verify.", "verify");
  const receiptDocument = JSON.parse(await readFile(resolve(receiptFile), "utf8")) as { receipt?: JsonValue; manifestKey?: string } & Record<string, unknown>;
  const receipt = (receiptDocument.receipt ?? receiptDocument) as JsonValue & { manifestKey?: string };
  let manifestFile = positional[1];
  if (!manifestFile) {
    const key = (receipt as { manifestKey?: string }).manifestKey ?? "";
    const id = key.replace(/^organism:/u, "");
    const candidate = join(PROGRAMS_DIR, `${id}.algal.json`);
    if (!existsSync(candidate)) {
      return usageError(`Can't tell which program made this receipt ("${key}"). Pass its manifest after the receipt.`, "verify");
    }
    manifestFile = candidate;
  }
  const report = await verifyRun(receipt, JSON.parse(await readFile(resolve(manifestFile), "utf8")) as JsonValue, flagValue(f, "dir"));
  await out(`${JSON.stringify(report, null, 1)}\n`);
  return report.ok ? 0 : 1;
}

async function doctor(rest: string[]): Promise<number> {
  const { flags: f } = flags(rest);
  if (f.help === true) {
    await out(COMMAND_HELP.doctor!);
    return 0;
  }
  const report = { package: "ghostget-skills" } as unknown as DoctorReport;
  let executable: string | null = null;
  try {
    executable = resolveGhostgetExecutable();
    report.ghostget = { resolved: true, source: process.env.GHOSTGET_BIN ? "GHOSTGET_BIN" : "pinned" };
    const version = Bun.spawnSync([executable, "--version"], { stdout: "pipe", stderr: "pipe" });
    report.ghostgetVersion = version.stdout.toString().trim() || null;
  } catch (error) {
    report.ghostget = { resolved: false, diagnostic: String(error).replace(/\/(?:Users|home)\/[^\s"']+/gu, "<path>") };
    report.ghostgetVersion = null;
  }
  // Dependencies may be nested or hoisted; resolve both manifests the same way.
  for (const [key, name] of [["pinnedGhostgetPackage", "@hraness/ghostget"], ["algalVersion", "@hraness/algal"]] as const) {
    const manifestPath = resolvePackageManifest(name);
    report[key] = manifestPath === null
      ? null
      : (JSON.parse(await readFile(manifestPath, "utf8")) as { version?: string }).version ?? null;
  }
  report.programs = readdirSync(PROGRAMS_DIR).filter((entry) => entry.endsWith(".algal.json")).length;
  report.contractsCommandAvailable = false;
  if (executable !== null) {
    const probe = Bun.spawnSync([executable, "contracts", "schema", "plan", "--json"], { stdout: "pipe", stderr: "pipe" });
    report.contractsCommandAvailable = probe.exitCode === 0;
  }
  report.ok = doctorReady(report);
  if (wantsJson(f.json === true)) await out(`${JSON.stringify(report, null, 1)}\n`);
  else await out(renderDoctor(report, style(process.stdout)));
  return doctorReady(report) ? 0 : 1;
}

async function installSkills(rest: string[]): Promise<number> {
  const { flags: f } = flags(rest);
  if (f.help === true) {
    await out(COMMAND_HELP["install-skills"]!);
    return 0;
  }
  const target = flagValue(f, "target") ? resolve(flagValue(f, "target")!) : join(process.cwd(), ".agents", "skills");
  if (!existsSync(SKILLS)) {
    await err("ghostget-skills: no skills/ directory in this package\n");
    return 2;
  }
  for (const entry of readdirSync(SKILLS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const destination = join(target, entry.name);
    if (existsSync(destination)) {
      await out(`kept ${entry.name} (exists) -> ${destination}\n`);
      continue;
    }
    mkdirSync(destination, { recursive: true });
    cpSync(join(SKILLS, entry.name), destination, { recursive: true });
    await out(`installed ${entry.name} -> ${destination}\n`);
  }
  return 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== undefined && Object.hasOwn(COMMAND_HELP, command) && (rest.includes("--help") || rest.includes("-h")) && command !== "run") {
    await out(COMMAND_HELP[command]!);
    return 0;
  }
  switch (command) {
    case "list":
    case undefined:
      await list();
      return 0;
    case "tools":
      await out(await readFile(await resolvedToolsFile(), "utf8"));
      return 0;
    case "run":
      return run(rest);
    case "verify":
      return verify(rest);
    case "doctor":
      return doctor(rest);
    case "install-skills":
      return installSkills(rest);
    case "--help":
    case "-h":
    case "help": {
      const topic = rest[0];
      if (topic === undefined || topic === "--help" || topic === "-h") {
        await out(USAGE);
        return 0;
      }
      const help = Object.hasOwn(COMMAND_HELP, topic) ? COMMAND_HELP[topic] : undefined;
      if (help === undefined) return usageError(`No help topic named "${topic}".`);
      await out(help);
      return 0;
    }
    default:
      return usageError(`Unknown command "${command}".`);
  }
}

const code = await main();
// Never call process.exit here: pending stdout writes to a pipe would be cut.
process.exitCode = code;
