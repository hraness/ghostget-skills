// CLI copy — help, usage errors, doctor, and output hygiene. Golden files pin
// the exact text; set GHOSTGET_SKILLS_UPDATE_GOLDEN=1 to rewrite them.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMAND_HELP, programHelp, renderDoctor, style, USAGE, wantsJson, type DoctorReport } from "../src/cli-text.ts";

const BIN = join(import.meta.dir, "..", "bin", "ghostget-skills.ts");
const GOLDEN = join(import.meta.dir, "golden");
const HOME = mkdtempSync(join(tmpdir(), "ghostget-skills-cli-"));

function golden(name: string, actual: string): void {
  const path = join(GOLDEN, name);
  if (process.env.GHOSTGET_SKILLS_UPDATE_GOLDEN === "1" || !existsSync(path)) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(path, actual);
  }
  expect(actual).toBe(readFileSync(path, "utf8"));
}

function cli(args: readonly string[], env: Record<string, string> = {}) {
  const child = Bun.spawnSync([process.execPath, BIN, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

describe("help", () => {
  test("root help is grouped and exits 0", () => {
    for (const argv of [["--help"], ["-h"], ["help"], ["help", "--help"], ["help", "-h"]]) {
      const result = cli(argv);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(USAGE);
    }
    golden("root-help.txt", USAGE);
  });

  test.each(Object.keys(COMMAND_HELP))("%s --help exits 0", (command) => {
    const result = cli([command, "--help"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(COMMAND_HELP[command]!);
    expect(cli(["help", command]).stdout).toBe(COMMAND_HELP[command]!);
    golden(`help-${command}.txt`, COMMAND_HELP[command]!);
  });

  test("run <program> --help describes that program", () => {
    const result = cli(["run", "page-read", "--help"]);
    expect(result.code).toBe(0);
    golden("help-run-page-read.txt", result.stdout);
    expect(result.stdout).toContain("--args src.url");
  });

  test("programHelp renders ports and a keyed example", () => {
    expect(programHelp("demo", {
      note: "Demo program.",
      interface: { inputs: { url: { cell: "src", port: "url" } }, outputs: { text: { cell: "fmt", port: "out" } } },
    })).toBe([
      "Usage: ghostget-skills run demo --args <json|@file> [--quiet]",
      "",
      "Demo program.",
      "",
      "Inputs:",
      "  url  (--args src.url)",
      "",
      "Outputs:",
      "  text",
      "",
      "Example: ghostget-skills run demo --args '{\"src\":{\"url\":\"<url>\"}}' --quiet",
      "",
    ].join("\n"));
    expect(programHelp("empty", {})).toContain("Inputs:\n  none\n");
  });
});

describe("usage errors", () => {
  test("unknown command is one line plus the help to read", () => {
    const result = cli(["stauts"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    golden("error-unknown-command.txt", result.stderr);
  });

  test("run without a program", () => {
    const result = cli(["run"]);
    expect(result.code).toBe(2);
    golden("error-run-missing.txt", result.stderr);
  });

  test("unknown program points at list", () => {
    const result = cli(["run", "nope"]);
    expect(result.code).toBe(2);
    golden("error-unknown-program.txt", result.stderr);
  });

  test("built-in object names are unknown commands, not crashes", () => {
    const command = cli(["toString", "--help"]);
    expect(command.code).toBe(2);
    expect(command.stderr).toBe("✗ Unknown command \"toString\".\n→ ghostget-skills --help\n");
    const topic = cli(["help", "constructor"]);
    expect(topic.code).toBe(2);
    expect(topic.stderr).toBe("✗ No help topic named \"constructor\".\n→ ghostget-skills --help\n");
  });

  test("verify without a receipt", () => {
    const result = cli(["verify"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("✗ Name the receipt file to verify.\n→ ghostget-skills verify --help\n");
  });

  test("TERM=dumb uses ASCII symbols and NO_COLOR never adds escapes", () => {
    expect(cli(["stauts"], { TERM: "dumb" }).stderr).toBe("FAIL Unknown command \"stauts\".\n-> ghostget-skills --help\n");
    const plain = cli(["stauts"], { NO_COLOR: "1" }).stderr;
    expect(plain).not.toContain("\u001b[");
  });
});

describe("output hygiene", () => {
  test("a closed pipe does not crash", () => {
    const child = Bun.spawnSync(["/bin/sh", "-c", `"${process.execPath}" "${BIN}" tools | head -c 16`], {
      env: { PATH: process.env.PATH ?? "", HOME },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    expect(child.stderr.toString()).not.toMatch(/EPIPE|Error|at /u);
  });

  test("symbols follow the terminal", () => {
    expect(style({ isTTY: true }, { NO_COLOR: "" }).ok).toBe("\u001b[32m✓\u001b[0m");
    expect(style({ isTTY: true }, { NO_COLOR: "1" }).ok).toBe("✓");
    expect(style({ isTTY: false }, {}).fail).toBe("✗");
    expect(style({ isTTY: true }, { TERM: "dumb" }).next).toBe("->");
  });

  test("JSON only for --json or an agent", () => {
    expect(wantsJson(true, {})).toBe(true);
    expect(wantsJson(false, {})).toBe(false);
    expect(wantsJson(false, { CLAUDECODE: "1" })).toBe(true);
    expect(wantsJson(false, { CLAUDECODE: "1", HRANESS_AUDIENCE: "human" })).toBe(false);
    expect(wantsJson(false, { CODEX: "1" })).toBe(false);
  });
});

describe("doctor", () => {
  const ready: DoctorReport = {
    package: "ghostget-skills",
    ghostget: { resolved: true, source: "pinned" },
    ghostgetVersion: "ghostget 0.18.38",
    contractsCommandAvailable: true,
    programs: 8,
    algalVersion: "0.4.0",
  };
  const plain = style({ isTTY: false }, {});

  test("ready summary", () => {
    golden("doctor-ready.txt", renderDoctor(ready, plain));
  });

  test("missing contracts commands", () => {
    golden("doctor-no-contracts.txt", renderDoctor({ ...ready, contractsCommandAvailable: false }, plain));
  });

  test("missing Ghostget", () => {
    golden("doctor-missing.txt", renderDoctor({
      ...ready,
      ghostget: { resolved: false, diagnostic: "GHOSTGET_BIN must be an absolute path" },
      ghostgetVersion: null,
      contractsCommandAvailable: false,
    }, style({ isTTY: false }, { TERM: "dumb" })));
  });

  test("a missing Ghostget exits 1, as text or JSON", () => {
    const env = { GHOSTGET_BIN: "/nonexistent/ghostget-for-test" };
    const text = cli(["doctor"], env);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain("✗ Ghostget not found");
    expect(text.stdout).toContain("→ Reinstall ghostget-skills, or set GHOSTGET_BIN to an absolute path");
    const json = cli(["doctor", "--json"], env);
    expect(json.code).toBe(1);
    const report = JSON.parse(json.stdout) as { ok: boolean; ghostget: { resolved: boolean } };
    expect(report.ok).toBe(false);
    expect(report.ghostget.resolved).toBe(false);
    const agent = cli(["doctor"], { ...env, CLAUDECODE: "1" });
    expect(() => JSON.parse(agent.stdout) as unknown).not.toThrow();
  });
});
