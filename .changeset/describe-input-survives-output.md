---
"@executor-js/sdk": patch
---

Compile a tool's input and output TypeScript previews independently when the combined compile fails. A tool whose output schema could not be rendered (for example, one with an unresolved `$ref`) previously reported `inputTypeScript: "unknown"` as well, so `tools.describe.tool` hid a well-formed input shape.
