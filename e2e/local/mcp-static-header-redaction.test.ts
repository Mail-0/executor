import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { composePluginApi } from "@executor-js/api/server";
import { createEmulator, type Emulator } from "@executor-js/emulate";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { IntegrationSlug } from "@executor-js/sdk/shared";

import { withChatTheater } from "../src/clients/chat-theater";
import { scenario } from "../src/scenario";
import { Cli, RunDir } from "../src/services";
import { withLocalServer } from "./local-server";

const api = composePluginApi([mcpHttpPlugin()] as const);
const uniqueId = randomBytes(8).toString("hex");
const slug = `mcp-redaction-${uniqueId}`;
const secretHeaderValue = `Bearer e2e-static-header-${uniqueId}`;
const code = `return await tools.executor.mcp.getServer({slug:${JSON.stringify(slug)}});`;

const availablePort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close(() => {
      resume(Effect.succeed(port));
    });
  });
});

const mcpEmulator = Effect.acquireRelease(
  Effect.gen(function* () {
    const port = yield* availablePort;
    const token = secretHeaderValue.slice("Bearer ".length);
    return yield* Effect.promise(() =>
      createEmulator({
        service: "mcp",
        port,
        seed: {
          mcp: { auth: "bearer", users: [{ login: "e2e-mcp-user" }] },
          tokens: { [token]: { login: "e2e-mcp-user" } },
        },
      }),
    );
  }),
  (emulator: Emulator) => Effect.promise(() => emulator.close()).pipe(Effect.ignore),
);

scenario(
  "Local · code mode getServer redacts static MCP header values",
  { timeout: 300_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const cli = yield* Cli;
      const runDir = yield* RunDir;
      const fixture = yield* mcpEmulator;

      yield* withLocalServer(cli, runDir, (server) =>
        Effect.gen(function* () {
          const client = yield* HttpApiClient.make(api, {
            baseUrl: new URL("/api", server.origin).toString(),
            transformClient: HttpClient.mapRequest((request) =>
              HttpClientRequest.setHeader(request, "authorization", `Bearer ${server.token}`),
            ),
          }).pipe(Effect.provide(FetchHttpClient.layer));

          yield* Effect.gen(function* () {
            yield* client.mcp.addServer({
              payload: {
                transport: "remote",
                name: "Static header redaction",
                endpoint: new URL("/mcp", fixture.url).toString(),
                slug,
                headers: { Authorization: secretHeaderValue },
              },
            });

            const mcpClient = new Client(
              { name: "e2e-static-header-redaction", version: "1.0.0" },
              { capabilities: {} },
            );
            const transport = new StreamableHTTPClientTransport(new URL(`${server.origin}/mcp`), {
              requestInit: { headers: { authorization: `Bearer ${server.token}` } },
            });

            yield* Effect.gen(function* () {
              yield* Effect.promise(() => mcpClient.connect(transport));
              const result = yield* withChatTheater(
                cli,
                {
                  title: "Static MCP header redaction",
                  record: join(runDir, "agent.cast"),
                },
                (chat) =>
                  Effect.gen(function* () {
                    yield* chat.user("Inspect the registered MCP server configuration.");
                    yield* chat.assistant("I'll read it through the Executor MCP host.");
                    return yield* chat.tool(
                      {
                        name: "execute",
                        input: code,
                        result: (toolResult) => {
                          const serialized = toolResult.content
                            .flatMap((item) => (item.type === "text" ? [item.text] : []))
                            .join("\n");
                          const payload = JSON.parse(serialized) as {
                            readonly data?: {
                              readonly integration?: {
                                readonly config?: {
                                  readonly headers?: Readonly<Record<string, string>>;
                                };
                              };
                            };
                          };
                          return JSON.stringify({
                            Authorization:
                              payload.data?.integration?.config?.headers?.Authorization ===
                              "[redacted]"
                                ? "[redacted]"
                                : "unexpected",
                            canaryPresent: serialized.includes(secretHeaderValue),
                          });
                        },
                      },
                      Effect.promise(() =>
                        mcpClient.callTool({ name: "execute", arguments: { code } }),
                      ),
                    );
                  }),
              );

              const output = result.content
                .flatMap((item) => (item.type === "text" ? [item.text] : []))
                .join("\n");
              const payload = JSON.parse(output) as {
                readonly ok?: boolean;
                readonly data?: {
                  readonly integration?: {
                    readonly config?: {
                      readonly headers?: Readonly<Record<string, string>>;
                    };
                  };
                };
              };
              expect(payload.ok, "the code-mode call succeeds").toBe(true);
              expect(
                payload.data?.integration?.config?.headers?.Authorization,
                "the static Authorization value is redacted",
              ).toBe("[redacted]");
              expect(output.includes(secretHeaderValue), "the canary is absent from output").toBe(
                false,
              );
            }).pipe(Effect.ensuring(Effect.promise(() => mcpClient.close()).pipe(Effect.ignore)));
          }).pipe(
            Effect.ensuring(
              client.mcp
                .removeServer({ params: { slug: IntegrationSlug.make(slug) } })
                .pipe(Effect.ignore),
            ),
          );
        }),
      );
    }),
  ),
);
