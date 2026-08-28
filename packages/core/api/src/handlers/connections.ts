import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";

import { capture } from "@executor-js/api";
import {
  ConnectionNotFoundError,
  connectionNeedsReconsent,
  type AuthMethodDescriptor,
  type Connection,
  type ConnectionRef,
  type CreateConnectionInput,
  type HealthCheckResult,
  type IntegrationSlug,
  type Tool,
  type ValidateConnectionInput,
} from "@executor-js/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";

/** Reads the integration's declared auth methods once per slug — a list spans
 *  one integration in the common case, and a whole-catalog list would otherwise
 *  re-read the same row per connection. An integration removed mid-list reads
 *  as "declares nothing", which cannot flag a reconsent. */
const declaredAuthMethodsReader = Effect.gen(function* () {
  const executor = yield* ExecutorService;
  const cache = new Map<string, readonly AuthMethodDescriptor[]>();
  return (slug: IntegrationSlug) =>
    Effect.gen(function* () {
      const cached = cache.get(String(slug));
      if (cached !== undefined) return cached;
      const integration = yield* executor.integrations.get(slug);
      const methods = integration?.authMethods ?? [];
      cache.set(String(slug), methods);
      return methods;
    });
});

const toResponse = (c: Connection, authMethods: readonly AuthMethodDescriptor[]) => ({
  owner: c.owner,
  name: c.name,
  integration: c.integration,
  template: c.template,
  provider: c.provider,
  address: c.address,
  identityLabel: c.identityLabel ?? null,
  description: c.description ?? null,
  expiresAt: c.expiresAt ?? null,
  oauthClient: c.oauthClient ?? null,
  oauthClientOwner: c.oauthClientOwner ?? null,
  oauthScope: c.oauthScope ?? null,
  missingOAuthScopes: c.missingOAuthScopes ?? [],
  // Computed against the integration's CURRENT declarations, so a spec whose
  // scopes widened after this grant was minted is visible to headless callers
  // without re-deriving the comparison client-side.
  needsReconsent: connectionNeedsReconsent(
    {
      oauthClient: c.oauthClient ?? null,
      template: String(c.template),
      oauthScope: c.oauthScope ?? null,
      missingOAuthScopes: c.missingOAuthScopes ?? [],
    },
    authMethods,
  ),
  lastHealth: c.lastHealth ?? null,
});

const toolToResponse = (t: Tool) => ({
  address: String(t.address),
  owner: t.owner,
  integration: t.integration,
  connection: t.connection,
  name: String(t.name),
  pluginId: t.pluginId,
  description: t.description,
});

const toHealthResponse = (r: HealthCheckResult) => ({
  status: r.status,
  checkedAt: r.checkedAt,
  ...(r.httpStatus !== undefined ? { httpStatus: r.httpStatus } : {}),
  ...(r.identity !== undefined ? { identity: r.identity } : {}),
  ...(r.detail !== undefined ? { detail: r.detail } : {}),
  ...(r.responseSample !== undefined ? { responseSample: r.responseSample } : {}),
});

export const ConnectionsHandlers = HttpApiBuilder.group(ExecutorApi, "connections", (handlers) =>
  handlers
    .handle("list", ({ query }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const authMethodsFor = yield* declaredAuthMethodsReader;
          const connections = yield* executor.connections.list({
            integration: query.integration,
            owner: query.owner,
          });
          return yield* Effect.forEach(connections, (connection: Connection) =>
            Effect.map(authMethodsFor(connection.integration), (methods) =>
              toResponse(connection, methods),
            ),
          );
        }),
      ),
    )
    .handle("create", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          // The payload is the discriminated `CreateConnectionInput` union
          // (`{ value }` | `{ values }` | `{ from }`); pass it through verbatim.
          const created = yield* executor.connections.create(payload as CreateConnectionInput);
          const authMethodsFor = yield* declaredAuthMethodsReader;
          return toResponse(created, yield* authMethodsFor(created.integration));
        }),
      ),
    )
    .handle("get", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const ref: ConnectionRef = {
            owner: path.owner,
            integration: path.integration,
            name: path.name,
          };
          const connection = yield* executor.connections.get(ref);
          if (connection === null) {
            return yield* new ConnectionNotFoundError({
              owner: path.owner,
              integration: path.integration,
              name: path.name,
            });
          }
          const authMethodsFor = yield* declaredAuthMethodsReader;
          return toResponse(connection, yield* authMethodsFor(connection.integration));
        }),
      ),
    )
    .handle("update", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const updated = yield* executor.connections.update(
            {
              owner: path.owner,
              integration: path.integration,
              name: path.name,
            },
            {
              ...(payload.description !== undefined ? { description: payload.description } : {}),
              ...(payload.identityLabel !== undefined
                ? { identityLabel: payload.identityLabel }
                : {}),
            },
          );
          const authMethodsFor = yield* declaredAuthMethodsReader;
          return toResponse(updated, yield* authMethodsFor(updated.integration));
        }),
      ),
    )
    .handle("remove", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          yield* executor.connections.remove({
            owner: path.owner,
            integration: path.integration,
            name: path.name,
          });
          return { removed: true };
        }),
      ),
    )
    .handle("refresh", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const tools = yield* executor.connections.refresh({
            owner: path.owner,
            integration: path.integration,
            name: path.name,
          });
          return tools.map(toolToResponse);
        }),
      ),
    )
    .handle("checkHealth", ({ params: path, query }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const result = yield* executor.connections.checkHealth(
            {
              owner: path.owner,
              integration: path.integration,
              name: path.name,
            },
            query.ifStaleMs !== undefined ? { ifStaleMs: query.ifStaleMs } : undefined,
          );
          return toHealthResponse(result);
        }),
      ),
    )
    .handle("validate", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          // The payload mirrors `ValidateConnectionInput`: owner/integration/
          // template/spec plus a single credential origin (`value` | `values` |
          // `from`). Pass it through verbatim.
          const result = yield* executor.connections.validate(payload as ValidateConnectionInput);
          return toHealthResponse(result);
        }),
      ),
    ),
);
