import { describe, expect, it } from "@effect/vitest";

import type { AuthMethodDescriptor } from "./integration";
import {
  connectionNeedsReconsent,
  requestedOAuthScopesForConnection,
  unrequestedDeclaredOAuthScopes,
  type ReconsentConnectionView,
} from "./oauth-reconsent";

const GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
const CALENDAR = "https://www.googleapis.com/auth/calendar.events";

const oauthMethod = (
  scopes: readonly string[],
  template = "oauth-google",
): AuthMethodDescriptor => ({
  id: template,
  label: "OAuth2",
  kind: "oauth",
  template,
  oauth: {
    authorizationUrl: "https://accounts.google.test/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.google.test/token",
    scopes,
  },
});

const apiKeyMethod = (template = "custom_key"): AuthMethodDescriptor => ({
  id: template,
  label: "API key",
  kind: "apikey",
  template,
  placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
});

const connection = (over: Partial<ReconsentConnectionView> = {}): ReconsentConnectionView => ({
  oauthClient: "google-app",
  template: "oauth-google",
  oauthScope: `${GMAIL_READ} ${GMAIL_SEND}`,
  missingOAuthScopes: [],
  ...over,
});

describe("requestedOAuthScopesForConnection", () => {
  it("reconstructs the request from what was granted plus what was withheld", () => {
    expect(
      requestedOAuthScopesForConnection(
        connection({ oauthScope: GMAIL_READ, missingOAuthScopes: [GMAIL_SEND] }),
      ),
    ).toEqual([GMAIL_READ, GMAIL_SEND]);
  });

  it("reads a grant recorded before withheld scopes were persisted", () => {
    expect(
      requestedOAuthScopesForConnection({ template: "oauth-google", oauthScope: GMAIL_READ }),
    ).toEqual([GMAIL_READ]);
  });
});

describe("unrequestedDeclaredOAuthScopes", () => {
  it("names the declared scope the request never covered", () => {
    expect(
      unrequestedDeclaredOAuthScopes([GMAIL_READ, GMAIL_SEND, CALENDAR], connection()),
    ).toEqual([CALENDAR]);
  });

  it("counts a withheld scope as requested, so a narrowing provider is not a gap", () => {
    expect(
      unrequestedDeclaredOAuthScopes(
        [GMAIL_READ, GMAIL_SEND],
        connection({ oauthScope: GMAIL_READ, missingOAuthScopes: [GMAIL_SEND] }),
      ),
    ).toEqual([]);
  });

  it("treats Google's OIDC shorthand and its expanded People scope as one grant", () => {
    expect(
      unrequestedDeclaredOAuthScopes(["https://www.googleapis.com/auth/userinfo.email"], {
        template: "oauth-google",
        oauthScope: "email",
      }),
    ).toEqual([]);
  });

  it("ignores a Graph resource prefix the token endpoint added", () => {
    expect(
      unrequestedDeclaredOAuthScopes(["Mail.Read"], {
        template: "oauth-ms",
        oauthScope: "https://graph.microsoft.com/Mail.Read",
      }),
    ).toEqual([]);
  });
});

describe("connectionNeedsReconsent", () => {
  it("flags a connection whose integration declares a newly added scope", () => {
    expect(
      connectionNeedsReconsent(connection(), [oauthMethod([GMAIL_READ, GMAIL_SEND, CALENDAR])]),
    ).toBe(true);
  });

  it("leaves a connection alone when its request covered every declared scope", () => {
    expect(connectionNeedsReconsent(connection(), [oauthMethod([GMAIL_READ, GMAIL_SEND])])).toBe(
      false,
    );
  });

  it("leaves a connection alone when the declarations NARROWED", () => {
    expect(connectionNeedsReconsent(connection(), [oauthMethod([GMAIL_READ])])).toBe(false);
  });

  it("never flags a static credential, whatever the declarations say", () => {
    expect(
      connectionNeedsReconsent(connection({ oauthClient: null, oauthScope: null }), [
        oauthMethod([GMAIL_READ, GMAIL_SEND, CALENDAR]),
      ]),
    ).toBe(false);
  });

  it("never flags a connection bound to a non-oauth method", () => {
    expect(
      connectionNeedsReconsent(connection({ template: "custom_key" }), [
        apiKeyMethod(),
        oauthMethod([GMAIL_READ, GMAIL_SEND, CALENDAR]),
      ]),
    ).toBe(false);
  });

  it("reads only the method the connection is bound to", () => {
    expect(
      connectionNeedsReconsent(connection(), [
        oauthMethod([GMAIL_READ, GMAIL_SEND]),
        oauthMethod([CALENDAR], "custom_second"),
      ]),
    ).toBe(false);
  });

  it("stays quiet when the integration no longer declares the bound method", () => {
    expect(connectionNeedsReconsent(connection(), [oauthMethod([CALENDAR], "oauth-other")])).toBe(
      false,
    );
  });

  it("stays quiet when the integration declares no scopes at all", () => {
    expect(connectionNeedsReconsent(connection(), [oauthMethod([])])).toBe(false);
  });
});
