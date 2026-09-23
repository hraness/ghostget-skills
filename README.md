# Ghostget Skills

Common Ghostget workflows packaged as programs for Claude Code, Codex, and
Devin. They make no model calls, and every run leaves a receipt you can replay
offline.

Ghostget gives agents a fixed set of provider actions, but using them well
still takes a sequence of steps the agent has to reread each time: check the
catalog, confirm each read is observed and R1, wait sixty seconds before the
LinkedIn company read, retry once after sixty seconds only on a throttle, never
retry a repair-auth, and keep going with the independent rows. This package
writes those sequences down as [ALGAL](https://github.com/hraness/algal)
programs (ALGAL calls them organisms). Each program is a data file the ALGAL
runtime executes. Retries, delays, gaps, and escalations are part of the
program rather than instructions for the agent, the Ghostget CLI runs inside
capped tool calls, and every run produces a receipt that replays bit-for-bit
without contacting a provider.

[Programs](docs/programs.md) · [Interface with Ghostget](docs/seam.md) · [What recovery covers](docs/healing.md) · [Metrics](docs/METRICS.md)

## Install

Requires Bun 1.3+ on macOS or Linux and a Ghostget with the `contracts`
commands (0.18.24 or later; the package pins one).

```sh
bun add --global github:hraness/ghostget-skills
ghostget-skills doctor
ghostget-skills install-skills --target .agents/skills   # or .claude/skills, .devin/skills
```

`doctor` reports the pinned Ghostget version and whether its `contracts`
commands answer. Ghostget's own account setup (`ghostget auth add`, `auth
bind`, `adapter sync-bundled`) is unchanged and stays in Ghostget.

## Use

```sh
# What can this machine do? One line plus the R1 read list, not a 400 KB dump.
ghostget-skills run capability-survey --quiet --args '{"src":{"request":{}}}'

# Will this plan run? One verdict per read, no provider access.
ghostget-skills run plan-check --quiet --args '{"src":{"plan":'"$(cat plan.json)"'}}'

# Collect it. Sequential, checked, retry policy as structure, last-good memory.
ghostget-skills run profile-stats --dir ~/.ghostget-skills \
  --args '{"src":{"plan":'"$(cat plan.json)"',"scheduled-date":"2026-09-21"}}' > run.json

# Prove it later, offline.
ghostget-skills verify run.json
```

`run` prints `{program, outcome, outputs, receipt}`. `plan.json` is a
[`ghostget.collection-plan.v1`](docs/seam.md#a3-ghostgetcollection-planv1)
document; Ghostget ships one for the Hraness accounts and validates any other
with `ghostget contracts check`.

## Programs

| program | what you get | model calls |
| --- | --- | --- |
| `capability-survey` | per-adapter observed / capture-required operations and every runnable R1 read with its authority and input keys | 0 |
| `plan-check` | one verdict per plan read: the exact binding, or one closed gap reason | 0 |
| `profile-stats` | exact counts per account in plan order, categorical gaps, escalations by kind, last-good memory, and the full check | 0 |
| `page-read` | one URL as clipped Markdown with provenance | 0 |
| `auth-health` | doctor and auth locators as a readiness report, without subjects or paths | 0 |
| `drift-watch` | contract hashes and states diffed against the remembered baseline | 0 |

The two inner organisms `profile-stat-read` and `profile-stat-attempt` are
what `profile-stats` embeds by digest; see [docs/programs.md](docs/programs.md).

## How it connects to Ghostget

```
consumer ──run──▶ ghostget-skills (organisms + fns + ToolRegistry)
                       │ fixed argv · --json · stdin · byte caps · 120 s + 45 s grace
                       ▼
                  ghostget CLI  (contracts catalog | contracts check | invoke | read | doctor | auth list)
                       │
                  adapters · auth realms · state home   (private to Ghostget)
```

Ghostget owns acquisition, account binding, invocation authority, and a set
of machine-checkable contract commands: `ghostget contracts catalog` (the
installed catalog as a typed `ghostget.contract-catalog.v1` document),
`ghostget contracts check --plan` (a verdict per read against that catalog),
`ghostget contracts schema` (JSON Schema for every document), and the pure
`@hraness/ghostget/contracts` SDK subpath. Ghostget never bundles a planner or
an agent runtime. This package owns the organisms, the tool registry that
wraps the CLI, the skills, and the evidence. Credentials never pass through this package:
auth IDs are locators, receipts carry contract identity only, and the recorded
runner used for tests and benches never sees a real one.

## Measured results

`bun bench/run-bench.ts` compares the raw Ghostget documents an agent would
read by hand against the outputs a consumer reads, on deterministic fixtures:

| workflow | baseline bytes | program bytes | reduction |
| --- | ---: | ---: | ---: |
| capability-survey | 4,144 | 1,135 | 72.6% |
| plan-check | 4,478 | 607 | 86.4% |
| profile-stats (15 reads) | 39,389 | 2,137 | 94.6% |
| profile-stats with a retry | 35,637 | 3,788 | 89.4% |
| page-read (example.com) | 345 | 234 | 32.2% |
| auth-health | 1,833 | 555 | 69.7% |
| drift-watch | 8,296 | 4,177 | 49.7% |
| **total** | **94,122** | **12,633** | **86.6%** |

These are byte figures over synthetic fixtures with `est_tokens =
ceil(bytes/4)`, not provider usage or task-success claims.

One live measurement, taken on 2026-09-21 against a real installed catalog of
23 adapters through a development Ghostget build carrying the contracts
surface:

| surface | bytes |
| --- | ---: |
| `ghostget contracts catalog --json` | 437,812 |
| `capability-survey` consumer outputs | 22,245 |

That is a 94.9% reduction on the same catalog, and the program reports the
same facts: 23 adapters, 157 observed operations, 95 of them R1 reads, and 188
capture-required. The pre-contracts surface an agent would otherwise read,
`ghostget capabilities --json`, measured 647,839 bytes on the same machine
against its own installed state. Live figures move with the installed catalog;
only the fixture rows above are reproducible offline.
[Methodology and caveats](docs/METRICS.md).

The whole collection path was exercised against real providers on the same
day. A two-account public plan passed `contracts check`, ran its reads
sequentially with the plan's delay, and returned exact counts that matched the
providers, with no gaps and no escalations across five recorded effects and
zero model calls. Its receipt then replayed bit-for-bit through
`ghostget-skills verify` with no Ghostget executable available at all, which
is what "capture once, replay offline" means here.

## What recovery covers

Implemented: contract checks before any read is spent, Ghostget's one-retry
disposition as a `repeat` cell, per-row isolation through `each` and `on:fail`
edges, escalations from a closed set (`repair-auth`, `rebind`, `recapture`,
`doctor`, `review-target`, `retry-later`, `review-plan`, `review-metric`,
`install-adapter`), durable last-good and baseline memory, and receipts that
fail verification when tampered with.

Not claimed: repairing a drifted provider contract. That is a new authorised
capture and a reviewed Ghostget release. This package detects the change as
soon as it is installed and names what a person needs to do. [Details](docs/healing.md).

## Development

```sh
bun install --frozen-lockfile
bun run check            # typecheck, tests, admission, digests, recorded smoke + replay, bench currency, skills, privacy, pack scope
bun bench/run-bench.ts   # regenerate bench/report after touching programs, src, tools, fixtures, or bench
bun scripts/pin-digests.ts
```

Tests and the check gate run against recorded Ghostget responses; nothing here
needs a provider, a browser, or an account. `GHOSTGET_BIN` may point at an
absolute development build of Ghostget; a relative path is refused.

## License

MIT.
