# Programs

Every program is an `algal.organism.v1` manifest under `programs/`. All declare
`maxAgentCalls: 0`: no model is called, ever. Nondeterminism enters only
through tool effects, which the receipt records and `verify` replays verbatim.

| program | tools | fns | memory | outputs |
| --- | --- | --- | --- | --- |
| `capability-survey` | `ghostget.contracts.catalog.v1` | `ghostget.catalog.survey.v1` | — | `survey`, `summary` |
| `plan-check` | `ghostget.contracts.check.v1` | `ghostget.check.summary.v1` | — | `check`, `summary`, `text` |
| `profile-stats` | `ghostget.contracts.check.v1`, `time.wait.v1`, `ghostget.invoke.read.v1` | `ghostget.plan.rows.v1`, `ghostget.profile-stat.attempt.v1`, `ghostget.profile-stat.normalize.v1`, `ghostget.profile-stats.aggregate.v1`, `coalesce.v1` | slot `profile-stats-last-good` | `run`, `gaps`, `escalations`, `last-good`, `summary`, `check` |
| `page-read` | `ghostget.page.read.v1` | — | — | `report`, `text` |
| `auth-health` | `ghostget.doctor.v1`, `ghostget.auth.list.v1` | `ghostget.auth.health.v1` | — | `health`, `summary` |
| `drift-watch` | `ghostget.contracts.catalog.v1` | `ghostget.catalog.drift.v1` | slot `contracts-baseline` | `drift`, `summary`, `baseline` |

## profile-stats, cell by cell

```
src ─plan──▶ check (tool: contracts.check) ─report──▶ rows (fn: plan.rows) ─rows──▶ collect (each: profile-stat-read)
   └plan──────────────────────────────────────────────┴gaps──▶ aggregate (fn) ◀─results─┘
memory (slot read: last-good) ─data──▶ aggregate ─last-good──▶ remember (slot write)
src ─timezone (optional)──▶ timezone (coalesce with const America/New_York) ──▶ aggregate
```

`profile-stat-read` (one per plan row, sequential):

```
src ─read──▶ delay (expr: requiredDelayBeforeMs) ─▶ attempts (repeat ×2, until attempt.next == "stop")
                                                        │ carry next-delay → delay-ms (60 000), next-attempt-no → attempt-no
                                                        ▼
                                                   normalize (fn) ─result──▶ (interface)
```

`profile-stat-attempt` (one round):

```
src ─delay-ms──▶ wait (tool: time.wait) ─report──▶ after-wait (expr) ─out──▶ invoke (tool: invoke.read)
                                                                                  │ report ─▶ decide (fn: attempt)
                                                                                  └ on:fail ─▶ decide-failed (fn: attempt)
                                                                                                      └─▶ settle (coalesce) ─▶ attempt
```

The retry policy is exactly Ghostget's documented one: at most one retry, after
60 seconds, only for `retry-once-after-60s`. Everything else stops on the first
attempt. A tool that throws (a deadline past the 180 s effect budget, a spawn
failure) is caught by the `on:"fail"` edge and becomes a `tool-failed` gap with
a `doctor` escalation, so one bad row never fails the collection.

## Interface conventions

- Args are keyed by cell: `{"src": {...}}`. Optional input ports may be omitted.
- Every tool returns one `report` port; `ok` and `status` are always present.
- Outputs that exist for audit (the full `check` document, the memory echo)
  are separate ports so a consumer can ignore them.
- `ghostget-skills run` prints `{program, outcome, outputs, receipt}`; the
  receipt alone (`--receipt`) is what `verify` consumes.

## Adding a program

1. Write the manifest with `maxAgentCalls: 0` and a declared `interface`.
2. Put record-shaping logic in `src/fns.ts` (pure, total) and effects in
   `tools/tool.ts` with a matching signature in `tools/ghostget.tools.json`.
3. Add recorded responses to `fixtures/recorded.ts`, a smoke case to
   `scripts/smoke.ts`, a bench workflow, a test, and a skill.
4. If it embeds another program, reference `sha256:PIN:<id>` and run
   `bun scripts/pin-digests.ts`.
5. `bun run check` must pass.
