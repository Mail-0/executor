import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  definePlugin,
  type Executor,
} from "@executor-js/sdk";
import {
  makeTestWorkspaceHarness,
  memoryCredentialsPlugin,
  serveOAuthTestServer,
} from "@executor-js/sdk/testing";

import { ExecutorApi } from "../api";
import { observabilityMiddleware } from "../observability";
import { CoreHandlers, ExecutionEngineService, ExecutorService } from "../server";

// ---------------------------------------------------------------------------
// `needsReconsent` on the connections surface: whether an already-minted OAuth
// connection must re-run the flow because the integration has come to declare
// a scope the original grant never requested (a spec widened, a service added).
//
// The signal has to be computed per response — a stored column would be stale
// the moment declarations change — so it is proven against a REAL grant: the
// connection is minted through `oauth.start`/`oauth.complete` against the test
// authorization server, then the integration's declared scopes are re-seeded
// underneath it and the same connection is read back over HTTP.
// ---------------------------------------------------------------------------

const INTEG = IntegrationSlug.make("acme");
const TEMPLATE = AuthTemplateSlug.make("oauth");
const CLIENT = OAuthClientSlug.make("acme-app");

const oauthPlugin = definePlugin(() => ({
  id: "acme" as const,
  storage: () => ({}),
  describeAuthMethods: (record) => {
    const config = record.config as { readonly scopes?: readonly string[] } | null;
    return [
      {
        id: "oauth",
        label: "OAuth2",
        kind: "oauth" as const,
        template: String(TEMPLATE),
        oauth: { scopes: config?.scopes ?? [] },
      },
    ];
  },
  extension: (ctx) => ({
    // Re-seeding the same slug rewrites the declared scopes in place, which is
    // exactly what an in-place spec update does to a live integration.
    seed: (scopes: readonly string[]) =>
      ctx.core.integrations.register({ slug: INTEG, description: "Acme", config: { scopes } }),
  }),
}))();

const plugins = [memoryCredentialsPlugin(), oauthPlugin] as const;

const webHandlerFor = (executor: Executor) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(ExecutorApi).pipe(
          Layer.provide(CoreHandlers),
          Layer.provide(observabilityMiddleware(ExecutorApi)),
          Layer.provide(Layer.succeed(ExecutorService)(executor)),
          Layer.provide(
            Layer.succeed(ExecutionEngineService)({} as ExecutionEngineService["Service"]),
          ),
          Layer.provideMerge(HttpServer.layerServices),
          Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
        ),
        { disableLogger: true },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  );

const handlerContextFor = (executor: Executor) =>
  Context.make(ExecutorService, executor).pipe(
    Context.add(ExecutionEngineService, {} as ExecutionEngineService["Service"]),
  );

interface ConnectionResponseBody {
  readonly name: string;
  readonly oauthScope: string | null;
  readonly missingOAuthScopes: readonly string[];
  readonly needsReconsent: boolean;
}

/** Mint a real OAuth connection granting `scopes`, with the integration
 *  declaring exactly those scopes at mint time. */
const mintConnection = (scopes: readonly string[]) =>
  Effect.gen(function* () {
    const server = yield* serveOAuthTestServer({ scopes });
    const { executor } = yield* makeTestWorkspaceHarness({ plugins });
    yield* executor.acme.seed(scopes);
    yield* executor.oauth.createClient({
      owner: "org",
      slug: CLIENT,
      authorizationUrl: server.authorizationEndpoint,
      tokenUrl: server.tokenEndpoint,
      grant: "authorization_code",
      clientId: "test-client",
      clientSecret: "test-secret",
    });
    const started = yield* executor.oauth.start({
      owner: "org",
      client: CLIENT,
      clientOwner: "org",
      name: ConnectionName.make("main"),
      integration: INTEG,
      template: TEMPLATE,
    });
    expect(started.status).toBe("redirect");
    if (started.status !== "redirect") return executor;
    const callback = yield* server.completeAuthorizationCodeFlow({
      authorizationUrl: started.authorizationUrl,
    });
    yield* executor.oauth.complete({ state: started.state, code: callback.code });
    return executor;
  });

const readConnection = (executor: Executor) =>
  Effect.gen(function* () {
    const web = yield* webHandlerFor(executor);
    const context = handlerContextFor(executor);
    const response = yield* Effect.promise(() =>
      web.handler(new Request(`http://localhost/connections/org/${String(INTEG)}/main`), context),
    );
    expect(response.status).toBe(200);
    return (yield* Effect.promise(() => response.json())) as ConnectionResponseBody;
  });

const readList = (executor: Executor) =>
  Effect.gen(function* () {
    const web = yield* webHandlerFor(executor);
    const context = handlerContextFor(executor);
    const response = yield* Effect.promise(() =>
      web.handler(new Request("http://localhost/connections"), context),
    );
    expect(response.status).toBe(200);
    return (yield* Effect.promise(() => response.json())) as readonly ConnectionResponseBody[];
  });

describe("connections expose needsReconsent", () => {
  it.effect("a grant covering every declared scope does not need reconsent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* mintConnection(["read"]);
        const body = yield* readConnection(executor);
        expect(body.oauthScope).toBe("read");
        expect(body.needsReconsent).toBe(false);
      }),
    ),
  );

  it.effect("a scope declared AFTER the grant needs reconsent, in get and in list", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* mintConnection(["read"]);
        yield* executor.acme.seed(["read", "write"]);

        expect((yield* readConnection(executor)).needsReconsent).toBe(true);
        const [listed] = yield* readList(executor);
        expect(listed?.needsReconsent).toBe(true);
      }),
    ),
  );

  it.effect("NARROWED declarations do not need reconsent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* mintConnection(["read", "write"]);
        yield* executor.acme.seed(["read"]);
        expect((yield* readConnection(executor)).needsReconsent).toBe(false);
      }),
    ),
  );

  it.effect("a scope the provider withheld was still REQUESTED, so it stays quiet", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The AS advertises both scopes — so both are REQUESTED — but omits
        // `write` from the token response, which `missingOAuthScopes` records.
        // Declaring it is not new information, so no reconsent is asked for.
        const server = yield* serveOAuthTestServer({
          scopes: ["read", "write"],
          omitTokenResponseScopes: ["write"],
        });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed(["read", "write"]);
        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });
        const started = yield* executor.oauth.start({
          owner: "org",
          client: CLIENT,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
        });
        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;
        const callback = yield* server.completeAuthorizationCodeFlow({
          authorizationUrl: started.authorizationUrl,
        });
        yield* executor.oauth.complete({ state: started.state, code: callback.code });

        const body = yield* readConnection(executor);
        expect(body.missingOAuthScopes).toEqual(["write"]);
        expect(body.needsReconsent).toBe(false);
      }),
    ),
  );
});
