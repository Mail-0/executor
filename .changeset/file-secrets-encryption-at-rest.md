---
"@executor-js/plugin-file-secrets": patch
---

Encrypt the `file` credential provider at rest when `EXECUTOR_SECRETS_FILE_KEY` (or the `encryptionKey` option) is set: `auth.json` becomes a single AES-256-GCM envelope, so copies of the data directory never contain credential values. A plaintext file is rewritten encrypted on first use; a file the key cannot open is rebuilt from the durable mirror when one is configured and otherwise left untouched with the failure surfaced. The mirror bearer token can now be read from `EXECUTOR_SECRETS_MIRROR_TOKEN_FILE` on every request, so hosts can rotate a short-lived token without restarting the process. Without the new variables nothing changes.
