# Metrics methodology

What `bench/run-bench.ts` measures, how to reproduce it, and what the numbers
do not claim.

## Design

For each workflow the bench measures what would enter an agent's context:

- `baseline_context_bytes`: the raw bytes of the GhostGet JSON or text an
  agent would read doing the job by hand. These are the recorded fixture
  documents themselves (catalog, contract check, one invoke envelope per read,
  doctor, auth list, page text), plus the skill reference an agent must re-read
  to plan a sequence where one applies (the social-profile-stats reference
  from the pinned GhostGet package).
- `program_context_bytes`: the bytes of the interface outputs a consumer
  reads. Audit-only ports (the echoed check document, the memory slot) are
  excluded and listed under `consumer_outputs`.
- `agent_calls`, `steps`, `work_units`, `effects`: from the run receipt.
- `est_*_tokens = ceil(bytes / 4)`: an estimate, not provider usage.

Everything is deterministic: fixtures are synthetic, runs use the recorded
runner, and the report carries a `source_fingerprint` over `programs/`,
`src/`, `tools/`, `fixtures/`, and `bench/`. `bun run check` fails when the
report is stale.

## Caveats

- Fixtures are small; live documents are not. On 2026-09-21, against a real
  installed catalog of 23 adapters, `ghostget contracts catalog --json`
  measured 437,812 bytes and `capability-survey` reduced it to 22,245 bytes of
  consumer output, a 94.9% reduction. The pre-contracts `ghostget capabilities
  --json` surface measured 647,839 bytes and the doctor document 245,286 bytes
  on the same machine. The measured live reduction for `capability-survey`
  was larger than its fixture reduction. Those raw document sizes do not
  establish live reductions for `drift-watch` or `auth-health`. A live
  measurement depends on the installed catalog and is not reproducible
  offline, so it is reported separately and never folded into the totals.
- Baselines count evidence bytes only, not the agent's reasoning, retries,
  or the prose it re-reads more than once.
- `page-read` adds metadata and clips long page bodies. Whether it reduces
  bytes depends on the page length and output shape.
- A byte reduction is not a task-success, latency, or billing claim. There is
  no whole-task provider-native token measurement yet.

## Reproduce

```sh
bun bench/run-bench.ts
bun run check
```
