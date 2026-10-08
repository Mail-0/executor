import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";

import { FetchHttpClient } from "effect/unstable/http";

import { ProviderItemId, type CredentialProvider } from "@executor-js/sdk";

import { makeFileSecretsProvider, type FileSecretsPluginConfig } from "./index";
const TOKEN = "mirror-token";

interface MirrorServer {
  readonly url: string;
  readonly items: Map<string, string>;
  readonly requests: string[];
  failing: boolean;
  readonly close: () => Promise<void>;
}

const startMirror = async (initial: Record<string, string> = {}): Promise<MirrorServer> => {
  const items = new Map(Object.entries(initial));
  const requests: string[] = [];
  const state = { failing: false };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf-8")));
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end();
        return;
      }
      if (state.failing) {
        res.writeHead(503).end();
        return;
      }
      const match = /^\/items(?:\/(.+))?$/.exec(req.url ?? "");
      const id = match?.[1] ? decodeURIComponent(match[1]) : null;
      if (req.method === "GET" && match && id === null) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items: Object.fromEntries(items) }));
      } else if (req.method === "PUT" && id !== null) {
        items.set(id, decodePut(body).value);
        res.writeHead(204).end();
      } else if (req.method === "DELETE" && id !== null) {
        items.delete(id);
        res.writeHead(204).end();
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    items,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
};

const decodeAuth = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);
const decodePut = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ value: Schema.String })),
);

const run = <A, E>(
  options: FileSecretsPluginConfig,
  body: (provider: CredentialProvider) => Effect.Effect<A, E>,
): Promise<A> => Effect.runPromise(body(makeFileSecretsProvider(options, FetchHttpClient.layer)));

const id = (value: string) => ProviderItemId.make(value);

const readAuth = (dir: string): Record<string, string> =>
  decodeAuth(readFileSync(join(dir, "auth.json"), "utf-8"));

describe("file secrets durable mirror", () => {
  let dir: string;
  let mirror: MirrorServer;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "executor-file-secrets-mirror-"));
    mirror = await startMirror();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await mirror.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const options = (): FileSecretsPluginConfig => ({
    directory: dir,
    mirror: { url: mirror.url, token: TOKEN },
  });

  it("writes every set and delete through to the mirror", async () => {
    await run(options(), (provider) =>
      Effect.gen(function* () {
        yield* provider.set!(id("conn:refresh"), "rt-1");
        yield* provider.set!(id("conn:refresh"), "rt-2");
        yield* provider.set!(id("other"), "x");
        yield* provider.delete!(id("other"));
      }),
    );
    expect(Object.fromEntries(mirror.items)).toEqual({ "conn:refresh": "rt-2" });
    expect(readAuth(dir)).toEqual({ "conn:refresh": "rt-2" });
  });

  it("prefers the mirror over a stale local file and seeds local-only items", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ "conn:refresh": "consumed", "local-only": "keep" }),
    );
    mirror.items.set("conn:refresh", "rotated");

    const value = await run(options(), (provider) => provider.get(id("conn:refresh")));

    expect(value).toBe("rotated");
    expect(readAuth(dir)).toEqual({ "conn:refresh": "rotated", "local-only": "keep" });
    expect(Object.fromEntries(mirror.items)).toEqual({
      "conn:refresh": "rotated",
      "local-only": "keep",
    });
  });

  it("keeps a write made while the mirror is down and pushes it once it is back", async () => {
    mirror.failing = true;
    const now = Date.now();
    await run(options(), (provider) =>
      Effect.gen(function* () {
        yield* provider.set!(id("conn:refresh"), "rt-new");
        expect(readAuth(dir)).toEqual({ "conn:refresh": "rt-new" });
        expect(mirror.items.size).toBe(0);

        mirror.failing = false;
        mirror.items.set("conn:refresh", "rt-old");
        vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
        const value = yield* provider.get(id("conn:refresh"));
        expect(value).toBe("rt-new");
      }),
    );
    expect(Object.fromEntries(mirror.items)).toEqual({ "conn:refresh": "rt-new" });
    expect(readAuth(dir)).toEqual({ "conn:refresh": "rt-new" });
  });

  it("makes no requests when the mirror is disabled", async () => {
    await run({ directory: dir, mirror: null }, (provider) => provider.set!(id("a"), "1"));
    expect(readAuth(dir)).toEqual({ a: "1" });
    expect(mirror.requests).toEqual([]);
  });
});
