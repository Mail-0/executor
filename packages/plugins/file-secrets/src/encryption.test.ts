import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { ProviderItemId, type CredentialProvider } from "@executor-js/sdk";

import { makeFileSecretsProvider, type FileSecretsPluginConfig } from "./index";

const run = <A, E>(
  options: FileSecretsPluginConfig,
  body: (provider: CredentialProvider) => Effect.Effect<A, E>,
): Promise<A> => Effect.runPromise(body(makeFileSecretsProvider(options, FetchHttpClient.layer)));

const id = (value: string) => ProviderItemId.make(value);

describe("file secrets encryption at rest", () => {
  let dir: string;
  let server: Server | null = null;
  const authFile = () => join(dir, "auth.json");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "executor-file-secrets-enc-"));
  });

  afterEach(async () => {
    const open = server;
    server = null;
    if (open) await new Promise<void>((resolve) => open.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const options = (encryptionKey: string | null): FileSecretsPluginConfig => ({
    directory: dir,
    mirror: null,
    encryptionKey,
  });

  it("never writes credential values in plaintext and reads them back with the same key", async () => {
    await run(options("key-a"), (provider) => provider.set!(id("conn:access"), "secret-token-123"));

    const raw = readFileSync(authFile(), "utf-8");
    expect(raw).not.toContain("secret-token-123");
    expect(raw).not.toContain("conn:access");
    expect(statSync(authFile()).mode & 0o777).toBe(0o600);
    await expect(
      run(options("key-a"), (provider) => provider.get(id("conn:access"))),
    ).resolves.toBe("secret-token-123");
  });

  it("encrypts an existing plaintext file on first use without losing items", async () => {
    writeFileSync(authFile(), JSON.stringify({ "conn:access": "legacy-token" }), { mode: 0o600 });

    const value = await run(options("key-a"), (provider) => provider.get(id("conn:access")));

    expect(value).toBe("legacy-token");
    expect(readFileSync(authFile(), "utf-8")).not.toContain("legacy-token");
  });

  it("refuses a file it cannot decrypt and leaves it untouched when there is no mirror", async () => {
    await run(options("key-a"), (provider) => provider.set!(id("conn:access"), "secret-token-123"));
    const before = readFileSync(authFile(), "utf-8");

    const wrongKey = await Effect.runPromise(
      Effect.exit(
        makeFileSecretsProvider(options("key-b"), FetchHttpClient.layer).get(id("conn:access")),
      ),
    );
    const noKey = await Effect.runPromise(
      Effect.exit(
        makeFileSecretsProvider(options(null), FetchHttpClient.layer).get(id("conn:access")),
      ),
    );

    expect(Exit.isFailure(wrongKey)).toBe(true);
    expect(Exit.isFailure(noKey)).toBe(true);
    expect(readFileSync(authFile(), "utf-8")).toBe(before);
  });

  it("rebuilds an undecryptable file from the mirror under the new key", async () => {
    const items = new Map([["conn:access", "mirror-token"]]);
    const mirror = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/items") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items: Object.fromEntries(items) }));
      } else {
        res.writeHead(204).end();
      }
    });
    server = mirror;
    await new Promise<void>((resolve) => mirror.listen(0, "127.0.0.1", resolve));
    const { port } = mirror.address() as AddressInfo;
    await run(options("key-a"), (provider) => provider.set!(id("conn:access"), "old-token"));
    const withMirror = (encryptionKey: string): FileSecretsPluginConfig => ({
      directory: dir,
      mirror: { url: `http://127.0.0.1:${port}`, token: "t" },
      encryptionKey,
    });

    const value = await run(withMirror("key-b"), (provider) => provider.get(id("conn:access")));

    expect(value).toBe("mirror-token");
    expect(readFileSync(authFile(), "utf-8")).not.toContain("mirror-token");
    await expect(
      run(options("key-b"), (provider) => provider.get(id("conn:access"))),
    ).resolves.toBe("mirror-token");
  });
});
