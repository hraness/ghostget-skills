# The Ghostget ⇄ ALGAL seam (interface v1)

This is the frozen interface both repositories build against. Ghostget
implements section A; this package implements section B; section C names the
first consumer.

Owner split. Ghostget owns provider acquisition, account binding, invocation
authority, and a **machine-checkable contract surface**. It never bundles a
planner, model, or agent runtime (ghostget `AGENTS.md` rule 30). A separate
package, `ghostget-skills`, owns ALGAL organisms, the tool registry that
wraps the Ghostget CLI, agent skills, benchmarks, and consumer-facing
programs. Consumers (jungle, peopleblade, textbutler, …) run
`ghostget-skills run <program>` and consume the typed receipt.

```
consumer  ──run──▶  ghostget-skills (algal organisms + ToolRegistry)
                       │ fixed argv, --json, stdin input, byte caps
                       ▼
                    ghostget CLI  (contracts | invoke | read | doctor | auth)
                       │
                    provider adapters, auth realms, state home (private)
```

## A. Ghostget side: `ghostget contracts` + `@hraness/ghostget/contracts`

### A1. `ghostget contracts catalog [--adapter <id>]... --json`

Emits `ghostget.contract-catalog.v1`: a compact, stable projection of the
installed capability catalog. Unlike `capabilities --json` (~424 KB, ad hoc
`unknown[]`), this is typed, documented, schema-backed, and ~10× smaller.

```jsonc
{
  "ok": true,
  "contract": "ghostget.contract-catalog.v1",
  "ghostget": { "version": "0.18.22" },
  "generatedAt": "2026-09-21T20:00:00.000Z",
  "vocabulary": {
    "risks": ["R1", "R2", "R3", "R4"],
    "states": ["observed", "capture-required"],
    "transports": ["web-session-api", "provider-api", "local-cli", "reviewed-template-api"],
    "authorities": ["public", "auth"],
    "readFailure": {
      "target-unavailable": "do-not-retry",
      "auth-repair-required": "repair-auth",
      "account-mismatch": "do-not-retry",
      "contract-drift": "do-not-retry",
      "cleanup-required": "do-not-retry",
      "provider-throttled": "retry-once-after-60s",
      "provider-temporary": "retry-once-after-60s",
      "operation-timeout": "retry-once-after-60s"
    },
    "invokeStatuses": ["succeeded", "failed", "…exact list from source…"]
  },
  "adapters": [
    {
      "id": "x-web", "version": "1.14.0", "surfaceId": "x",
      "manifestHash": "<sha256 hex>", "origins": ["https://x.com"],
      "operations": [
        {
          "id": "profiles.read",
          "transport": "web-session-api",
          "authority": "auth",              // "public" when the operation runs without --auth
          "risk": "R1", "sideEffect": "none", "idempotency": "none", "dedupeWindowMs": 0,
          "state": "observed",
          "contractVersion": 3, "contractHash": "<sha256 hex>",
          "input": { "properties": { "handle": { "type": "string", "description": "…", "minLength": 1, "maxLength": 15 } }, "required": ["handle"] }
        }
      ]
    }
  ]
}
```

Rules: exact keys, no free-form prose beyond `description` fields already in
manifests, no local paths, no auth IDs, no subjects. `contractHash` is the
existing durable contract hash (webSession / provider / localCli / reviewed
template — one field regardless of transport; the transport says which).
Invalid installed manifests appear as `{ "id", "invalid": true, "issues": [...] }`.
Exit 0 when `ok`, 3 when an `--adapter` filter matches nothing.

### A2. `ghostget contracts check --plan <file> [--auth-state] --json`

Input: a `ghostget.collection-plan.v1` document (below). Output:
`ghostget.contract-check.v1`.

```jsonc
{
  "ok": false,                                  // true only when every read is "ok"
  "contract": "ghostget.contract-check.v1",
  "ghostget": { "version": "0.18.22" },
  "plan": { "collectionKey": "hraness-social-profile-statistics", "reads": 15 },
  "reads": [
    { "index": 0, "accountKey": "x-hraness", "adapter": "x-web", "operation": "profiles.read",
      "verdict": "ok",
      "binding": { "adapterVersion": "1.14.0", "contractVersion": 3, "contractHash": "…", "transport": "web-session-api", "authority": "auth" } },
    { "index": 2, "accountKey": "linkedin-personal", "adapter": "linkedin-web", "operation": "profiles.read",
      "verdict": "gap",
      "gap": { "reason": "state-capture-required", "detail": "installed state is capture-required; plan requires observed" } }
  ]
}
```

Gap reasons (closed set): `adapter-missing`, `adapter-invalid`,
`operation-missing`, `state-mismatch`, `risk-mismatch`, `side-effect-mismatch`,
`authority-mismatch`, `input-invalid`, `auth-missing` (only with
`--auth-state`; the auth ID is not a stored locator), `transport-disabled`.
`input-invalid` uses the existing `validateOperationInput` against the
operation's schema and adapter origins; `detail` carries the issue list.
Never reads a provider, never binds an account, never prints subjects.
Exit 0 when `ok`, 4 when any gap (still prints the full document).

### A3. `ghostget.collection-plan.v1`

Generalisation of `skills/ghostget/references/hraness-social-profile-stats.json`
(that file is a valid instance and stays unchanged). Shape:

```jsonc
{
  "schemaVersion": 1,
  "collectionKey": "<free-form, 1..128 chars, [a-z0-9-]>",
  "execution": { "order": "sequential", "observationMode": "live-only" },
  "accounts": [
    { "accountKey": "<unique>",
      "reads": [
        { "adapter": "x-web", "operation": "profiles.read",
          "authority": { "kind": "auth", "authId": "x-chrome" } | { "kind": "public" },
          "input": { … operation input … },
          "expectedOutput": { "provider": "x", "targetUrl": "https://x.com/hraness" },
          "metricKeys": ["followers", "following"],
          "expectedCategoricalGaps": [ { "metricKey": "recentViews", "reason": "not-authorized", "until": "account-eligible" } ],
          "requiredDelayBeforeMs": 0,
          "semantics": { "state": "observed", "risk": "R1", "sideEffect": "none" } } ] } ]
}
```

Bounds: ≤ 64 accounts, ≤ 8 reads per account, ≤ 128 reads total, delay ≤
600 000 ms, metricKeys ≤ 16 unique. `semantics.risk` must be `R1` and
`sideEffect` `none` in v1 (collection plans are read-only by construction).

### A4. `ghostget contracts schema <catalog|check|plan|invoke-read> --json`

Prints the JSON Schema (draft 2020-12) for the named document. Schemas are
generated from the TypeScript parsers' shape tables so they cannot drift
(tests assert every example document validates and every parser rejection
corresponds to a schema violation or a documented semantic rule).

`invoke-read` is the **R1 invoke result envelope** already emitted by
`ghostget invoke … --json` (schema documents what exists; nothing changes):
top-level `ok, status, runId, replayed, receipt{…schemaVersion 4…}, output,
source, cache`, and on failure `readFailure{category, retryDisposition}`.

### A5. SDK subpath `@hraness/ghostget/contracts` (pure, side-effect free)

```ts
export type ContractCatalogV1, ContractCheckV1, CollectionPlanV1, InvokeReadResultV1, ReadFailureCategory, RetryDisposition;
export const readFailureDispositions: Readonly<Record<ReadFailureCategory, RetryDisposition>>;
export function parseContractCatalog(value: unknown): ContractCatalogV1;      // throws on drift
export function parseCollectionPlan(value: unknown): CollectionPlanV1;
export function parseContractCheck(value: unknown): ContractCheckV1;
export function parseInvokeReadResult(value: unknown): InvokeReadResultV1;    // strict R1 envelope; output stays `unknown`-typed but bounded
export function checkCollectionPlan(plan: CollectionPlanV1, catalog: ContractCatalogV1, options?: { storedAuthIds?: readonly string[] }): ContractCheckV1;
export function contractSchema(name: "catalog" | "check" | "plan" | "invoke-read"): JsonSchema;
```

No imports from storage, auth, providers, or the registry. `checkCollectionPlan`
is the same function the CLI uses (CLI = catalog projection + this).

### A6. Docs, skill, release hygiene

- `docs/contracts.md`: the four documents, exit codes, and the consumer loop
  (`catalog` → `check` → `invoke` → parse result → act on `retryDisposition`).
- `skills/ghostget/references/social-profile-stats.md`: replace the prose
  preflight paragraph with `ghostget contracts check --plan … --json` and keep
  the rest.
- README: one short "Machine-checkable contracts" subsection under SDK.
- CHANGELOG + version bump to 0.18.22; `dist/` rebuilt and committed;
  package `exports["./contracts"]`; `build` entry list extended.
- Tests: deterministic examples + fast-check properties (catalog/plan/check
  parse round-trips reject extra keys; check is deterministic and idempotent;
  every failure category has a disposition; schema ⇔ parser agreement).

## B. ghostget-skills side (new repo `hraness/ghostget-skills`)

Package `ghostget-skills` (MIT, Bun ≥ 1.3, `bin/ghostget-skills`). Pins
`@hraness/ghostget` to an immutable commit/release and `@hraness/algal` to a
full commit. Model: `algal-skills` layout + `system-one-skills` evidence
discipline.

### B1. Tool registry (`tools/ghostget.tools.json` ⇄ `tools/tool.ts`)

Every tool is fixed argv over the pinned `node_modules/.bin/ghostget`
(override only via absolute `GHOSTGET_BIN`), `--json`, stdin for input, stdout
byte-capped, deadline 120 s + 45 s TERM grace (never KILL during cleanup),
one `report` output port. Credentials never cross a port: auth IDs are
locators, subjects are stripped, receipts are summarised.

| tool | effect | inputs | report |
|---|---|---|---|
| `ghostget.contracts.catalog.v1` | read | `adapters?: json[]` | catalog (compact; adapters filtered) |
| `ghostget.contracts.check.v1` | read | `plan: json`, `auth-state?: json(bool)` | check document |
| `ghostget.invoke.read.v1` | read | `adapter: text`, `operation: text`, `input: json`, `auth-id?: text` | `{ok, status, readFailure?, output?, receipt:{adapter,version,hash,contractHash,transport,finalOrigin,runId}}` |
| `ghostget.page.read.v1` | read | `url: text`, `max-bytes?: json` | `{ok, status, canonicalUrl, wordCount, markdown(clipped), truncated}` |
| `ghostget.doctor.v1` | read | — | bounded readiness summary (no paths) |
| `ghostget.auth.list.v1` | read | — | `[{id, kind, provider}]` (no subjects/fingerprints) |
| `time.wait.v1` | read | `ms: json` (≤ 120 000) | `{waitedMs}` — recorded effect so replay is exact |

### B2. Programs (`programs/*.algal.json`, zero model calls unless noted)

- `capability-survey` — catalog → expr: per-adapter observed/capture-required
  counts + the R1 read list. Replaces reading 424 KB.
- `plan-check` — plan → check → expr verdict summary.
- `profile-stat-read` (inner) — one read: `wait(delay)` → `invoke.read` →
  expr disposition → guarded `wait(60s)` → `invoke.read` (retry) → expr
  normalise: exact metrics only, categorical gaps, escalation kind
  (`repair-auth` | `recapture` | `doctor` | `none`).
- `profile-stats` — plan → `check` (fail-closed on gaps unless `allow-gaps`)
  → expr flatten rows (order preserved) → `each` (sequential) →
  expr aggregate → slot `profile-stats:last-good` (read+write) → outputs
  `run` (jungle-compatible `SocialStatObservationRun`), `gaps`, `escalations`,
  `lastGood`.
- `page-read` — `page.read` → expr clip/format.
- `auth-health` — doctor + auth list → expr readiness per realm.
- `drift-watch` — catalog → slot `contracts:baseline` → expr diff of
  contractHash/state per operation → outputs `drifted[]`, writes new baseline.

### B3. Package surface

`bin/ghostget-skills`: `list | run <program> --args <json|@file> [--dir] [--write] | tools | verify <receipt> [manifest] | doctor | install-skills [--target]`.
`skills/`: `ghostget-skills` (router), `ghostget-stats`, `ghostget-plan-check`,
`ghostget-capabilities`, `ghostget-read`, `ghostget-auth-health`,
`ghostget-drift-watch`. Each SKILL.md is ≤ 25 lines: command, inputs, what the
receipt proves, what it does not.
`scripts/check.ts` gates: typecheck, tests, manifests admit (`algal check`),
scripted-fixture smoke run of every program + `verify` replay, bench report
current, privacy scan, npm pack scope. CI: `.github/workflows/check.yml`.
`bench/`: baseline bytes (raw `capabilities --json`, raw invoke envelopes ×15,
raw doctor) vs program interface output bytes; labelled estimates only.
`docs/seam.md` (this document, adapted), `docs/programs.md`, `docs/healing.md`
(what is operational healing vs. evolution; evolution explicitly not claimed).

## C. Jungle consumer

`projects/hraness/scripts/refresh-social-stats.ts` shrinks to: resolve pinned
`ghostget-skills`, run `profile-stats` with the pinned plan path, parse the
receipt's `run` output with the existing `parseSocialStatObservationRun`,
install. `social-stat-manifest.ts` keeps only the account-key order check;
contract validation moves to `ghostget contracts check` inside the program.
Skill `publish-hraness-social-stats` updated accordingly.
