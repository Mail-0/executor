import { describe, expect, it, vi } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { ElicitationResponse, type Elicit } from "@executor-js/sdk";

import { createMcpConnector, type McpConnection } from "./connection";
import { createMcpConnectionPool } from "./connection-pool";
import { invokeMcpTool } from "./invoke";
import { makeEchoMcpServer, serveMcpServer } from "../testing";

const makeTestConnection = () => {
  let closed = false;
  const connection: McpConnection = {
    client: {} as McpConnection["client"],
    close: async () => {
      closed = true;
    },
  };
  return { connection, isClosed: () => closed };
};

const releaseConnection = (
  pool: ReturnType<typeof createMcpConnectionPool>,
  key: string,
  connection: McpConnection,
) => pool.withConnection(key, Effect.succeed(connection), () => Effect.void);

const acceptAll: Elicit = () =>
  Effect.succeed(ElicitationResponse.make({ action: "accept", content: { approved: true } }));

const invoke = (input: {
  readonly endpoint: string;
  readonly pool: ReturnType<typeof createMcpConnectionPool>;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly elicit?: Elicit;
}) =>
  invokeMcpTool({
    toolId: input.toolName,
    toolName: input.toolName,
    args: input.args,
    transport: "streamable-http",
    connector: createMcpConnector({
      transport: "remote",
      endpoint: input.endpoint,
      remoteTransport: "streamable-http",
    }),
    connectionPool: input.pool,
    connectionPoolKey: input.endpoint,
    elicit: input.elicit ?? acceptAll,
  });

describe("MCP connection pool", () => {
  it.effect("reuses one session for sequential invokes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveMcpServer(() => makeEchoMcpServer());
        const pool = createMcpConnectionPool();

        const first = yield* invoke({
          endpoint: server.endpoint,
          pool,
          toolName: "echo",
          args: { value: "first" },
        });
        const second = yield* invoke({
          endpoint: server.endpoint,
          pool,
          toolName: "echo",
          args: { value: "second" },
        });

        expect(first).toMatchObject({ content: [{ type: "text", text: "first" }] });
        expect(second).toMatchObject({ content: [{ type: "text", text: "second" }] });
        expect(server.sessionCount()).toBe(1);
        yield* pool.close();
      }),
    ),
  );

  it.effect("leases separate sessions to concurrent invokes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveMcpServer(() => makeEchoMcpServer());
        const pool = createMcpConnectionPool();

        const results = yield* Effect.all(
          [
            invoke({
              endpoint: server.endpoint,
              pool,
              toolName: "echo",
              args: { value: "left" },
            }),
            invoke({
              endpoint: server.endpoint,
              pool,
              toolName: "echo",
              args: { value: "right" },
            }),
          ],
          { concurrency: "unbounded" },
        );

        expect(results).toEqual([
          expect.objectContaining({ content: [{ type: "text", text: "left" }] }),
          expect.objectContaining({ content: [{ type: "text", text: "right" }] }),
        ]);
        expect(server.sessionCount()).toBe(2);
        yield* pool.close();
      }),
    ),
  );

  it.effect("redials once when a reused session has expired", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveMcpServer(() => makeEchoMcpServer());
        const pool = createMcpConnectionPool();

        yield* invoke({
          endpoint: server.endpoint,
          pool,
          toolName: "echo",
          args: { value: "before" },
        });
        yield* server.forgetSessions;
        const after = yield* invoke({
          endpoint: server.endpoint,
          pool,
          toolName: "echo",
          args: { value: "after" },
        });

        expect(after).toMatchObject({ content: [{ type: "text", text: "after" }] });
        expect(server.sessionCount()).toBe(2);
        yield* pool.close();
      }),
    ),
  );

  it.effect("drops a connection after a transport-level invocation failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveMcpServer(() => makeEchoMcpServer());
        const pool = createMcpConnectionPool();

        yield* invoke({
          endpoint: server.endpoint,
          pool,
          toolName: "echo",
          args: { value: "before" },
        });
        yield* server.rejectNextSessionRequest(500);
        yield* invoke({
          endpoint: server.endpoint,
          pool,
          toolName: "echo",
          args: { value: "fails" },
        }).pipe(Effect.flip);
        const after = yield* invoke({
          endpoint: server.endpoint,
          pool,
          toolName: "echo",
          args: { value: "after" },
        });

        expect(after).toMatchObject({ content: [{ type: "text", text: "after" }] });
        expect(server.sessionCount()).toBe(2);
        yield* pool.close();
      }),
    ),
  );

  it.effect("drops a pooled session whose bearer the server has stopped accepting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveMcpServer(() => makeEchoMcpServer());
        const pool = createMcpConnectionPool();

        yield* invoke({
          endpoint: server.endpoint,
          pool,
          toolName: "echo",
          args: { value: "before" },
        });

        // A 401 means the bearer this session was dialled with is no longer
        // accepted. The session is bound to that token for its lifetime, so
        // retaining it would serve the same dead credential for the full idle
        // window — and would defeat core's post-401 refresh, whose new token can
        // only reach the server over a NEW session.
        yield* server.rejectNextSessionRequest(401);
        yield* invoke({
          endpoint: server.endpoint,
          pool,
          toolName: "echo",
          args: { value: "unauthorized" },
        }).pipe(Effect.flip);

        const after = yield* invoke({
          endpoint: server.endpoint,
          pool,
          toolName: "echo",
          args: { value: "after" },
        });

        expect(after).toMatchObject({ content: [{ type: "text", text: "after" }] });
        // A second session was dialled rather than the dead one being reused.
        expect(server.sessionCount()).toBe(2);
        yield* pool.close();
      }),
    ),
  );

  it.effect("sweeps expired idle connections for other keys on release", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const pool = createMcpConnectionPool();
    const expired = makeTestConnection();
    const current = makeTestConnection();

    return Effect.scoped(
      Effect.gen(function* () {
        yield* releaseConnection(pool, "key-a", expired.connection);
        clock.mockReturnValue(1_000_000 + 5 * 60 * 1_000 + 1);
        yield* releaseConnection(pool, "key-b", current.connection);

        expect(expired.isClosed()).toBe(true);
        expect(current.isClosed()).toBe(false);
        yield* pool.close();
      }).pipe(Effect.ensuring(Effect.sync(() => clock.mockRestore()))),
    );
  });

  it.effect("evicts and closes the oldest idle connection above the cap", () => {
    const clock = vi.spyOn(Date, "now");
    const pool = createMcpConnectionPool();
    const connections = Array.from({ length: 65 }, () => makeTestConnection());

    return Effect.scoped(
      Effect.gen(function* () {
        for (const [index, connection] of connections.entries()) {
          clock.mockReturnValue(1_000_000 + index);
          yield* releaseConnection(pool, `key-${index}`, connection.connection);
        }

        expect(connections[0]?.isClosed()).toBe(true);
        expect(connections[1]?.isClosed()).toBe(false);
        expect(connections[64]?.isClosed()).toBe(false);
        yield* pool.close();
      }).pipe(Effect.ensuring(Effect.sync(() => clock.mockRestore()))),
    );
  });

  it.effect("does not evict an active lease while idle capacity is exceeded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pool = createMcpConnectionPool();
        const active = makeTestConnection();
        let signalStarted: () => void = () => {};
        let releaseActive: () => void = () => {};
        const started = new Promise<void>((resolve) => {
          signalStarted = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
          releaseActive = resolve;
        });

        const activeFiber = yield* Effect.forkChild(
          pool.withConnection("active", Effect.succeed(active.connection), () =>
            Effect.promise(async () => {
              signalStarted();
              await blocked;
            }),
          ),
        );
        yield* Effect.promise(() => started);

        for (let index = 0; index < 65; index += 1) {
          const idle = makeTestConnection();
          yield* releaseConnection(pool, `idle-${index}`, idle.connection);
        }

        expect(active.isClosed()).toBe(false);
        releaseActive();
        yield* Fiber.join(activeFiber);
        expect(active.isClosed()).toBe(false);
        yield* pool.close();
      }),
    ),
  );
});
