import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
  createExecutor,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";
import { variable } from "@executor-js/sdk/http-auth";

import { mcpPlugin } from "./plugin";
import { makeEchoMcpServer, serveMcpServer, type McpTestRequest } from "../testing";

const SLUG = "header_context";
const TEMPLATE = "header_token";

const seedHeaderContextExecutor = () =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const server = yield* serveMcpServer(() => makeEchoMcpServer());
      const config = makeTestConfig({
        plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const,
      });
      const executor = yield* createExecutor(config);

      yield* executor.mcp.addServer({
        name: "Header context fixture",
        endpoint: server.endpoint,
        slug: SLUG,
        remoteTransport: "streamable-http",
        headers: {
          "X-User": "Bearer {{identity}}",
          "X-Mixed": "before {{ identity }} after",
          "X-Unknown": "unknown={{missing}}",
          Authorization: "Static {{identity}}",
        },
        authenticationTemplate: [
          {
            slug: TEMPLATE,
            type: "apiKey",
            headers: { Authorization: ["Bearer ", variable("token")] },
          },
        ],
      });

      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make(SLUG),
        template: AuthTemplateSlug.make(TEMPLATE),
        values: { token: "api-key-token" },
      });

      return {
        config,
        executor,
        server,
        address: ToolAddress.make(`tools.${SLUG}.org.main.echo`),
      } as const;
    }),
    ({ config, executor }) =>
      Effect.gen(function* () {
        yield* executor.close().pipe(Effect.ignore);
        yield* Effect.promise(() => config.testDb.close()).pipe(Effect.ignore);
      }),
  );

const lastPost = (requests: readonly McpTestRequest[]): McpTestRequest | undefined => {
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index];
    if (request?.method === "POST") return request;
  }
  return undefined;
};

describe("MCP static header context", () => {
  it.effect("renders placeholders on the upstream request and separates pooled contexts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor, server, address } = yield* seedHeaderContextExecutor();
        const sessionsBeforeInvokes = server.sessionCount();
        const context = { identity: "Ada\r\nX-Evil: yes" };
        const invoke = (headerContext?: Readonly<Record<string, string>>) =>
          executor.execute(
            address,
            { value: "hello" },
            {
              onElicitation: "accept-all",
              ...(headerContext === undefined ? {} : { headerContext }),
            },
          );

        yield* invoke(context);
        const renderedRequest = lastPost(yield* server.requests);
        expect(renderedRequest?.headers["x-user"]).toBe("Bearer Ada  X-Evil: yes");
        expect(renderedRequest?.headers["x-mixed"]).toBe("before Ada  X-Evil: yes after");
        expect(renderedRequest?.headers["x-unknown"]).toBe("unknown={{missing}}");
        expect(renderedRequest?.headers.authorization).toBe("Bearer api-key-token");
        expect(renderedRequest?.headers["x-evil"]).toBeUndefined();
        expect(server.sessionCount()).toBe(sessionsBeforeInvokes + 1);

        yield* invoke(context);
        expect(server.sessionCount()).toBe(sessionsBeforeInvokes + 1);

        yield* invoke({ identity: "Grace" });
        expect(server.sessionCount()).toBe(sessionsBeforeInvokes + 2);

        yield* invoke();
        const unrenderedRequest = lastPost(yield* server.requests);
        expect(unrenderedRequest?.headers["x-user"]).toBe("Bearer {{identity}}");
        expect(unrenderedRequest?.headers["x-mixed"]).toBe("before {{ identity }} after");
      }),
    ),
  );
});
