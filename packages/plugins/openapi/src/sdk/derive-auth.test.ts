import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { AuthTemplateSlug } from "@executor-js/sdk/core";

import { rederiveOAuthScopes, resolvedOAuthScopes } from "./derive-auth";
import { OAuth2Preset } from "./preview";
import type { Authentication } from "./types";

describe("resolvedOAuthScopes", () => {
  it("does not synthesize OIDC scopes for a plain OAuth provider", () => {
    expect(resolvedOAuthScopes(["current_user:read", "files:read"], "auto")).toEqual([
      "current_user:read",
      "files:read",
    ]);
  });

  it("preserves advertised OIDC scopes in auto mode", () => {
    expect(resolvedOAuthScopes(["read", "openid", "profile"], "auto")).toEqual([
      "read",
      "openid",
      "profile",
    ]);
  });

  it("merges explicitly configured identity scopes", () => {
    expect(resolvedOAuthScopes(["read", "email"], ["openid", "email"])).toEqual([
      "read",
      "email",
      "openid",
    ]);
  });
});

const preset = (securitySchemeName: string, scopes: readonly string[]): OAuth2Preset => ({
  label: `OAuth2 — ${securitySchemeName}`,
  securitySchemeName,
  flow: "authorizationCode",
  authorizationUrl: Option.some("https://example.com/authorize"),
  tokenUrl: "https://example.com/token",
  resource: Option.none(),
  refreshUrl: Option.none(),
  scopes: Object.fromEntries(scopes.map((scope) => [scope, scope])),
  identityScopes: "auto",
});

const oauthTemplate = (schemeName: string, scopes: readonly string[]): Authentication => ({
  slug: AuthTemplateSlug.make(`oauth-${schemeName}`),
  kind: "oauth2",
  authorizationUrl: "https://example.com/authorize",
  tokenUrl: "https://example.com/token",
  resource: null,
  scopes: [...scopes],
});

const apiKeyTemplate: Authentication = {
  slug: AuthTemplateSlug.make("custom_key"),
  kind: "apikey",
  placements: [{ carrier: "header", name: "X-Api-Key" }],
};

describe("rederiveOAuthScopes", () => {
  it("narrows a template to the scopes the new spec declares", () => {
    const result = rederiveOAuthScopes(
      [oauthTemplate("google", ["https://mail.google.com/", "gmail.send"])],
      [preset("google", ["gmail.readonly", "gmail.send"])],
    );

    expect(result.changed).toBe(true);
    expect(result.addedScopes).toEqual(["gmail.readonly"]);
    expect(result.removedScopes).toEqual(["https://mail.google.com/"]);
    expect(result.templates[0]).toMatchObject({
      slug: "oauth-google",
      scopes: ["gmail.readonly", "gmail.send"],
    });
  });

  it("widens a template and leaves everything but scopes alone", () => {
    const before = oauthTemplate("google", ["gmail.readonly"]);
    const result = rederiveOAuthScopes(
      [before],
      [preset("google", ["gmail.readonly", "calendar.events"])],
    );

    expect(result.addedScopes).toEqual(["calendar.events"]);
    expect(result.removedScopes).toEqual([]);
    expect(result.templates[0]).toEqual({
      ...before,
      scopes: ["gmail.readonly", "calendar.events"],
    });
  });

  it("reports no change when the declared scope set is the same", () => {
    const templates = [oauthTemplate("google", ["b", "a"])];
    const result = rederiveOAuthScopes(templates, [preset("google", ["a", "b"])]);

    expect(result.changed).toBe(false);
    expect(result.addedScopes).toEqual([]);
    expect(result.removedScopes).toEqual([]);
    // Same array identity: an unchanged re-derivation must not rewrite config.
    expect(result.templates).toBe(templates);
  });

  it("re-derives each oauth scheme independently and keeps apiKey methods", () => {
    const result = rederiveOAuthScopes(
      [oauthTemplate("mail", ["mail.rw"]), apiKeyTemplate, oauthTemplate("cal", ["cal.rw"])],
      [preset("mail", ["mail.read"]), preset("cal", ["cal.rw", "cal.free_busy"])],
    );

    expect(result.addedScopes).toEqual(["cal.free_busy", "mail.read"]);
    expect(result.removedScopes).toEqual(["mail.rw"]);
    expect(result.templates.map((t) => t.kind)).toEqual(["oauth2", "apikey", "oauth2"]);
    expect(result.templates[0]).toMatchObject({ scopes: ["mail.read"] });
    expect(result.templates[1]).toEqual(apiKeyTemplate);
    expect(result.templates[2]).toMatchObject({ scopes: ["cal.rw", "cal.free_busy"] });
  });

  it("leaves a template whose scheme the new spec dropped untouched", () => {
    const templates = [oauthTemplate("google", ["gmail.readonly"])];
    const result = rederiveOAuthScopes(templates, []);

    expect(result.changed).toBe(false);
    expect(result.templates).toBe(templates);
  });

  it("leaves a hand-configured template whose slug is not spec-derived", () => {
    const custom: Authentication = {
      ...oauthTemplate("google", ["gmail.readonly"]),
      slug: AuthTemplateSlug.make("custom_oauth"),
    };
    const result = rederiveOAuthScopes([custom], [preset("google", ["gmail.send"])]);

    expect(result.changed).toBe(false);
    expect(result.templates[0]).toEqual(custom);
  });
});
