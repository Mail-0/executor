import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { composePluginApi } from "@executor-js/api/server";
import { mcpHttpPlugin } from "@executor-js/plugin-mcp/api";
import { makeEchoMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Mcp, Target } from "../src/services";

const api = composePluginApi([mcpHttpPlugin()] as const);

const freshSlug = (): string => `mcp_header_context_${randomBytes(4).toString("hex")}`;

scenario(
  "MCP · host header context reaches the upstream during execute",
  {},
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const slug = freshSlug();
      const server = yield* serveMcpServer(() => makeEchoMcpServer());

      yield* Effect.gen(function* () {
        yield* client.mcp.addServer({
          payload: {
            transport: "remote",
            name: "Header-context MCP",
            endpoint: server.endpoint,
            slug,
            headers: { "X-User": "{{identity}}" },
          },
        });

        yield* client.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("main"),
            integration: IntegrationSlug.make(slug),
            template: AuthTemplateSlug.make("none"),
            value: "",
          },
        });

        yield* server.clearRequests;
        expect(identity.credentials?.email, "the selfhost identity has an email").toBeDefined();
        const bearer = yield* mcp.mintBearer(identity.credentials?.email ?? identity.label);
        const hostClient = new Client(
          { name: "header-context-e2e", version: "1.0.0" },
          { capabilities: {} },
        );
        const transport = new StreamableHTTPClientTransport(new URL(mcp.url), {
          requestInit: { headers: { authorization: `Bearer ${bearer}` } },
        });
        const connectedClient = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            await hostClient.connect(transport);
            return hostClient;
          }),
          (connected) => Effect.promise(() => connected.close()).pipe(Effect.ignore),
        );

        const result = yield* Effect.promise(() =>
          connectedClient.callTool({
            name: "execute",
            arguments: {
              code: `
                const result = await tools.${slug}.org.main.echo({ value: "from host execute" });
                return result;
              `,
            },
            _meta: { "executor/header-context": { identity: "e2e-user" } },
          }),
        );
        expect(result.isError, "the host execute call completes").not.toBe(true);

        const requests = yield* server.requests;
        expect(
          requests.some((request) => request.headers["x-user"] === "e2e-user"),
          "the upstream ledger records the rendered host-provided header",
        ).toBe(true);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* client.connections
              .remove({
                params: {
                  owner: "org",
                  integration: IntegrationSlug.make(slug),
                  name: ConnectionName.make("main"),
                },
              })
              .pipe(Effect.ignore);
            yield* client.mcp
              .removeServer({ params: { slug: IntegrationSlug.make(slug) } })
              .pipe(Effect.ignore);
          }),
        ),
      );
    }),
  ),
);
