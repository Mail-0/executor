// ---------------------------------------------------------------------------
// OpenAPI plugin — `updateSpec({ rederiveOAuthScopes: true })`.
//
// `addSpec` freezes the security scheme's declared scopes into the stored oauth
// template, and the connect flow reads the template, not the spec. So an
// integration whose spec later narrows (or widens) its scopes keeps asking
// consent for the original set unless the update is told to re-derive. These
// tests drive the extension method the HTTP handler calls:
//   - narrowing rewrites the stored template and reports the scope diff,
//   - the opt-in is required: without it the template is left alone,
//   - widening reports the newly declared scope,
//   - a spec change that leaves scopes alone reports empty diffs,
//   - re-derivation touches scopes only: apiKey methods, base URL, curated
//     description and existing connections all survive.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import {
  createExecutor,
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { openApiPlugin } from "./plugin";
import type { AuthenticationInput } from "./types";
import { makeOpenApiTestSpecJson } from "../testing";

const testPlugins = () =>
  [openApiPlugin({ httpClientLayer: FetchHttpClient.layer }), memoryCredentialsPlugin()] as const;

const BASE_URL = "https://api.example.test";

const MailGroup = HttpApiGroup.make("mail").add(
  HttpApiEndpoint.get("listMessages", "/messages", { success: Schema.Unknown }),
);
const TestApi = HttpApi.make("scopedApi").add(MailGroup);

/** The same API, with an oauth2 security scheme declaring `scopes`. */
const specWithScopes = (
  scopes: readonly string[],
  options: { readonly extraPath?: boolean } = {},
) =>
  makeOpenApiTestSpecJson(TestApi, {
    baseUrl: BASE_URL,
    transformSpec: (spec) => ({
      ...spec,
      ...(options.extraPath === true
        ? {
            paths: {
              ...(spec.paths as Record<string, unknown>),
              "/labels": {
                get: {
                  operationId: "mail/listLabels",
                  responses: { "200": { description: "ok" } },
                },
              },
            },
          }
        : {}),
      components: {
        securitySchemes: {
          google: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: "https://accounts.google.test/o/oauth2/v2/auth",
                tokenUrl: "https://oauth2.google.test/token",
                scopes: Object.fromEntries(scopes.map((scope) => [scope, scope])),
              },
            },
          },
        },
      },
    }),
  });

const apiKeyTemplate: AuthenticationInput = {
  slug: "apiKey",
  type: "apiKey",
  headers: { "X-Api-Key": "{{token}}" },
};

const addScopedIntegration = (scopes: readonly string[]) =>
  Effect.gen(function* () {
    const executor = yield* createExecutor(makeTestConfig({ plugins: testPlugins() }));
    yield* executor.openapi.addSpec({
      spec: { kind: "blob", value: specWithScopes(scopes) },
      slug: "scoped",
      description: "curated by hand",
      baseUrl: BASE_URL,
    });
    return executor;
  });

const oauthScopesOf = (
  config: { readonly authenticationTemplate?: readonly { readonly slug: unknown }[] } | null,
) => {
  const template = config?.authenticationTemplate?.find((a) => String(a.slug) === "oauth-google");
  return (template as { readonly scopes?: readonly string[] } | undefined)?.scopes;
};

describe("updateSpec OAuth scope re-derivation", () => {
  it.effect("narrows the stored template to the new spec's scopes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* addScopedIntegration(["https://mail.google.test/", "gmail.send"]);
        expect(oauthScopesOf(yield* executor.openapi.getConfig("scoped"))).toEqual([
          "https://mail.google.test/",
          "gmail.send",
        ]);

        const result = yield* executor.openapi.updateSpec("scoped", {
          spec: { kind: "blob", value: specWithScopes(["gmail.readonly", "gmail.send"]) },
          rederiveOAuthScopes: true,
        });

        expect(result.addedScopes).toEqual(["gmail.readonly"]);
        expect(result.removedScopes).toEqual(["https://mail.google.test/"]);
        expect(oauthScopesOf(yield* executor.openapi.getConfig("scoped"))).toEqual([
          "gmail.readonly",
          "gmail.send",
        ]);
      }),
    ),
  );

  it.effect("leaves the template frozen when re-derivation is not requested", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* addScopedIntegration(["https://mail.google.test/"]);

        const result = yield* executor.openapi.updateSpec("scoped", {
          spec: { kind: "blob", value: specWithScopes(["gmail.readonly"]) },
        });

        expect(result.addedScopes).toEqual([]);
        expect(result.removedScopes).toEqual([]);
        expect(oauthScopesOf(yield* executor.openapi.getConfig("scoped"))).toEqual([
          "https://mail.google.test/",
        ]);
      }),
    ),
  );

  it.effect("reports a widened scope set", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* addScopedIntegration(["gmail.readonly"]);

        const result = yield* executor.openapi.updateSpec("scoped", {
          spec: {
            kind: "blob",
            value: specWithScopes(["gmail.readonly", "calendar.events"]),
          },
          rederiveOAuthScopes: true,
        });

        expect(result.addedScopes).toEqual(["calendar.events"]);
        expect(result.removedScopes).toEqual([]);
        expect(oauthScopesOf(yield* executor.openapi.getConfig("scoped"))).toEqual([
          "gmail.readonly",
          "calendar.events",
        ]);
      }),
    ),
  );

  it.effect("reports empty diffs when only the operations changed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* addScopedIntegration(["gmail.readonly"]);

        const result = yield* executor.openapi.updateSpec("scoped", {
          spec: {
            kind: "blob",
            value: specWithScopes(["gmail.readonly"], { extraPath: true }),
          },
          rederiveOAuthScopes: true,
        });

        expect(result.addedTools).toEqual(["labels.mailListLabels"]);
        expect(result.addedScopes).toEqual([]);
        expect(result.removedScopes).toEqual([]);
        expect(oauthScopesOf(yield* executor.openapi.getConfig("scoped"))).toEqual([
          "gmail.readonly",
        ]);
      }),
    ),
  );

  it.effect("rewrites scopes only: other methods, config and connections survive", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* addScopedIntegration(["https://mail.google.test/"]);
        // A user-configured method alongside the spec-derived oauth one.
        yield* executor.openapi.configure("scoped", {
          authenticationTemplate: [apiKeyTemplate],
          mode: "merge",
        });
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("scoped"),
          template: AuthTemplateSlug.make("apiKey"),
          value: "secret-key-123",
        });

        yield* executor.openapi.updateSpec("scoped", {
          spec: { kind: "blob", value: specWithScopes(["gmail.readonly"]) },
          rederiveOAuthScopes: true,
        });

        const config = yield* executor.openapi.getConfig("scoped");
        expect(config?.authenticationTemplate?.map((a) => String(a.slug))).toEqual([
          "oauth-google",
          "apiKey",
        ]);
        expect(oauthScopesOf(config)).toEqual(["gmail.readonly"]);
        expect(config?.baseUrl).toBe(BASE_URL);
        const integration = yield* executor.openapi.getIntegration("scoped");
        expect(integration?.description).toBe("curated by hand");
        const connections = yield* executor.connections.list({
          integration: IntegrationSlug.make("scoped"),
        });
        expect(connections.map((c) => String(c.name))).toEqual(["main"]);
      }),
    ),
  );
});
