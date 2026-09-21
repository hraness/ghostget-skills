---
name: ghostget-drift-watch
description: "Detect Ghostget contract drift after an upgrade by diffing the installed catalog (contract hashes, versions, states) against the baseline remembered in a durable slot. First run records the baseline. Zero model calls."
argument-hint: "run drift-watch --dir <store> --quiet --args <json with src.request>"
allowed-tools: ["exec"]
---

# ghostget-drift-watch

```sh
bunx ghostget-skills run drift-watch --dir /path/to/store --quiet --args '{"src":{"request":{}}}'
```

Use one persistent `--dir` so the baseline survives. `summary` reads `7
changed, 0 added, 1 removed of 61 operations`; `drift.changed[]` names the
operation and the fields that moved (`state`, `contractHash`, `contractVersion`,
`adapterVersion`). A `state` change to `capture-required` means every plan
naming that operation will now gap at check time.
