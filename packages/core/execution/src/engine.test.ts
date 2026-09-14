import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit } from "effect";

import { createExecutor, definePlugin } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import type { CodeExecutor, ExecuteResult } from "@executor-js/codemode-core";

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

const makeExecutor = () => createExecutor(makeTestConfig({ plugins: [emptyPlugin()] as const }));

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
