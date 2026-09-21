---
name: ghostget-plan-check
description: "Check a ghostget.collection-plan.v1 document against the installed Ghostget contract catalog before spending any provider read. Returns one verdict per read with its binding or a closed gap reason. Zero model calls, no provider access."
argument-hint: "run plan-check --quiet --args <json with src.plan>"
allowed-tools: ["exec"]
---

# ghostget-plan-check

```sh
bunx ghostget-skills run plan-check --quiet --args '{"src":{"plan":'"$(cat plan.json)"'}}'
```

Add `"auth-state": true` to also require that every `authority.authId` is a
stored locator on this machine.

Output `text` reads like `13/15 reads ok; gaps: linkedin-personal linkedin-web
profiles.read (state-mismatch); …`. Gap reasons are closed: `adapter-missing`,
`adapter-invalid`, `operation-missing`, `state-mismatch`, `risk-mismatch`,
`side-effect-mismatch`, `authority-mismatch`, `input-invalid`, `auth-missing`,
`transport-disabled`. A `state-mismatch` means Ghostget parked the operation
`capture-required`; a new reviewed derivation is the only fix.
