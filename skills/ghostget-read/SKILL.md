---
name: ghostget-read
description: "Read one URL as clipped Markdown through Ghostget's capture runtime, with provenance (title, canonical URL, source bytes, truncation). Zero model calls."
argument-hint: "run page-read --quiet --args <json with src.url and optional src.max-bytes>"
allowed-tools: ["exec"]
---

# ghostget-read

```sh
bunx ghostget-skills run page-read --quiet --args '{"src":{"url":"https://example.com","max-bytes":16000}}'
```

`text` starts with `[<title> · <canonical url> · <bytes>B, clipped]` then the
Markdown. `max-bytes` is 512–131072 (default 16000). Ghostget decides the
acquisition route; this program never passes cookies, selectors, or scripts.
Small pages can cost slightly more than reading them directly; use it for pages
you expect to exceed the cap.
