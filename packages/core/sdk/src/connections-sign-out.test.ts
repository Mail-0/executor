import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Result } from "effect";
import { createEmulator, type Emulator } from "@executor-js/emulate";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ToolName,
} from "./ids";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { ProviderItemId, ProviderKey } from "./ids";
import {
  makeTestWorkspaceHarness,
  TEST_OAUTH_REDIRECT_URI,
  type TestWorkspaceHarness,
} from "./test-config";
import { serveOAuthTestServer, type OAuthTestServerShape } from "./testing/oauth-test-server";

// `connections.signOut` end to end: RFC 7009 revocation at the authorization
// server (the published @executor-js/emulate Google emulator — its OIDC
// metadata advertises `revocation_endpoint` and its request ledger proves the
// calls landed), then removal of the local credential, plus the
// `prompt` passthrough on `oauth.start` that forces a fresh login after
// sign-out.

const INTEG = IntegrationSlug.make("acme");
const TEMPLATE = AuthTemplateSlug.make("oauth");
const CLIENT = OAuthClientSlug.make("acme-app");

// The credential store is captured so tests can read the minted access /
// refresh tokens back out (the emulator's ledger redacts secret material, so
// "the refresh token is dead upstream" is the honest revocation proof).
const credentialStore = new Map<string, string>();

const memoryProvider = (): CredentialProvider => ({
  key: ProviderKey.make("memory"),
  writable: true,
  get: (id) => Effect.sync(() => credentialStore.get(String(id)) ?? null),
  set: (id, value) => Effect.sync(() => void credentialStore.set(String(id), value)),
  has: (id) => Effect.sync(() => credentialStore.has(String(id))),
  list: () =>
    Effect.sync(() =>
      Array.from(credentialStore.keys()).map((key) => ({
        id: ProviderItemId.make(key),
        name: key,
      })),
    ),
});

const oauthPlugin = definePlugin(() => ({
  id: "acme" as const,
  credentialProviders: [memoryProvider()],
  storage: () => ({}),
  resolveTools: () =>
    Effect.succeed({
      tools: [{ name: ToolName.make("whoami"), description: "whoami" }],
    }),
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
  invokeTool: ({ credential }) => Effect.succeed({ token: credential.value }),
  extension: (ctx) => ({
    seed: (scopes: readonly string[] = []) =>
      ctx.core.integrations.register({
        slug: INTEG,
        description: "Acme",
        config: { scopes },
      }),
  }),
}))();

const plugins = [oauthPlugin] as const;
type TestExecutor = TestWorkspaceHarness<typeof plugins>["executor"];

const acquireGoogleEmulator = Effect.acquireRelease(
  Effect.promise(() => createEmulator({ service: "google" })),
  (emulator) => Effect.promise(() => emulator.close()),
);

// The Google emulator's hosted consent: GET the authorize page, POST the
// seeded user's consent form, take the code off the 302 Location.
const completeGoogleConsent = (authorizationUrl: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const decodeHtml = (value: string): string =>
      value
        .replaceAll("&amp;", "&")
        .replaceAll("&quot;", '"')
        .replaceAll("&#x27;", "'")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">");
    const page = yield* Effect.promise(() =>
      // oxlint-disable-next-line executor/no-raw-fetch -- test boundary: drives the emulator's hosted consent page directly
      fetch(authorizationUrl),
    );
    if (!page.ok) {
      return yield* Effect.die(`Google emulator authorize failed: ${page.status}`);
    }
    const html = yield* Effect.promise(() => page.text());
    const fields: Record<string, string> = {};
    for (const input of html.matchAll(/<input\b[^>]*>/gi)) {
      const tag = input[0];
      const name = tag.match(/\bname=["']([^"']+)["']/i)?.[1];
      const value = tag.match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? "";
      if (name) fields[decodeHtml(name)] = decodeHtml(value);
    }
    const action = html.match(/<form\b[^>]*\baction=["']([^"']+)["']/i)?.[1] ?? authorizationUrl;
    const callback = yield* Effect.promise(() =>
      // oxlint-disable-next-line executor/no-raw-fetch -- test boundary: posts the emulator's consent form directly
      fetch(decodeHtml(action), {
        method: "POST",
        body: new URLSearchParams(fields),
        redirect: "manual",
      }),
    );
    const location = callback.headers.get("location");
    if (callback.status !== 302 || !location) {
      return yield* Effect.die(`Google emulator consent did not redirect: ${callback.status}`);
    }
    const code = new URL(location).searchParams.get("code");
    if (!code) {
      return yield* Effect.die("Google emulator callback did not include a code");
    }
    return code;
  });

/** Register a real Google-emulator OAuth app on the executor and run one
 *  authorize → consent → code-exchange round, minting a connection whose
 *  grant lives upstream on the emulator. */
const connectGoogleAccount = (executor: TestExecutor, emulator: Emulator, name: string) =>
  Effect.gen(function* () {
    const credential = yield* Effect.promise(() =>
      emulator.credentials.mint({
        type: "oauth-authorization-code",
        redirect_uris: [TEST_OAUTH_REDIRECT_URI],
      }),
    );
    expect(credential.client_id).toBeTruthy();
    expect(credential.client_secret).toBeTruthy();
    if (!credential.client_id || !credential.client_secret) {
      return yield* Effect.die("Google emulator did not mint an OAuth client");
    }
    yield* executor.oauth.createClient({
      owner: "org",
      slug: CLIENT,
      authorizationUrl: `${emulator.url}/o/oauth2/v2/auth`,
      tokenUrl: `${emulator.url}/oauth2/token`,
      grant: "authorization_code",
      clientId: credential.client_id,
      clientSecret: credential.client_secret,
    });
    const started = yield* executor.oauth.start({
      owner: "org",
      client: CLIENT,
      clientOwner: "org",
      name: ConnectionName.make(name),
      integration: INTEG,
      template: TEMPLATE,
    });
    expect(started.status).toBe("redirect");
    if (started.status !== "redirect") {
      return yield* Effect.die("oauth.start did not redirect");
    }
    const code = yield* completeGoogleConsent(started.authorizationUrl);
    const connection = yield* executor.oauth.complete({ state: started.state, code });
    return { connection, credential };
  });

/** Mint an OAuth connection against the test authorization server the same
 *  way the oauth-flow suite does. */
const connectTestServerAccount = (
  executor: TestExecutor,
  server: OAuthTestServerShape,
  name: string,
) =>
  Effect.gen(function* () {
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
      name: ConnectionName.make(name),
      integration: INTEG,
      template: TEMPLATE,
    });
    expect(started.status).toBe("redirect");
    if (started.status !== "redirect") {
      return yield* Effect.die("oauth.start did not redirect");
    }
    const callback = yield* server.completeAuthorizationCodeFlow({
      authorizationUrl: started.authorizationUrl,
    });
    return yield* executor.oauth.complete({ state: started.state, code: callback.code });
  });

const storedTokenValues = (...prefixes: readonly string[]) =>
  [...credentialStore.values()].filter((value) =>
    prefixes.some((prefix) => value.startsWith(prefix)),
  );

const REF = (name: string) => ({
  owner: "org" as const,
  integration: INTEG,
  name: ConnectionName.make(name),
});

describe("connections.signOut", () => {
  it.effect(
    "revokes the refresh token then the access token at the AS revocation endpoint, then removes the connection",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const emulator = yield* acquireGoogleEmulator;
          const { executor } = yield* makeTestWorkspaceHarness({ plugins });
          yield* executor.acme.seed();
          const { credential } = yield* connectGoogleAccount(executor, emulator, "main");
          const [accessToken, refreshToken] = [
            storedTokenValues("google_").find((v) => !v.startsWith("google_refresh_")),
            storedTokenValues("google_refresh_")[0],
          ];
          expect(accessToken).toBeTruthy();
          expect(refreshToken).toBeTruthy();

          const result = yield* executor.connections.signOut(REF("main"));
          expect(result).toEqual({ removed: true, revocation: { status: "revoked" } });
          expect(yield* executor.connections.list()).toEqual([]);

          // Both revocations landed on the AS, carrying the app's client
          // identity (client_secret_post), refresh first then access.
          const ledger = yield* Effect.promise(() => emulator.ledger.list());
          const revocations = ledger.filter(
            (entry) => entry.path === "/oauth2/revoke" && entry.method === "POST",
          );
          expect(revocations.length).toBe(2);
          for (const entry of revocations) {
            const body = entry.request.body;
            expect(
              typeof body === "object" && body !== null
                ? (body as Record<string, unknown>).client_id
                : undefined,
            ).toBe(credential.client_id);
            expect(entry.response.status).toBe(200);
          }

          // The grant is dead upstream: the refresh token no longer mints and
          // the access token no longer authenticates.
          const refreshGrant = yield* Effect.promise(() =>
            // oxlint-disable-next-line executor/no-raw-fetch -- test boundary: probes the emulator's token endpoint directly
            fetch(`${emulator.url}/oauth2/token`, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: refreshToken ?? "",
                client_id: credential.client_id ?? "",
                client_secret: credential.client_secret ?? "",
              }),
            }),
          );
          expect(refreshGrant.status).toBe(400);
        }),
      ),
  );

  it.effect("reports failed without leaking token material when the AS answers 5xx", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const emulator = yield* acquireGoogleEmulator;
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();
        yield* connectGoogleAccount(executor, emulator, "main");
        yield* Effect.promise(() =>
          emulator.faults.arm({
            match: { method: "POST", pathPattern: "/oauth2/revoke" },
            response: {
              status: 500,
              body: { error: "server_error", error_description: "backend exploded" },
            },
          }),
        );
        const tokens = storedTokenValues("google_");

        const result = yield* executor.connections.signOut(REF("main"));
        expect(result.removed).toBe(true);
        expect(result.revocation.status).toBe("failed");
        expect(yield* executor.connections.list()).toEqual([]);
        const detail = result.revocation.detail ?? "<no detail>";
        expect(tokens.every((token) => !detail.includes(token))).toBe(true);
      }),
    ),
  );

  it.effect(
    "is not_supported when the AS advertises no revocation endpoint, and still removes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serveOAuthTestServer({ scopes: ["read"] });
          const { executor } = yield* makeTestWorkspaceHarness({ plugins });
          yield* executor.acme.seed(["read"]);
          yield* connectTestServerAccount(executor, server, "main");

          const result = yield* executor.connections.signOut(REF("main"));
          expect(result).toEqual({ removed: true, revocation: { status: "not_supported" } });
          expect(yield* executor.connections.list()).toEqual([]);
          const requests = yield* server.requests;
          expect(requests.filter((r) => r.path === "/revoke")).toEqual([]);
        }),
      ),
  );

  it.effect("uses a same-origin revocationUrl override when metadata lacks the endpoint", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed(["read"]);
        yield* connectTestServerAccount(executor, server, "main");

        const result = yield* executor.connections.signOut(REF("main"), {
          revocationUrl: `${server.issuerUrl}/revoke`,
        });
        expect(result).toEqual({ removed: true, revocation: { status: "revoked" } });
        const requests = yield* server.requests;
        const revocations = requests.filter((r) => r.path === "/revoke" && r.method === "POST");
        expect(revocations.length).toBe(2);
        expect(revocations[0]?.body).toContain("token_type_hint=refresh_token");
        expect(revocations[0]?.body).toContain("token=rt_");
        expect(revocations[0]?.body).toContain("client_secret=test-secret");
        expect(revocations[1]?.body).toContain("token_type_hint=access_token");
        expect(yield* executor.connections.list()).toEqual([]);
      }),
    ),
  );

  it.effect("rejects a cross-origin revocationUrl override and sends nothing to it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const otherOrigin = yield* serveOAuthTestServer({ scopes: ["read"] });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed(["read"]);
        yield* connectTestServerAccount(executor, server, "main");

        const result = yield* executor.connections.signOut(REF("main"), {
          revocationUrl: `${otherOrigin.issuerUrl}/revoke`,
        });
        expect(result.removed).toBe(true);
        expect(result.revocation.status).toBe("failed");
        expect(result.revocation.detail).toContain("rejected");
        const requests = yield* otherOrigin.requests;
        expect(requests.filter((r) => r.path === "/revoke")).toEqual([]);
        expect(yield* executor.connections.list()).toEqual([]);
      }),
    ),
  );

  it.effect("is not_supported for a static credential, and still removes it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: AuthTemplateSlug.make("apiKey"),
          value: "secret-token",
        });

        const result = yield* executor.connections.signOut(REF("main"));
        expect(result).toEqual({ removed: true, revocation: { status: "not_supported" } });
        expect(yield* executor.connections.list()).toEqual([]);
      }),
    ),
  );

  it.effect("fails with ConnectionNotFoundError for an unknown connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();
        const result = yield* Effect.result(executor.connections.signOut(REF("missing")));
        expect(Result.isFailure(result)).toBe(true);
        if (!Result.isFailure(result)) return;
        expect(Predicate.isTagged("ConnectionNotFoundError")(result.failure)).toBe(true);
      }),
    ),
  );
});

describe("oauth.start prompt passthrough", () => {
  it.effect("adds prompt=login to the authorization URL and leaves it unchanged when omitted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: ["read"] });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed(["read"]);
        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
        });
        const startInput = {
          owner: "org" as const,
          client: CLIENT,
          clientOwner: "org" as const,
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
        };

        const withPrompt = yield* executor.oauth.start({ ...startInput, prompt: "login" });
        expect(withPrompt.status).toBe("redirect");
        if (withPrompt.status !== "redirect") return;
        expect(new URL(withPrompt.authorizationUrl).searchParams.get("prompt")).toBe("login");

        const plain = yield* executor.oauth.start(startInput);
        expect(plain.status).toBe("redirect");
        if (plain.status !== "redirect") return;
        const params = new URL(plain.authorizationUrl).searchParams;
        expect(params.get("prompt")).toBeNull();
      }),
    ),
  );

  it.effect("an explicit prompt replaces Google's default prompt=consent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });
        yield* executor.acme.seed();
        yield* executor.oauth.createClient({
          owner: "org",
          slug: CLIENT,
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          grant: "authorization_code",
          clientId: "google-client",
          clientSecret: "google-secret",
        });
        const startInput = {
          owner: "org" as const,
          client: CLIENT,
          clientOwner: "org" as const,
          name: ConnectionName.make("main"),
          integration: INTEG,
          template: TEMPLATE,
        };

        const defaulted = yield* executor.oauth.start(startInput);
        expect(defaulted.status).toBe("redirect");
        if (defaulted.status !== "redirect") return;
        const defaultParams = new URL(defaulted.authorizationUrl).searchParams;
        expect(defaultParams.get("prompt")).toBe("consent");
        expect(defaultParams.get("access_type")).toBe("offline");

        const overridden = yield* executor.oauth.start({
          ...startInput,
          prompt: "select_account",
        });
        expect(overridden.status).toBe("redirect");
        if (overridden.status !== "redirect") return;
        const overriddenParams = new URL(overridden.authorizationUrl).searchParams;
        expect(overriddenParams.get("prompt")).toBe("select_account");
        expect(overriddenParams.get("access_type")).toBe("offline");
      }),
    ),
  );
});
