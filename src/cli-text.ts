// cli-text — the ghostget-skills command-line copy: help, symbols, the
// audience rule, and the human doctor summary. Pure, so tests can pin it.

export const USAGE = `Usage: ghostget-skills <command> [options]

Run GhostGet workflows as replayable programs with no model calls.

Commands:
  list                       List the packaged programs (JSON)
  run <program>              Run one program and print its JSON result
  verify <receipt.json>      Replay a run from its receipt without GhostGet
  tools                      Print the resolved tool registry (JSON)
  doctor                     Check the pinned GhostGet and runtime
  install-skills             Copy the agent skills into a skill folder

Run ghostget-skills <command> --help for its options.
`;

export const COMMAND_HELP: Readonly<Record<string, string>> = {
  list: `Usage: ghostget-skills list

Print every packaged program with its inputs and outputs as JSON.
`,
  run: `Usage: ghostget-skills run <program> --args <json|@file> [options]

Run one program in-process and print { program, outcome, outputs, receipt }.

Options:
  --args <json|@file>          Program inputs, keyed by input cell
  --dir <store>                Keep program memory in this folder
  --recorded <scenario|@file>  Use recorded GhostGet responses instead of GhostGet
  --receipt                    Print only the receipt, for verify
  --quiet                      Print only the outputs

Exit status: 0 when the run completes, 1 when it fails, 2 on a usage error.
Run ghostget-skills run <program> --help for one program's inputs.
`,
  verify: `Usage: ghostget-skills verify <receipt.json> [manifest.algal.json] [--dir <store>]

Replay a run bit-for-bit from its receipt, without GhostGet or a provider.
Exit status: 0 when the replay matches, 1 when it does not.
`,
  tools: `Usage: ghostget-skills tools

Print the resolved tool registry the programs call, as JSON.
`,
  doctor: `Usage: ghostget-skills doctor [--json]

Check that the pinned GhostGet runs and has its contracts commands.
Exit status: 0 when ready, 1 when something needs fixing.
`,
  "install-skills": `Usage: ghostget-skills install-skills [--target <dir>]

Copy the agent skills into <dir> (default ./.agents/skills). Existing skills are kept.
`,
};

/** Symbols per the Hraness CLI style: color only on a TTY without NO_COLOR, ASCII on TERM=dumb. */
export function style(stream: { readonly isTTY?: boolean }, env: Readonly<Record<string, string | undefined>> = process.env) {
  const ascii = env.HRANESS_ASCII === "1" || env.TERM === "dumb";
  const color = stream.isTTY === true && env.TERM !== "dumb" && (env.NO_COLOR ?? "") === "";
  const paint = (code: string, text: string) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
  return {
    ok: paint("32", ascii ? "OK" : "✓"),
    fail: paint("31", ascii ? "FAIL" : "✗"),
    next: paint("2", ascii ? "->" : "→"),
  };
}

export const AGENT_MARKERS = ["AI_AGENT", "CLAUDECODE", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CURSOR_AGENT", "GEMINI_CLI"];

/** JSON for --json or a detected agent; text for people. */
export function wantsJson(json: boolean, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (json) return true;
  const audience = env.HRANESS_AUDIENCE;
  if (audience === "human" || audience === "quiet" || audience === "off") return false;
  if (audience === "agent") return true;
  return AGENT_MARKERS.some((name) => (env[name] ?? "") !== "");
}

export type ProgramManifest = {
  key?: string;
  note?: string;
  interface?: { inputs?: Record<string, unknown>; outputs?: Record<string, unknown> };
};

type Port = { readonly cell: string; readonly port: string };

function ports(cells: Record<string, unknown> | undefined): Array<{ name: string } & Port> {
  return Object.entries(cells ?? {}).flatMap(([name, value]) => {
    const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
    return typeof record.cell === "string" && typeof record.port === "string"
      ? [{ name, cell: record.cell, port: record.port }]
      : [{ name, cell: "src", port: name }];
  });
}

/** Per-program help: what it does, its inputs, its outputs, and a runnable example. */
export function programHelp(id: string, manifest: ProgramManifest): string {
  const inputs = ports(manifest.interface?.inputs);
  const outputs = ports(manifest.interface?.outputs);
  // --args is keyed by input cell, then port.
  const example: Record<string, Record<string, string>> = {};
  for (const input of inputs) (example[input.cell] ??= {})[input.port] = `<${input.name}>`;
  return [
    `Usage: ghostget-skills run ${id} --args <json|@file> [--quiet]`,
    "",
    ...(manifest.note ? [manifest.note, ""] : []),
    "Inputs:",
    ...(inputs.length > 0 ? inputs.map((input) => `  ${input.name}  (--args ${input.cell}.${input.port})`) : ["  none"]),
    "",
    "Outputs:",
    ...(outputs.length > 0 ? outputs.map((output) => `  ${output.name}`) : ["  none"]),
    "",
    `Example: ghostget-skills run ${id} --args '${JSON.stringify(example)}' --quiet`,
    "",
  ].join("\n");
}

export type DoctorReport = Record<string, unknown> & {
  ghostget: { resolved: boolean; source?: string; diagnostic?: string };
  ghostgetVersion: string | null;
  contractsCommandAvailable: boolean;
  programs: number;
};

export function doctorReady(report: DoctorReport): boolean {
  return report.ghostget.resolved && report.contractsCommandAvailable;
}

/** Human doctor summary: one line per check and one next step when not ready. */
export function renderDoctor(report: DoctorReport, s: ReturnType<typeof style>): string {
  const lines: string[] = [];
  if (report.ghostget.resolved) {
    const version = report.ghostgetVersion ?? "unknown version";
    lines.push(`${s.ok} Ghostget ${version.replace(/^ghostget\s+/iu, "")} (${report.ghostget.source === "GHOSTGET_BIN" ? "from GHOSTGET_BIN" : "pinned"})`);
    lines.push(report.contractsCommandAvailable
      ? `${s.ok} Ghostget contracts commands available`
      : `${s.fail} This Ghostget has no contracts commands`);
  } else {
    lines.push(`${s.fail} Ghostget not found: ${report.ghostget.diagnostic ?? "no executable"}`);
  }
  lines.push(`${s.ok} ${report.programs} programs${typeof report.algalVersion === "string" ? ` · algal ${report.algalVersion}` : ""}`);
  if (!report.ghostget.resolved) lines.push(`${s.next} Reinstall ghostget-skills, or set GHOSTGET_BIN to an absolute path`);
  else if (!report.contractsCommandAvailable) lines.push(`${s.next} Upgrade the pinned Ghostget`);
  return `${lines.join("\n")}\n`;
}

