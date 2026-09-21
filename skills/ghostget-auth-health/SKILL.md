---
name: ghostget-auth-health
description: "Reduce ghostget doctor and the auth locator list to a readiness report: transport readiness, locator counts by kind, unsettled runs, and pending recovery counters, with no subjects, fingerprints, or paths. Zero model calls."
argument-hint: "run auth-health --quiet"
allowed-tools: ["exec"]
---

# ghostget-auth-health

```sh
bunx ghostget-skills run auth-health --quiet
```

`summary`: `doctor ok; 63 auth locators; web-session true, provider-api false,
local-cli true; unsettled runs 54; pending recovery: …`. `health.locatorIds`
names locators so a plan's `authority.authId` values can be confirmed. Doctor
can take minutes; the program allows it.
