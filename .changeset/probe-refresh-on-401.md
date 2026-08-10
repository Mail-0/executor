---
"executor": patch
---

Health probes now share the invoke path's reactive OAuth refresh: a probe that observes an upstream HTTP 401 re-mints the access token once and re-probes, so a connection whose token died early reports healthy instead of expired while tool calls keep succeeding.
