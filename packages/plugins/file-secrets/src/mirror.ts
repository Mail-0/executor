import { Effect, Layer, Predicate, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

// ---------------------------------------------------------------------------
// Durable mirror for the file credential provider.
//
// On disposable hosts (a cloud sandbox that is deleted and later rebuilt from
// an older backup) auth.json does not outlive the machine. A provider that
// rotates refresh tokens then sees the restored, already-consumed token and
// answers `invalid_grant`. The mirror is an HTTP store owned by the host that
// receives every write the moment it happens and is the source of truth when
// the provider first starts.
//
//   GET    {url}/items        -> { "items": { "<item id>": "<value>" } }
//   PUT    {url}/items/{id}   <- { "value": "<value>" }
//   DELETE {url}/items/{id}
//
// Every request carries `Authorization: Bearer <token>`.
// ---------------------------------------------------------------------------

export interface SecretsMirrorConfig {
  readonly url: string;
  readonly token: string;
}

/** `null` disables the mirror; `undefined` reads EXECUTOR_SECRETS_MIRROR_URL/_TOKEN. */
export const resolveSecretsMirror = (
  configured: SecretsMirrorConfig | null | undefined,
): SecretsMirrorConfig | null => {
  const url = configured === undefined ? process.env.EXECUTOR_SECRETS_MIRROR_URL : configured?.url;
  const token =
    configured === undefined ? process.env.EXECUTOR_SECRETS_MIRROR_TOKEN : configured?.token;
  const trimmedUrl = url?.trim().replace(/\/+$/, "");
  const trimmedToken = token?.trim();
  return trimmedUrl && trimmedToken ? { url: trimmedUrl, token: trimmedToken } : null;
};

export class SecretsMirrorError extends Schema.TaggedErrorClass<SecretsMirrorError>()(
  "SecretsMirrorError",
  {
    operation: Schema.String,
    status: Schema.NullOr(Schema.Number),
  },
  {
    description:
      "The durable secrets mirror could not be reached or rejected a request. The local auth file is still authoritative for the running process; the write is retried later.",
  },
) {
  override get message(): string {
    return this.status === null
      ? `Secrets mirror ${this.operation} failed: mirror unreachable`
      : `Secrets mirror ${this.operation} failed with status ${this.status}`;
  }
}

const MirrorItems = Schema.Struct({ items: Schema.Record(Schema.String, Schema.String) });
const decodeMirrorItems = Schema.decodeUnknownEffect(MirrorItems);

const REQUEST_TIMEOUT = "5 seconds";
const RETRY = Schedule.both(Schedule.exponential("200 millis"), Schedule.recurs(1));

export const makeSecretsMirrorClient = (
  config: SecretsMirrorConfig,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient>,
) => {
  const send = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client
        .execute(HttpClientRequest.bearerToken(request, config.token))
        .pipe(
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.mapError(() => new SecretsMirrorError({ operation, status: null })),
        );
      if (response.status < 200 || response.status >= 300) {
        return yield* new SecretsMirrorError({ operation, status: response.status });
      }
      return response;
    }).pipe(Effect.retry(RETRY), Effect.provide(httpClientLayer));

  const itemUrl = (id: string): string => `${config.url}/items/${encodeURIComponent(id)}`;

  return {
    list: send("list", HttpClientRequest.get(`${config.url}/items`)).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decodeMirrorItems),
      Effect.map((body): Record<string, string> => ({ ...body.items })),
      Effect.mapError((error) =>
        Predicate.isTagged(error, "SecretsMirrorError")
          ? error
          : new SecretsMirrorError({ operation: "list", status: null }),
      ),
    ),
    put: (id: string, value: string) =>
      send(
        "put",
        HttpClientRequest.make("PUT")(itemUrl(id)).pipe(
          HttpClientRequest.bodyJsonUnsafe({ value }),
        ),
      ).pipe(Effect.asVoid),
    remove: (id: string) =>
      send("delete", HttpClientRequest.make("DELETE")(itemUrl(id))).pipe(Effect.asVoid),
  };
};

export type SecretsMirrorClient = ReturnType<typeof makeSecretsMirrorClient>;
