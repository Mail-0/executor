---
"executor": patch
---

Refresh OAuth tokens when the upstream rejects them with HTTP 401, not only when the stored expiry says they are due. Connections whose authorization server omits `expires_in` can now recover without a manual reconnect, and the refresh path is traced.
