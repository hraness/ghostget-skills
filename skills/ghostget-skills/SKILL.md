---
name: ghostget-skills
description: "Run ghostget-skills programs instead of driving Ghostget by hand. Typed, zero-model-call ALGAL organisms over Ghostget's machine-checkable contracts for provider reads, plan checks, capability surveys, page reads, auth health, and contract-drift detection, each with a replayable receipt."
argument-hint: "list | run <program> --args <json or @file> | verify <receipt> | doctor"
allowed-tools: ["exec"]
---

# ghostget-skills

Prefer `ghostget-skills run <program>` over sequencing `ghostget` commands
yourself. Each program is a data manifest run by the ALGAL runtime: the CLI
calls happen inside bounded tool effects, the retry and delay rules live in the
graph, and you receive only the compact typed outputs plus a receipt that
`verify` replays offline.

## Commands

- `bunx ghostget-skills list`: programs with their inputs and outputs
- `bunx ghostget-skills run <program> --args '{"src":{...}}' [--dir .algal]`: run one program; prints `{program, outcome, outputs, receipt}`
- `bunx ghostget-skills run <program> --args @args.json --quiet`: outputs only
- `bunx ghostget-skills verify <receipt.json>`: replay a run bit-for-bit without Ghostget
- `bunx ghostget-skills doctor`: pinned Ghostget version and whether its `contracts` commands exist

## Programs

- `capability-survey`: what is installed and observed, as counts plus the R1 read list
- `plan-check`: verdict per read of a `ghostget.collection-plan.v1` document, no provider access
- `profile-stats`: the checked plan collected sequentially with Ghostget's retry policy as structure
- `page-read`: one URL as clipped Markdown with provenance
- `auth-health`: doctor and auth locators reduced to a readiness report
- `drift-watch`: contract hashes and states diffed against the remembered baseline

## Rules

- Args are keyed by the `src` input cell. Auth IDs are Ghostget locators, never credentials.
- Programs never mutate a provider: every tool is a read, and R2/R3 operations are refused.
- Pass `--dir` to a persistent store when a program uses memory (`profile-stats`, `drift-watch`).
- A receipt is execution evidence, not provider attestation. Keep it for `verify` and for escalation review.
- If Ghostget reports `contracts` as unavailable, upgrade the pinned Ghostget; do not fall back to raw CLI parsing.
