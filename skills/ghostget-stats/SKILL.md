---
name: ghostget-stats
description: "Collect exact social-profile statistics for a ghostget.collection-plan.v1 document through Ghostget, with contract checks first, sequential reads, Ghostget's one-retry policy as structure, categorical gaps, escalations by kind, and last-good memory. Zero model calls."
argument-hint: "run profile-stats --dir <store> --args <json with src.plan and src.scheduled-date>"
allowed-tools: ["exec"]
---

# ghostget-stats

```sh
bunx ghostget-skills run profile-stats --dir /path/to/store \
  --args '{"src":{"plan":'"$(cat plan.json)"',"scheduled-date":"2026-09-21","timezone":"America/New_York"}}'
```

Inputs: `plan` (a `ghostget.collection-plan.v1` document), `scheduled-date`
(the consumer's local date), optional `timezone` (default America/New_York)
and `auth-state` (true to also require stored auth locators).

What happens, in order: `ghostget contracts check` binds every read to the
installed catalog; reads that pass run one at a time in plan order, each
waiting its `requiredDelayBeforeMs`; a `retry-once-after-60s` disposition earns
exactly one retry after 60 s; every other failure is a categorical gap. Nothing
is estimated, rounded, cached, or scraped.

Outputs: `run` (`{schemaVersion:1, scheduledDate, timezone, observations}` —
exact counts only), `gaps` (per metric, with `stage` check|read and `expected`),
`escalations` (`repair-auth` | `rebind` | `recapture` | `doctor` |
`review-target` | `retry-later` | `review-plan` | `review-metric` |
`install-adapter`), `last-good` (memory), `summary`, and the full `check`.

Act on escalations, never on gaps alone: `repair-auth` needs a fresh signed-in
realm; `recapture` means the contract drifted and needs a new reviewed capture;
`doctor` means run `ghostget doctor` before any retry. Keep the receipt.
