---
"@executor-js/plugin-mcp": patch
---

Treat a 200 `text/event-stream` handshake whose JSON-RPC envelope carries an authorization error as an MCP endpoint that requires auth. Servers that answer `initialize` this way were classified as unauthenticated MCP, so a rejected credential surfaced as an unexplained tool-discovery failure instead of an auth prompt.
