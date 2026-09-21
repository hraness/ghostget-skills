# Healing: what this package does and does not claim

Two different things get called self-healing. This package implements the
first and is explicit that the second is not present.

## Operational healing (implemented)

Failures are data the graph routes, not exceptions an agent re-plans around:

- **Check before spend.** `profile-stats` runs `ghostget contracts check`
  first. A read whose contract drifted, whose operation is parked
  `capture-required`, or whose auth locator is missing never reaches a
  provider; it is a gap with a `recapture`, `review-plan`, `install-adapter`,
  or `repair-auth` escalation.
- **Retry as structure.** Ghostget's one-retry disposition is a `repeat` cell
  with `maxRounds: 2` and an `until` on the attempt record. No prose rule, no
  agent judgment, no accidental second retry.
- **Isolation per row.** Every read is its own inner organism inside an
  `each`; a tool throw is caught by an `on:"fail"` edge. One row's failure
  cannot fail the run.
- **Escalation by kind.** Every gap carries one of a closed set of escalation
  kinds so an operator (or a scheduled agent) knows what to do: sign in again,
  rebind a realm, capture a new contract, run doctor, review the target or the
  plan, or simply try later.
- **Memory.** `profile-stats` remembers the last good observation per account
  in a durable slot; `drift-watch` remembers the last catalog baseline. Both are
  reported, never coerced into today's sample.
- **Evidence.** Every run is a receipt that `verify` replays offline without
  Ghostget. A tampered effect fails verification.

## Contract healing (not claimed)

When a provider changes its API, Ghostget parks the operation
`capture-required`. Restoring it requires a new authorised derivation, a
reviewed code-owned contract in Ghostget, tests, and a release. Neither ALGAL's
foundry search (feedback is pass counts, not failing receipts) nor its
civilisation loop (candidates may contain only `input`, `const`, and pure `fn`
cells) can evolve a tool-bearing organism, and even if they could, a contract
is Ghostget source code, not manifest data.

What this package gives that loop instead is the *signal*: `drift-watch`
detects the change the moment it is installed, `plan-check` names every plan
affected, and `profile-stats` keeps collecting the independent rows while the
escalation says exactly which contract needs a human capture.

## Token efficiency (measured on fixtures)

`bench/report/bench-report.json` compares the raw Ghostget documents an agent
would read by hand with the outputs a consumer actually reads. On the recorded
fixtures the total reduction is the figure in the README's measured-results
section; it is a byte figure over synthetic fixtures, labelled as such. Live
catalog and doctor documents are much larger than the fixtures, so live
reductions for `capability-survey` and `auth-health` are larger than reported.
