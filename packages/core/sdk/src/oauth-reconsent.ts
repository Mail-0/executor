// ---------------------------------------------------------------------------
// Reconsent — whether an existing OAuth connection must re-run the flow to
// grant access the integration has come to declare since the grant was minted.
//
// The comparison is deliberately NOT declared-vs-granted. A provider that
// narrows a grant to the user's actual access is healthy (Google hands back a
// subset for a scope the project has not enabled; a spec-derived catalog can
// declare hundreds of scopes no single user holds), so declared-vs-granted
// flags such a connection forever and the prompt becomes noise.
//
// What is actionable is a scope the grant never even ASKED for — a declaration
// that changed after the fact (a widened spec, a service added, a re-derived
// oauth template). A connection records both halves of its request: `oauthScope`
// is what the authorization server granted and `missingOAuthScopes` is what was
// requested and withheld, so their union reconstructs the request itself.
// ---------------------------------------------------------------------------

import type { AuthMethodDescriptor } from "./integration";
import { missingGrantedOAuthScopes } from "./oauth-service";

/** The connection fields reconsent reads. Kept structural so callers can pass a
 *  `Connection`, a storage row projection, or an API response. */
export interface ReconsentConnectionView {
  /** The OAuth app that minted the connection; null/absent for static creds. */
  readonly oauthClient?: string | null;
  /** The auth template the connection binds against — selects which of the
   *  integration's declared methods governs it. */
  readonly template: string;
  /** Space-delimited granted scope, as recorded by the token response. */
  readonly oauthScope?: string | null;
  /** Requested-but-withheld scopes, recorded when the grant was minted. */
  readonly missingOAuthScopes?: readonly string[];
}

/** The scopes the connection's authorization request covered: granted plus
 *  requested-and-withheld. A grant minted before `missingOAuthScopes` was
 *  recorded contributes only what it was granted, which is the conservative
 *  reading — such a connection reconsents once and is then accurate. */
export const requestedOAuthScopesForConnection = (
  connection: ReconsentConnectionView,
): readonly string[] => [
  ...(connection.oauthScope?.split(/\s+/).filter(Boolean) ?? []),
  ...(connection.missingOAuthScopes ?? []),
];

/** Declared scopes the connection's authorization request never covered.
 *  Canonicalization (Graph resource prefixes, Google OIDC aliases, `.default`,
 *  informational scopes) is the same one the OAuth completion path applies, so
 *  a connection is never asked to reconsent for a scope it holds under another
 *  spelling. */
export const unrequestedDeclaredOAuthScopes = (
  declaredScopes: readonly string[],
  connection: ReconsentConnectionView,
): readonly string[] =>
  missingGrantedOAuthScopes(
    declaredScopes,
    requestedOAuthScopesForConnection(connection).join(" "),
  );

/** The integration's oauth method governing this connection, or undefined when
 *  the connection binds a non-oauth method (an api key) or a method the
 *  integration no longer declares. */
const governingOAuthMethod = (
  connection: ReconsentConnectionView,
  authMethods: readonly AuthMethodDescriptor[],
): AuthMethodDescriptor | undefined => {
  const method = authMethods.find(
    (candidate: AuthMethodDescriptor) => candidate.template === connection.template,
  );
  return method !== undefined && method.kind === "oauth" ? method : undefined;
};

/** Whether the connection must RECONNECT to cover the scopes its integration
 *  now declares. False for a static credential, for a connection whose method
 *  is not oauth or is no longer declared, and whenever the original request
 *  already covered every declared scope. */
export const connectionNeedsReconsent = (
  connection: ReconsentConnectionView,
  authMethods: readonly AuthMethodDescriptor[],
): boolean => {
  if (connection.oauthClient == null) return false;
  const method = governingOAuthMethod(connection, authMethods);
  if (method === undefined) return false;
  const declared = method.oauth?.scopes ?? [];
  return declared.length > 0 && unrequestedDeclaredOAuthScopes(declared, connection).length > 0;
};
