# Metrics methodology

What `bench/run-bench.ts` measures, how to reproduce it, and what the numbers
do not claim.

## Design

For each workflow the bench measures what would enter an agent's context:

- `baseline_context_bytes` — the raw bytes of the Ghostget JSON or text an
  agent would read doing the job by hand. These are the recorded fixture
  documents themselves (catalog, contract check, one invoke envelope per read,
  doctor, auth list, page text), plus the skill reference an agent must re-read
  to plan a sequence where one applies (the social-profile-stats reference
  from the pinned Ghostget package).
- `program_context_bytes` — the bytes of the interface outputs a consumer
  reads. Audit-only ports (the echoed check document, the memory slot) are
  excluded and listed under `consumer_outputs`.
- `agent_calls`, `steps`, `work_units`, `effects` — from the run receipt.
- `est_*_tokens = ceil(bytes / 4)` — a labelled estimate, not provider usage.

Everything is deterministic: fixtures are synthetic, runs use the recorded
runner, and the report carries a `source_fingerprint` over `programs/`,
`src/`, `tools/`, `fixtures/`, and `bench/`. `bun run check` fails when the
report is stale.

## Caveats

- Fixtures are small. The real installed catalog measured 423,883 bytes from
  `ghostget capabilities --json` and the real doctor document 245,286 bytes on
  one developer Mac on 2026-09-21; the fixture versions are a few kilobytes.
  Live reductions for `capability-survey`, `drift-watch`, and `auth-health`
  are therefore larger than the fixture figures.
- Baselines count evidence bytes only, not the agent's reasoning, retries,
  or the prose it re-reads more than once.
- `page-read` only wins above its byte cap; on tiny pages it can cost more.
- A byte reduction is not a task-success, latency, or billing claim. There is
  no whole-task provider-native token measurement yet.

## Reproduce

```sh
bun bench/run-bench.ts
bun run check
```
