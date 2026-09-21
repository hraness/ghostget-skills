---
name: ghostget-capabilities
description: "Survey what Ghostget can do on this machine without reading the full capabilities dump. Per-adapter observed and capture-required operations plus the R1 read list with authority and input keys. Zero model calls."
argument-hint: "run capability-survey --quiet --args <json with src.request>"
allowed-tools: ["exec"]
---

# ghostget-capabilities

```sh
bunx ghostget-skills run capability-survey --quiet --args '{"src":{"request":{}}}'
```

Pass `"request":{"adapters":["x-web","github-web"]}` to scope the survey.

`summary` is one line (`23 adapters, 61 observed operations (17 R1 reads),
38 capture-required`); `survey.reads` lists every runnable read with
`authority` (`public` needs no `--auth`, `auth` needs a locator) and its input
keys. Use it to write a collection plan, then run `ghostget-plan-check`.
