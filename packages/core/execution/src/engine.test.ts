import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit, Schema } from "effect";

import { createExecutor, definePlugin } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import type { CodeExecutor, ExecuteResult } from "@executor-js/codemode-core";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";

import { createExecutionEngine } from "./engine";

// Regression for the hang reported as the executor-MCP "180s timeout" against
// Cowork (Claude web). Cowork goes down the `executeWithPause` branch because
// it doesn't advertise managed elicitation. When the dynamic worker fails
// fast (e.g. user submits TS with a `:` type annotation, "Unexpected token
// ':'" inside ~25ms), the failure was swallowed and the request hung until
// the client gave up at 180s. The cause was `Effect.race` having
// prefer-success semantics in Effect v4: the racing pause-signal Deferred
// never resolves, so a fiber failure is never observed by the racer.

class FakeRuntimeError extends Data.TaggedError("FakeRuntimeError")<{
  readonly message: string;
}> {}

const failingExecutor: CodeExecutor<FakeRuntimeError> = {
  execute: () => Effect.fail(new FakeRuntimeError({ message: "Unexpected token ':'" })),
};

const succeedingExecutor: CodeExecutor<FakeRuntimeError> = {
  execute: () => Effect.succeed({ result: "ok", logs: [] } satisfies ExecuteResult),
};

const emptyPlugin = definePlugin(() => ({
  id: "empty-test" as const,
  storage: () => ({}),
  staticIntegrations: () => [],
}));

const scopedPlugin = definePlugin(() => ({
  id: "scoped-fixture" as const,
  storage: () => ({}),
  staticIntegrations: () => [
    {
      id: "alpha",
      kind: "in-memory",
      name: "Alpha",
      tools: [
        {
          name: "get",
          description: "Read alpha data",
          inputSchema: Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(Schema.Struct({}))),
          handler: () => Effect.succeed({ source: "alpha" }),
        },
        {
          name: "approve",
          description: "Approval-gated alpha action",
          inputSchema: Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(Schema.Struct({}))),
          annotations: { requiresApproval: true },
          handler: () => Effect.succeed({ source: "approved-alpha" }),
        },
      ],
    },
    {
      id: "beta",
      kind: "in-memory",
      name: "Beta",
      tools: [
        {
          name: "get",
          description: "Read beta data",
          inputSchema: Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(Schema.Struct({}))),
          handler: () => Effect.succeed({ source: "beta" }),
        },
      ],
    },
  ],
}));

const makeExecutor = () => createExecutor(makeTestConfig({ plugins: [emptyPlugin()] as const }));
const makeScopedExecutor = () =>
  createExecutor(makeTestConfig({ plugins: [scopedPlugin()] as const }));

describe("executeWithPause failure propagation", () => {
  it.effect("surfaces a fast codeExecutor failure as an Exit.Failure", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const engine = createExecutionEngine({
        executor,
        codeExecutor: failingExecutor,
      });

      const exit = yield* Effect.exit(engine.executeWithPause("noop"));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("does not hang when codeExecutor fails", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const engine = createExecutionEngine({
        executor,
        codeExecutor: failingExecutor,
      });

      // Race the executeWithPause against a short sleep. With the bug
      // present this resolves to "hung" because the failure is swallowed
      // by the prefer-success race against the pause Deferred.
      const outcome = yield* Effect.race(
        Effect.exit(engine.executeWithPause("noop")).pipe(
          Effect.map((exit) => ({ kind: "settled" as const, exit })),
        ),
        Effect.sleep("500 millis").pipe(Effect.as({ kind: "hung" as const })),
      );

      expect(outcome.kind).toBe("settled");
    }),
  );

  it.effect("control: succeedingExecutor returns completed", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const engine = createExecutionEngine({
        executor,
        codeExecutor: succeedingExecutor,
      });

      const result = yield* engine.executeWithPause("noop");
      expect(result.status).toBe("completed");
    }),
  );
});

describe("pausedExecutionCount", () => {
  it.effect("starts at zero", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const engine = createExecutionEngine({
        executor,
        codeExecutor: succeedingExecutor,
      });

      expect(yield* engine.pausedExecutionCount()).toBe(0);
      expect(yield* engine.hasPausedExecutions()).toBe(false);
    }),
  );
});

describe("tool call log", () => {
  // A runtime that calls two tools: one that resolves and one the executor
  // reports as not found (an expected failure on the success channel).
  const callingExecutor: CodeExecutor<FakeRuntimeError> = {
    execute: (_code, tools) =>
      Effect.gen(function* () {
        const first = yield* tools
          .invoke({ path: "missing.tool", args: { q: 1 } })
          .pipe(Effect.orElseSucceed(() => null));
        const second = yield* tools
          .invoke({ path: "search", args: { query: "nothing" } })
          .pipe(Effect.orElseSucceed(() => null));
        return { result: [first, second], logs: [] } satisfies ExecuteResult;
      }),
  };

  it.effect("reports every sandbox tool call with its input and outcome", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const engine = createExecutionEngine({ executor, codeExecutor: callingExecutor });
      const result = yield* engine.execute("code", {
        onElicitation: () => Effect.succeed({ action: "accept" }),
      });
      const calls = result.toolCalls ?? [];
      expect(calls.map((call) => call.path)).toEqual(["missing.tool", "search"]);
      expect(calls[0]).toMatchObject({
        ok: false,
        input: { q: 1 },
        error: "Tool not found: missing.tool",
      });
      expect(calls[1]).toMatchObject({ ok: true, input: { query: "nothing" } });
      expect(typeof calls[0]?.durationMs).toBe("number");
      expect(Number.isNaN(Date.parse(calls[0]?.startedAt ?? ""))).toBe(false);
    }),
  );
});

describe("per-execution integration scope", () => {
  const quickJsExecutor = makeQuickJsExecutor();

  const scopedRuntime: CodeExecutor<FakeRuntimeError> = {
    execute: (_code, tools) =>
      Effect.gen(function* () {
        const invoke = (path: string, args: unknown) =>
          tools.invoke({ path, args }).pipe(Effect.orElseSucceed(() => null));
        const alpha = yield* invoke("alpha.get", {});
        const beta = yield* invoke("beta.get", {});
        const staticTool = yield* invoke("executor.secret", {});
        const search = yield* invoke("search", { query: "", namespace: "alpha" });
        const querySearch = yield* invoke("search", { query: "Read" });
        const betaSearch = yield* invoke("search", { query: "", namespace: "beta" });
        const described = yield* invoke("describe.tool", { path: "beta.get" });
        const describedSearch = yield* invoke("describe.tool", { path: "search" });
        const describedIntegrations = yield* invoke("describe.tool", {
          path: "executor.integrations.list",
        });
        const integrations = yield* invoke("executor.integrations.list", {});
        return {
          result: {
            alpha,
            beta,
            staticTool,
            search,
            querySearch,
            betaSearch,
            described,
            describedSearch,
            describedIntegrations,
            integrations,
          },
          logs: [],
        } satisfies ExecuteResult;
      }),
  };

  it.effect("limits calls and discovery to the requested integrations", () =>
    Effect.gen(function* () {
      const executor = yield* makeScopedExecutor();
      const engine = createExecutionEngine({ executor, codeExecutor: scopedRuntime });
      const result = yield* engine.execute("scoped", {
        onElicitation: () => Effect.succeed({ action: "accept" }),
        integrations: ["alpha"],
      });

      expect(result.result).toMatchObject({
        alpha: { ok: true, data: { source: "alpha" } },
        beta: { ok: false, error: { code: "out_of_scope" } },
        staticTool: { ok: false, error: { code: "out_of_scope" } },
        search: {
          items: [
            expect.objectContaining({ integration: "alpha" }),
            expect.objectContaining({ integration: "alpha" }),
          ],
          total: 2,
          hasMore: false,
        },
        querySearch: {
          items: [expect.objectContaining({ integration: "alpha" })],
          total: 1,
          hasMore: false,
        },
        betaSearch: { items: [], total: 0, hasMore: false },
        described: { error: { code: "tool_not_found" } },
        describedSearch: {
          path: "search",
          name: "search",
          description:
            "Search available Executor tools. An empty query with a namespace enumerates that integration's full catalog, sorted by path.",
        },
        describedIntegrations: {
          path: "executor.integrations.list",
          name: "executor.integrations.list",
          description: "List configured Executor integrations.",
        },
        integrations: { items: [expect.objectContaining({ id: "alpha" })], total: 1 },
      });
      const calls = result.toolCalls ?? [];
      expect(calls.find((call) => call.path === "beta.get")).toMatchObject({
        ok: false,
        error: expect.stringContaining("outside this execution's integration scope"),
      });
      expect(calls.find((call) => call.path === "search")).toBeDefined();
    }),
  );

  it.effect("keeps the scope attached to a paused execution through resume", () =>
    Effect.gen(function* () {
      const executor = yield* makeScopedExecutor();
      const codeExecutor: CodeExecutor<FakeRuntimeError> = {
        execute: (_code, tools) =>
          Effect.gen(function* () {
            const approved = yield* tools
              .invoke({ path: "alpha.approve", args: {} })
              .pipe(Effect.orElseSucceed(() => null));
            const beta = yield* tools
              .invoke({ path: "beta.get", args: {} })
              .pipe(Effect.orElseSucceed(() => null));
            return { result: { approved, beta }, logs: [] } satisfies ExecuteResult;
          }),
      };
      const engine = createExecutionEngine({ executor, codeExecutor });
      const paused = yield* engine.executeWithPause("pause", { integrations: ["alpha"] });
      expect(paused.status).toBe("paused");
      if (paused.status !== "paused") return;

      const resumed = yield* engine.resume(paused.execution.id, { action: "accept" });
      expect(resumed?.status).toBe("completed");
      if (resumed?.status !== "completed") return;
      expect(resumed.result.result).toMatchObject({
        approved: { ok: true, data: { source: "approved-alpha" } },
        beta: { ok: false, error: { code: "out_of_scope" } },
      });
    }),
  );

  it.effect("keeps the scope in the auto-approve inline path", () =>
    Effect.gen(function* () {
      const executor = yield* makeScopedExecutor();
      const engine = createExecutionEngine({ executor, codeExecutor: scopedRuntime });
      const outcome = yield* engine.executeWithPause("auto-approved", {
        autoApprove: true,
        integrations: ["alpha"],
      });

      expect(outcome.status).toBe("completed");
      if (outcome.status !== "completed") return;
      expect(outcome.result.result).toMatchObject({
        alpha: { ok: true, data: { source: "alpha" } },
        beta: { ok: false, error: { code: "out_of_scope" } },
      });
    }),
  );

  it.effect("leaves beta callable when no scope is supplied", () =>
    Effect.gen(function* () {
      const executor = yield* makeScopedExecutor();
      const engine = createExecutionEngine({ executor, codeExecutor: scopedRuntime });
      const result = yield* engine.execute("unscoped", {
        onElicitation: () => Effect.succeed({ action: "accept" }),
      });
      expect(result.result).toMatchObject({
        beta: { ok: true, data: { source: "beta" } },
      });
    }),
  );

  it.effect("does not expose beta through hostile snippets or wrapper-closing source", () =>
    Effect.gen(function* () {
      const executor = yield* makeScopedExecutor();
      const engine = createExecutionEngine({ executor, codeExecutor: quickJsExecutor });
      const snippets = [
        {
          code: 'return typeof globalThis.tools === "undefined" ? null : await globalThis.tools.beta.org.main.get({});',
        },
        {
          code: "try { const { beta } = tools; return await beta.org.main.get({}); } catch { return null; }",
        },
        {
          code: 'const key = ["beta", "org", "main", "get"].join("."); return await tools[key]({});',
        },
        {
          code: "async () => 0); } catch (e) {} })(null) || await tools.beta.org.main.get({}) || (async (tools) => { try { const __fn = (async () => 0",
        },
      ];

      const executions: ExecuteResult[] = [];
      for (const snippet of snippets) {
        const execution = yield* engine.execute(snippet.code, {
          onElicitation: () => Effect.succeed({ action: "accept" }),
          integrations: ["alpha"],
        });
        executions.push(execution);
        expect(JSON.stringify(execution.result)).not.toContain('"source":"beta"');
        expect(
          (execution.toolCalls ?? [])
            .filter((call) => call.path.includes("beta"))
            .every((call) => !call.ok),
        ).toBe(true);
      }
      expect(executions[2]?.toolCalls?.find((call) => call.path.includes("beta"))).toMatchObject({
        ok: false,
        error: expect.stringContaining("outside this execution's integration scope"),
      });
    }),
  );

  it.effect("preserves a block policy for an in-scope tool", () =>
    Effect.gen(function* () {
      const executor = yield* makeScopedExecutor();
      yield* executor.policies.create({
        owner: "org",
        pattern: "alpha.get",
        action: "block",
      });
      const engine = createExecutionEngine({ executor, codeExecutor: scopedRuntime });
      const result = yield* engine.execute("blocked-in-scope", {
        onElicitation: () => Effect.succeed({ action: "accept" }),
        integrations: ["alpha"],
      });
      expect(result.result).toMatchObject({
        alpha: { ok: false, error: { code: "tool_blocked" } },
        beta: { ok: false, error: { code: "out_of_scope" } },
      });
    }),
  );
});
