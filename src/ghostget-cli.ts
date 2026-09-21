// ghostget-cli — the one place ghostget-skills talks to Ghostget.
//
// Every call is a fixed argv over the pinned Ghostget executable with `--json`,
// input on stdin, stdout byte-capped, one deadline, and a TERM grace long
// enough for Ghostget to finish proving provider cleanup. The wrapper never
// throws for provider outcomes: it returns a structured record, and the tool
// layer projects that record into a secret-free report.
//
// Custody: cookies, tokens, subjects, HAR content, and local paths stay inside
// the Ghostget process and its state home. Only auth locator IDs cross this
// boundary, and only as inputs.

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const PKG = resolve(new URL("..", import.meta.url).pathname);

/** The only executable this package runs by default. */
export const PINNED_GHOSTGET_EXECUTABLE = join(PKG, "node_modules", ".bin", "ghostget");

// Fixed profile reads may use their full 60 s provider deadline, and Ghostget
// then reserves 30 s to join registered cleanup. Keep the outer deadline beyond
// both so a consumer never sends TERM while cleanup is still being proved.
export const DEFAULT_DEADLINE_MS = 120_000;
// TERM grace beyond the cleanup boundary so KILL cannot interrupt a verified
// cleanup and turn a recoverable timeout into a categorical failure.
export const DEFAULT_TERM_GRACE_MS = 45_000;
export const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
export const MAX_STDERR_BYTES = 8 * 1024;
export const MAX_STDIN_BYTES = 1024 * 1024;

export type GhostgetCall = {
  readonly argv: readonly string[];
  readonly stdin?: string;
  /** Text-mode command: do not append `--json`; return bounded stdout text. */
  readonly raw?: boolean;
  readonly deadlineMs?: number;
  readonly termGraceMs?: number;
  readonly signal?: AbortSignal;
  /** Stable identity for recorded runners when argv carries a temp path. */
  readonly key?: string;
};

export type GhostgetExit =
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "terminated"; readonly signal: "SIGTERM" | "SIGKILL" }
  | { readonly kind: "spawn-failed"; readonly message: string };

export type GhostgetResult = {
  readonly exit: GhostgetExit;
  /** The first JSON document on stdout, or null when none parsed. */
  readonly json: unknown;
  /** Bounded stdout text; present only for `raw` calls. */
  readonly stdout?: string;
  readonly stdoutBytes: number;
  readonly stdoutTruncated: boolean;
  /** Bounded, redacted stderr tail for diagnostics. */
  readonly stderrTail: string;
  readonly durationMs: number;
};

export type GhostgetRunner = (call: GhostgetCall) => Promise<GhostgetResult>;

const PRIVATE_PATH = /\/(?:Users|home)\/[^\s"'`]+/g;
const SECRET_LIKE = /(?:sk|ghp|npm|xox[abp])_[A-Za-z0-9-]{16,}/g;

/** Strip absolute home paths and token-shaped strings from diagnostic text. */
export function redactDiagnostic(text: string): string {
  return text.replace(PRIVATE_PATH, "<path>").replace(SECRET_LIKE, "<redacted>");
}

/**
 * Resolve the executable. `GHOSTGET_BIN` may override it only with an absolute
 * path to an existing file — a development worktree runner, or a consumer's
 * own pinned installation. A relative override is rejected so a stray PATH or
 * cwd can never redirect authenticated work.
 */
export function resolveGhostgetExecutable(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = environment.GHOSTGET_BIN?.trim();
  if (override) {
    if (!isAbsolute(override)) throw new Error("GHOSTGET_BIN must be an absolute path");
    if (!existsSync(override)) throw new Error("GHOSTGET_BIN does not exist");
    return realpathSync(override);
  }
  if (!existsSync(PINNED_GHOSTGET_EXECUTABLE)) {
    throw new Error("pinned Ghostget executable is missing; run bun install in ghostget-skills");
  }
  return realpathSync(PINNED_GHOSTGET_EXECUTABLE);
}

/** Parse the first complete JSON document from a stdout buffer. */
export function firstJsonDocument(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Ghostget may append a discovery line; scan for a balanced prefix.
  }
  const start = trimmed.search(/[[{]/);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, index + 1)) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export type SpawnOptions = {
  readonly executable?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
};

/** The live runner: one child process per call, bounded in every dimension. */
export function ghostgetRunner(options: SpawnOptions = {}): GhostgetRunner {
  return (call) => new Promise((resolveResult) => {
    const started = Date.now();
    let executable: string;
    try {
      executable = options.executable ?? resolveGhostgetExecutable(options.environment);
    } catch (error) {
      resolveResult({
        exit: { kind: "spawn-failed", message: redactDiagnostic(String(error)) },
        json: null, stdoutBytes: 0, stdoutTruncated: false, stderrTail: "", durationMs: 0,
      });
      return;
    }
    const stdin = call.stdin ?? "";
    if (Buffer.byteLength(stdin, "utf8") > MAX_STDIN_BYTES) {
      resolveResult({
        exit: { kind: "spawn-failed", message: "stdin exceeds the 1 MiB bound" },
        json: null, stdoutBytes: 0, stdoutTruncated: false, stderrTail: "", durationMs: 0,
      });
      return;
    }
    const argv = [...call.argv];
    if (!call.raw && !argv.includes("--json")) argv.push("--json");
    const child = spawn(executable, argv, {
      env: { ...(options.environment ?? process.env) },
      stdio: [stdin === "" ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutTruncated = false;
    let stderr = "";
    let settled = false;
    let termSent = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = call.deadlineMs ?? DEFAULT_DEADLINE_MS;
    const grace = call.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
    const terminate = () => {
      if (termSent) return;
      termSent = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), grace);
    };
    const deadlineTimer = setTimeout(terminate, deadline);
    const onAbort = () => terminate();
    call.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes + chunk.length > MAX_STDOUT_BYTES) {
        stdoutTruncated = true;
        const room = MAX_STDOUT_BYTES - stdoutBytes;
        if (room > 0) stdoutChunks.push(chunk.subarray(0, room));
        stdoutBytes = MAX_STDOUT_BYTES;
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString("utf8");
    });
    const finish = (exit: GhostgetExit) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (killTimer) clearTimeout(killTimer);
      call.signal?.removeEventListener("abort", onAbort);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      resolveResult({
        exit,
        json: call.raw || stdoutTruncated ? null : firstJsonDocument(stdout),
        ...(call.raw ? { stdout } : {}),
        stdoutBytes,
        stdoutTruncated,
        stderrTail: redactDiagnostic(stderr.slice(-MAX_STDERR_BYTES)).trim().split("\n").slice(-6).join("\n"),
        durationMs: Date.now() - started,
      });
    };
    child.on("error", (error) => finish({ kind: "spawn-failed", message: redactDiagnostic(String(error)) }));
    child.on("close", (code, signal) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") finish({ kind: "terminated", signal });
      else finish({ kind: "exited", code: code ?? 1 });
    });
    if (stdin !== "" && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin);
    }
  });
}

/**
 * A recorded runner for tests, fixtures, and benchmarks. Responses are keyed
 * by the canonical call key; a missing key returns an explicit `exited 2`
 * with no JSON so a program under test fails closed rather than inventing
 * provider data.
 */
export function callKey(call: Pick<GhostgetCall, "argv" | "stdin" | "key">): string {
  if (call.key !== undefined) return call.key;
  const argv = call.argv.filter((argument) => argument !== "--json");
  return `${argv.join(" ")}${call.stdin ? ` <<< ${canonicalJsonText(call.stdin)}` : ""}`;
}

function canonicalJsonText(text: string): string {
  try {
    return canonicalJson(JSON.parse(text));
  } catch {
    return text;
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export type RecordedResponse =
  | { readonly json: unknown; readonly code?: number }
  | { readonly stdout: string; readonly code?: number }
  | { readonly exit: GhostgetExit; readonly json?: unknown; readonly stdout?: string; readonly stderrTail?: string };

export type RecordedResponses = Readonly<Record<string, RecordedResponse | readonly RecordedResponse[]>>;

/**
 * Keys are exact call keys, or `<prefix> *` wildcards matched by prefix when
 * no exact key exists. A list value is consumed in order (one response per
 * call) so a retry-then-succeed sequence can be recorded; the last entry
 * repeats once the list is exhausted.
 */
export function recordedRunner(
  responses: RecordedResponses,
  onMiss?: (key: string) => void,
): GhostgetRunner {
  const queues = new Map<string, RecordedResponse[]>();
  const wildcards = Object.keys(responses).filter((key) => key.endsWith(" *")).map((key) => key.slice(0, -1));
  const lookup = (key: string): RecordedResponse | undefined => {
    const exact = key in responses ? key : wildcards.find((prefix) => key.startsWith(prefix));
    const matched = exact === undefined ? undefined : responses[exact in responses ? exact : `${exact}*`];
    if (matched === undefined) return undefined;
    if (!Array.isArray(matched)) return matched as RecordedResponse;
    const queueKey = exact as string;
    const queue = queues.get(queueKey) ?? [...(matched as readonly RecordedResponse[])];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    queues.set(queueKey, queue);
    return next;
  };
  return async (call) => {
    const key = callKey(call);
    const hit = lookup(key);
    if (hit === undefined) {
      onMiss?.(key);
      return {
        exit: { kind: "exited", code: 2 }, json: null, stdoutBytes: 0, stdoutTruncated: false,
        stderrTail: "recorded runner: no response for this call", durationMs: 0,
      };
    }
    if ("exit" in hit) {
      return {
        exit: hit.exit, json: hit.json ?? null, ...(hit.stdout === undefined ? {} : { stdout: hit.stdout }),
        stdoutBytes: 0, stdoutTruncated: false, stderrTail: hit.stderrTail ?? "", durationMs: 0,
      };
    }
    if ("stdout" in hit) {
      return {
        exit: { kind: "exited", code: hit.code ?? 0 }, json: null, stdout: hit.stdout,
        stdoutBytes: Buffer.byteLength(hit.stdout, "utf8"), stdoutTruncated: false, stderrTail: "", durationMs: 0,
      };
    }
    return {
      exit: { kind: "exited", code: hit.code ?? 0 }, json: hit.json, stdoutBytes: 0,
      stdoutTruncated: false, stderrTail: "", durationMs: 0,
    };
  };
}
