---
"@executor-js/plugin-file-secrets": patch
---

Add an optional durable HTTP mirror to the `file` credential provider. When `EXECUTOR_SECRETS_MIRROR_URL` and `EXECUTOR_SECRETS_MIRROR_TOKEN` are set, every set and delete is written through to the mirror the moment it happens, and the provider loads the mirror's values on first use so an `auth.json` restored from an older backup cannot bring back a refresh token the authorization server already rotated. Writes the mirror does not acknowledge are kept and retried; without the variables the provider behaves exactly as before.
