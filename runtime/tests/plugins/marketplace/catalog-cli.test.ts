import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildMarketplaceCatalog,
  marketplacePluginSupportsProduct,
  parseQualifiedMarketplacePluginId,
  resolveMarketplaceInstallTarget,
  ensureOfficialMarketplace,
  refreshStaleMarketplaces,
  OFFICIAL_MARKETPLACE_NAME,
  OFFICIAL_MARKETPLACE_REFRESH_MS,
  OFFICIAL_MARKETPLACE_URL,
} from "./catalog-cli.js";
import { addMarketplaceOp, upgradeMarketplaceOp, readMarketplaceIndex } from "./marketplace.js";
import { pluginSignaturePayloadBytes } from "../resolution.js";
import { pluginListWithCatalog } from "../cli/pluginCliCommands.js";

async function tempRuntime(): Promise<{
  readonly root: string;
  readonly pluginStorageRoot: string;
  readonly workspaceRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agenc-marketplace-catalog-"));
  const pluginStorageRoot = join(root, "plugin-storage");
  const workspaceRoot = join(root, "workspace");
  await mkdir(pluginStorageRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  return { root, pluginStorageRoot, workspaceRoot };
}

async function writePlugin(
  root: string,
  name: string,
  options: { readonly logo?: boolean } = {},
): Promise<void> {
  const pluginRoot = join(root, name);
  await mkdir(join(pluginRoot, ".agenc-plugin"), { recursive: true });
  if (options.logo === true) {
    await mkdir(join(pluginRoot, "assets"), { recursive: true });
    await writeFile(join(pluginRoot, "assets", "logo.png"), "png-bytes");
  }
  await writeFile(
    join(pluginRoot, ".agenc-plugin", "plugin.json"),
    `${JSON.stringify({
      name,
      version: "1.0.0",
      description: `${name} plugin`,
      commands: "./commands",
      ...(options.logo === true
        ? { interface: { displayName: name, logo: "./assets/logo.png" } }
        : {}),
    }, null, 2)}\n`,
  );
  await mkdir(join(pluginRoot, "commands"), { recursive: true });
  await writeFile(join(pluginRoot, "commands", "hello.md"), "# Hello\n");
}

async function writeMarketplace(root: string): Promise<string> {
  await writePlugin(root, "desktop-only", { logo: true });
  await writePlugin(root, "everywhere");
  await writePlugin(root, "hidden");
  await writePlugin(root, "nobody");
  await mkdir(join(root, ".agenc-plugin"), { recursive: true });
  await writeFile(
    join(root, ".agenc-plugin", "marketplace.json"),
    `${JSON.stringify({
      metadata: { name: "team", displayName: "Team Marketplace" },
      plugins: [
        {
          name: "desktop-only",
          source: "./desktop-only",
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_USE",
            products: ["desktop"],
          },
        },
        {
          name: "everywhere",
          source: "./everywhere",
          policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        },
        {
          name: "hidden",
          source: "./hidden",
          policy: { installation: "NOT_AVAILABLE", authentication: "ON_USE" },
        },
        {
          name: "nobody",
          source: "./nobody",
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_USE",
            products: [],
          },
        },
      ],
    }, null, 2)}\n`,
  );
  return root;
}

async function remoteAdvertFixture(manifestText: string, trusted = false) {
  const base = await tempRuntime();
  const market = join(base.root, "remote-market");
  await mkdir(join(market, ".agenc-plugin"), { recursive: true });
  await writeFile(join(market, ".agenc-plugin", "marketplace.json"), JSON.stringify({
    metadata: { name: "team" }, plugins: [{ name: "remote",
      source: { source: "git", url: "https://github.com/team/plugins.git", sha: "a".repeat(40) },
      policy: { installation: "AVAILABLE", authentication: "ON_USE" } }],
  }));
  await addMarketplaceOp({ ...base, source: market, name: "team" });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  if (trusted) await writeFile(join(base.root, "plugin-publishers.json"), JSON.stringify({ publishers: {
    team: { publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64") },
  } }));
  let manifest = Buffer.from(manifestText);
  let signature = Buffer.from(JSON.stringify({ publisher: "team", files: {},
    signature: sign(null, pluginSignaturePayloadBytes(manifest, {}), privateKey).toString("base64"),
  }));
  const updateManifest = (text: string) => {
    manifest = Buffer.from(text);
    signature = Buffer.from(JSON.stringify({ publisher: "team", files: {},
      signature: sign(null, pluginSignaturePayloadBytes(manifest, {}), privateKey).toString("base64"),
    }));
  };
  let requests = 0;
  const fetcher = async (url: string) => {
    requests++;
    const bytes = url.endsWith("/plugin.json") ? manifest : signature;
    return { ok: true, status: 200, statusText: "OK", text: async () => bytes.toString(),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
  };
  return { options: { ...base, agencHome: base.root, fetcher }, fetches: () => requests,
    updateManifest };
}

async function registeredRemoteMarket(
  base: Awaited<ReturnType<typeof tempRuntime>>,
  directory: string,
  initialSha: string,
) {
  const market = join(base.root, directory);
  const marketManifest = join(market, ".agenc-plugin", "marketplace.json");
  await mkdir(join(market, ".agenc-plugin"), { recursive: true });
  const writeMarket = (sha: string) => writeFile(marketManifest, JSON.stringify({
    metadata: { name: "team" }, plugins: [{ name: "remote",
      source: { source: "git", url: "https://github.com/team/plugins.git", sha },
      policy: { installation: "AVAILABLE", authentication: "ON_USE" } }],
  }));
  await writeMarket(initialSha);
  await addMarketplaceOp({ ...base, source: market, name: "team" });
  return { market, writeMarket };
}

async function pinnedPairFixture() {
  const base = await tempRuntime();
  const pinA = "a".repeat(40);
  const pinB = "b".repeat(40);
  const { market, writeMarket } = await registeredRemoteMarket(base, "remote-market", pinA);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  await writeFile(join(base.root, "plugin-publishers.json"), JSON.stringify({ publishers: {
    team: { publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64") },
  } }));
  const manifestA = Buffer.from(JSON.stringify({ name: "remote", version: "1.0.0" }));
  const manifestB = Buffer.from(JSON.stringify({ name: "remote", version: "2.0.0" }));
  const signed = (manifest: Buffer) => Buffer.from(JSON.stringify({ publisher: "team", files: {},
    signature: sign(null, pluginSignaturePayloadBytes(manifest, {}), privateKey).toString("base64"),
  }));
  const signatureA = signed(manifestA);
  const signatureB = signed(manifestB);
  const requests: string[] = [];
  const fetcher = async (url: string) => {
    requests.push(url);
    const bytes = url.includes(`/${pinA}/`)
      ? url.endsWith("plugin.json") ? manifestA : signatureA
      : url.endsWith("plugin.json") ? manifestB : signatureB;
    return { ok: true, status: 200, statusText: "OK", text: async () => bytes.toString(),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
  };
  return { base, market, pinA, pinB, writeMarket, manifestA, signatureA, requests, fetcher };
}

async function bulkSignedPins(count: number) {
  const base = await tempRuntime();
  const market = join(base.root, "remote-market");
  await mkdir(join(market, ".agenc-plugin"), { recursive: true });
  const plugins = Array.from({ length: count }, (_, index) => ({
    name: `remote-${index}`, source: { source: "git", url: "https://github.com/team/plugins.git",
      sha: index.toString(16).padStart(40, "0") },
    policy: { installation: "AVAILABLE", authentication: "ON_USE" },
  }));
  await writeFile(join(market, ".agenc-plugin", "marketplace.json"), JSON.stringify({
    metadata: { name: "team" }, plugins,
  }));
  await addMarketplaceOp({ ...base, source: market, name: "team" });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  await writeFile(join(base.root, "plugin-publishers.json"), JSON.stringify({ publishers: {
    team: { publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64") },
  } }));
  const manifest = Buffer.from(JSON.stringify({ name: "remote" }));
  const signature = Buffer.from(JSON.stringify({ publisher: "team", files: {},
    signature: sign(null, pluginSignaturePayloadBytes(manifest, {}), privateKey).toString("base64"),
  }));
  return { base, plugins, manifest, signature };
}

function trackedAdvertRuntime(
  options: Awaited<ReturnType<typeof remoteAdvertFixture>>["options"],
  time: () => number,
) {
  const requests: string[] = [];
  const runtime = { ...options, now: () => new Date(time()), fetcher: async (url: string) => {
    requests.push(url);
    return options.fetcher(url);
  } };
  return { requests, runtime };
}

describe("marketplace catalog CLI surface", () => {
  it("does not fetch an encoded traversal from a different commit", async () => {
    const options = await tempRuntime();
    const market = join(options.root, "encoded-market");
    await mkdir(join(market, ".agenc-plugin"), { recursive: true });
    const pinA = "a".repeat(40);
    const pinB = "b".repeat(40);
    await writeFile(join(market, ".agenc-plugin", "marketplace.json"), JSON.stringify({
      metadata: { name: "team" }, plugins: [{ name: "remote",
        source: { source: "git", url: "https://github.com/team/plugins.git", sha: pinA,
          path: `%2e%2e/${pinB}` },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" } }],
    }));
    await addMarketplaceOp({ ...options, source: market, name: "team" });
    const requests: string[] = [];
    const fetcher = async (url: string) => {
      requests.push(new URL(url).pathname);
      return { ok: false, status: 404, statusText: "Not Found", text: async () => "",
        arrayBuffer: async () => new ArrayBuffer(0) };
    };
    const catalog = await buildMarketplaceCatalog({ ...options, agencHome: options.root, fetcher },
      undefined, true);
    expect(catalog.marketplaces[0]?.plugins[0]?.payloadDigest).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests.every((path) => path.includes(`/${pinA}/`))).toBe(true);
    expect(requests[0]).toContain("/%252e%252e/");
  });

  it("backs off malformed pinned manifests before another poll", async () => {
    const { options, fetches } = await remoteAdvertFixture("{broken");
    for (let poll = 0; poll < 3; poll++) await buildMarketplaceCatalog(options, undefined, true);
    expect(fetches()).toBe(2);
  });

  it("reuses an authenticated unchanged advert within the refresh deadline", async () => {
    const { options, fetches } = await remoteAdvertFixture(JSON.stringify({ name: "remote", version: "1.0.0" }), true);
    const digests: Array<string | undefined> = [];
    for (let poll = 0; poll < 3; poll++) {
      const catalog = await buildMarketplaceCatalog(options, undefined, true);
      digests.push(catalog.marketplaces[0]?.plugins[0]?.payloadDigest);
    }
    expect(digests[0]).toMatch(/^sha256:/u);
    expect(digests).toEqual([digests[0], digests[0], digests[0]]);
    expect(fetches()).toBe(2);
  });

  it("revalidates a signed advert after a fresh CLI module starts", async () => {
    const { options, fetches } = await remoteAdvertFixture(JSON.stringify({ name: "remote", version: "2.0.0" }), true);
    const first = await buildMarketplaceCatalog(options, undefined, true);
    const digest = first.marketplaces[0]?.plugins[0]?.payloadDigest;
    expect(digest).toMatch(/^sha256:/u);
    vi.resetModules();
    const fresh = await import("./catalog-cli.js");
    const second = await fresh.buildMarketplaceCatalog(options, undefined, true);
    expect(second.marketplaces[0]?.plugins[0]?.payloadDigest).toBe(digest);
    expect(fetches()).toBe(2);
  });

  it("authenticates an advert after a display-only catalog's deadline expires", async () => {
    const { options, fetches } = await remoteAdvertFixture(JSON.stringify({ name: "remote", version: "2.0.0" }), true);
    let now = Date.parse("2026-09-23T00:00:00Z");
    const runtime = { ...options, now: () => new Date(now) };
    const display = await buildMarketplaceCatalog(runtime);
    expect(display.marketplaces[0]?.plugins[0]?.payloadDigest).toBeUndefined();
    vi.resetModules();
    const fresh = await import("./catalog-cli.js");
    expect((await fresh.buildMarketplaceCatalog(runtime, undefined, true)).marketplaces[0]?.plugins[0]?.payloadDigest)
      .toBeUndefined();
    expect(fetches()).toBe(1);
    now += OFFICIAL_MARKETPLACE_REFRESH_MS + 1;
    const inventory = await fresh.buildMarketplaceCatalog(runtime, undefined, true);
    expect(inventory.marketplaces[0]?.plugins[0]?.payloadDigest).toMatch(/^sha256:/u);
    const calls = fetches();
    await fresh.buildMarketplaceCatalog(runtime, undefined, true);
    expect(fetches()).toBe(calls);
  });
  it("exposes only a cryptographically verified advertised payload digest", async () => {
    const options = await tempRuntime();
    const source = await writeMarketplace(join(options.root, "signed-source"));
    const pluginRoot = join(source, "everywhere");
    const manifest = await readFile(join(pluginRoot, ".agenc-plugin", "plugin.json"));
    const files = { "commands/hello.md": `sha256:${createHash("sha256")
      .update(await readFile(join(pluginRoot, "commands", "hello.md"))).digest("hex")}` };
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    await writeFile(join(options.root, "plugin-publishers.json"), JSON.stringify({ publishers: {
      team: { publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64") },
    } }));
    const signaturePath = join(pluginRoot, ".agenc-plugin", "signature.json");
    await writeFile(signaturePath, JSON.stringify({ publisher: "team", files,
      signature: sign(null, pluginSignaturePayloadBytes(manifest, files), privateKey).toString("base64") }));
    await addMarketplaceOp({ ...options, source, name: "team" });
    const catalog = await buildMarketplaceCatalog({ ...options, agencHome: options.root }, "desktop", true);
    const row = catalog.marketplaces[0]?.plugins.find((plugin) => plugin.name === "everywhere");
    expect(row?.payloadDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    await writeFile(join(options.pluginStorageRoot, "marketplaces", "team", "everywhere",
      ".agenc-plugin", "signature.json"), JSON.stringify({ publisher: "team", files, signature: "AAAA" }));
    const tampered = await buildMarketplaceCatalog({ ...options, agencHome: options.root }, "desktop", true);
    expect(tampered.marketplaces[0]?.plugins.find((plugin) => plugin.name === "everywhere")?.payloadDigest)
      .toBeUndefined();
  });
  it("rechecks cached remote adverts against signed bytes and the current publisher keyring", async () => {
    const options = await tempRuntime();
    await registeredRemoteMarket(options, "remote-market", "a".repeat(40));
    const manifest = Buffer.from(JSON.stringify({ name: "remote", version: "1.0.0" }));
    const files = {};
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const trustPath = join(options.root, "plugin-publishers.json");
    await writeFile(trustPath, JSON.stringify({ publishers: { team: {
      publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    } } }));
    const signature = Buffer.from(JSON.stringify({ publisher: "team", files,
      signature: sign(null, pluginSignaturePayloadBytes(manifest, files), privateKey).toString("base64"),
    }));
    const manifestUrl = `https://raw.githubusercontent.com/team/plugins/${"a".repeat(40)}/.agenc-plugin/plugin.json`;
    const fetcher = async (url: string) => {
      const bytes = url === manifestUrl ? manifest : signature;
      return { ok: true, status: 200, statusText: "OK", text: async () => bytes.toString(),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
    };
    const catalogOptions = { ...options, agencHome: options.root, fetcher };
    const first = await buildMarketplaceCatalog(catalogOptions, undefined, true);
    const genuineDigest = first.marketplaces[0]?.plugins[0]?.payloadDigest;
    expect(genuineDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const key = createHash("sha256").update(manifestUrl).digest("hex").slice(0, 24);
    const sidecarPath = join(options.pluginStorageRoot, "marketplaces", ".logo-cache", `${key}.meta.json`);
    const cached = JSON.parse(await readFile(sidecarPath, "utf8"));
    await writeFile(sidecarPath, JSON.stringify({ ...cached, payloadDigest: `sha256:${"0".repeat(64)}` }));
    const tampered = await buildMarketplaceCatalog(catalogOptions, undefined, true);
    expect.soft(tampered.marketplaces[0]?.plugins[0]?.payloadDigest).toBe(genuineDigest);
    await writeFile(trustPath, JSON.stringify({ publishers: {} }));
    const untrusted = await buildMarketplaceCatalog(catalogOptions, undefined, true);
    expect(untrusted.marketplaces[0]?.plugins[0]?.payloadDigest).toBeUndefined();
  });

  it("does not accept signed material from another commit's cache entry", async () => {
    const { base: options, market, pinA, pinB, writeMarket, manifestA, signatureA, requests, fetcher } =
      await pinnedPairFixture();
    const catalogOptions = { ...options, agencHome: options.root, fetcher };
    const first = await buildMarketplaceCatalog(catalogOptions, undefined, true);
    const digestA = first.marketplaces[0]?.plugins[0]?.payloadDigest;
    expect(digestA).toBeDefined();
    await writeMarket(pinB);
    await addMarketplaceOp({ ...options, source: market, name: "team", force: true });
    const manifestUrlB = `https://raw.githubusercontent.com/team/plugins/${pinB}/.agenc-plugin/plugin.json`;
    const keyB = createHash("sha256").update(manifestUrlB).digest("hex").slice(0, 24);
    const sidecarPathB = join(options.pluginStorageRoot, "marketplaces", ".logo-cache", `${keyB}.meta.json`);
    await writeFile(sidecarPathB, JSON.stringify({ cardMetadataVersion: 1, version: "2.0.0",
      signedManifestSha256: createHash("sha256").update(manifestA).digest("hex"),
      signedSignature: signatureA.toString("base64"),
      manifestRetryAfter: new Date(Date.now() - 1).toISOString(),
      authRetryAfter: new Date(Date.now() - 1).toISOString() }));
    const manifestUrlA = `https://raw.githubusercontent.com/team/plugins/${pinA}/.agenc-plugin/plugin.json`;
    const keyA = createHash("sha256").update(manifestUrlA).digest("hex").slice(0, 24);
    const cacheRoot = join(options.pluginStorageRoot, "marketplaces", ".logo-cache");
    const copied = JSON.parse(await readFile(join(cacheRoot, `${keyA}.authenticated.json`), "utf8"));
    await writeFile(join(cacheRoot, `${keyB}.authenticated.json`), JSON.stringify({
      ...copied, manifestUrl: manifestUrlB,
    }));
    requests.length = 0;
    vi.resetModules();
    const fresh = await import("./catalog-cli.js");
    const second = await fresh.buildMarketplaceCatalog(catalogOptions, undefined, true);
    expect(requests).toContain(manifestUrlB);
    expect(second.marketplaces[0]?.plugins[0]?.payloadDigest).toBeDefined();
    expect(second.marketplaces[0]?.plugins[0]?.payloadDigest).not.toBe(digestA);
  });

  it("ignores a cache-supplied binding key when an advert is copied to another source", async () => {
    const { base, market, pinA, pinB, writeMarket, manifestA, signatureA, requests, fetcher } =
      await pinnedPairFixture();
    const options = { ...base, agencHome: base.root, fetcher };
    const first = await buildMarketplaceCatalog(options, undefined, true);
    const digestA = first.marketplaces[0]?.plugins[0]?.payloadDigest;
    expect(digestA).toBeDefined();
    const privateDirectory = join(base.root, "private", "plugin-adverts");
    expect((await stat(privateDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(privateDirectory, "binding-key"))).mode & 0o777).toBe(0o600);
    await writeMarket(pinB);
    await addMarketplaceOp({ ...base, source: market, name: "team", force: true });
    const cacheRoot = join(base.pluginStorageRoot, "marketplaces", ".logo-cache");
    const url = (sha: string) => `https://raw.githubusercontent.com/team/plugins/${sha}/.agenc-plugin/plugin.json`;
    const cacheKey = (sha: string) => createHash("sha256").update(url(sha)).digest("hex").slice(0, 24);
    const copied = JSON.parse(await readFile(join(cacheRoot, `${cacheKey(pinA)}.authenticated.json`), "utf8"));
    const attackerKey = randomBytes(32);
    await writeFile(join(cacheRoot, ".advert-binding-key"), attackerKey.toString("hex"));
    const binding = createHmac("sha256", attackerKey).update(url(pinB)).update("\0")
      .update(manifestA).update("\0").update(signatureA).digest("hex");
    await writeFile(join(cacheRoot, `${cacheKey(pinB)}.authenticated.json`),
      JSON.stringify({ ...copied, manifestUrl: url(pinB), binding }));
    await writeFile(join(cacheRoot, `${cacheKey(pinB)}.meta.json`), JSON.stringify({
      manifestRetryAfter: new Date(Date.now() - 1).toISOString(),
      authRetryAfter: new Date(Date.now() - 1).toISOString(),
    }));
    requests.length = 0;
    vi.resetModules();
    const fresh = await import("./catalog-cli.js");
    const second = await fresh.buildMarketplaceCatalog(options, undefined, true);
    expect(requests).toContain(url(pinB));
    expect(second.marketplaces[0]?.plugins[0]?.payloadDigest).toBeDefined();
    expect(second.marketplaces[0]?.plugins[0]?.payloadDigest).not.toBe(digestA);
    expect(await readdir(cacheRoot)).not.toContain(".advert-binding-key");
  });

  it("claims one recovery fetch for three offline polls of an unverifiable advert", async () => {
    const { options } = await remoteAdvertFixture(JSON.stringify({ name: "remote", version: "2.0.0" }), true);
    let now = Date.parse("2026-09-23T00:00:00Z");
    let attempts = 0;
    let offline = false;
    const runtime = { ...options, now: () => new Date(now), fetcher: async (url: string) => {
      if (offline) { if (url.endsWith("/plugin.json")) attempts++; throw new Error("offline"); }
      return options.fetcher(url);
    } };
    await buildMarketplaceCatalog(runtime, undefined, true);
    await rm(join(options.root, "private", "plugin-adverts", "binding-key"), { force: true });
    offline = true;
    vi.resetModules();
    const fresh = await import("./catalog-cli.js");
    for (let poll = 0; poll < 3; poll++) {
      const result = await fresh.buildMarketplaceCatalog(runtime, undefined, true);
      expect(result.marketplaces[0]?.plugins[0]?.payloadDigest).toBeUndefined();
      now += 1000;
    }
    expect(attempts).toBe(1);
  });

  it("does not start an ordinary fetch at the old deadline after recovery near its expiry", async () => {
    const { options } = await remoteAdvertFixture(JSON.stringify({ name: "remote", version: "2.0.0" }), true);
    const start = Date.parse("2026-09-23T00:00:00Z");
    let now = start;
    const { requests, runtime } = trackedAdvertRuntime(options, () => now);
    expect((await buildMarketplaceCatalog(runtime, undefined, true)).marketplaces[0]?.plugins[0]?.payloadDigest)
      .toMatch(/^sha256:/u);
    expect(requests).toHaveLength(2);
    await rm(join(options.root, "private", "plugin-adverts", "binding-key"), { force: true });
    vi.resetModules();
    const fresh = await import("./catalog-cli.js");
    now = start + OFFICIAL_MARKETPLACE_REFRESH_MS - 1000;
    expect((await fresh.buildMarketplaceCatalog(runtime, undefined, true)).marketplaces[0]?.plugins[0]?.payloadDigest)
      .toMatch(/^sha256:/u);
    expect(requests).toHaveLength(4);
    now = start + OFFICIAL_MARKETPLACE_REFRESH_MS + 1;
    expect((await fresh.buildMarketplaceCatalog(runtime, undefined, true)).marketplaces[0]?.plugins[0]?.payloadDigest)
      .toMatch(/^sha256:/u);
    expect(requests).toHaveLength(4);
  });

  it("rebases a failed authentication deadline after clock correction", async () => {
    const { options } = await remoteAdvertFixture(JSON.stringify({ name: "remote", version: "2.0.0" }), true);
    const corrected = Date.parse("2026-09-23T00:00:00Z");
    let now = corrected + 7 * 24 * OFFICIAL_MARKETPLACE_REFRESH_MS;
    let offline = true;
    const requests: string[] = [];
    const runtime = { ...options, now: () => new Date(now), fetcher: async (url: string) => {
      requests.push(url);
      if (offline && url.endsWith("/signature.json")) throw new Error("offline");
      return options.fetcher(url);
    } };
    expect((await buildMarketplaceCatalog(runtime, undefined, true)).marketplaces[0]?.plugins[0]?.payloadDigest)
      .toBeUndefined();
    expect(requests).toHaveLength(2);
    now = corrected;
    offline = false;
    await buildMarketplaceCatalog(runtime, undefined, true);
    expect(requests).toHaveLength(2);
    const manifestUrl = `https://raw.githubusercontent.com/team/plugins/${"a".repeat(40)}/.agenc-plugin/plugin.json`;
    const key = createHash("sha256").update(manifestUrl).digest("hex").slice(0, 24);
    const sidecar = JSON.parse(await readFile(join(options.pluginStorageRoot, "marketplaces",
      ".logo-cache", `${key}.meta.json`), "utf8"));
    expect(sidecar.advertRetryAfter).toBe(new Date(corrected + OFFICIAL_MARKETPLACE_REFRESH_MS).toISOString());
    now += OFFICIAL_MARKETPLACE_REFRESH_MS + 1;
    expect((await buildMarketplaceCatalog(runtime, undefined, true)).marketplaces[0]?.plugins[0]?.payloadDigest)
      .toMatch(/^sha256:/u);
    expect(requests).toHaveLength(4);
    await buildMarketplaceCatalog(runtime, undefined, true);
    expect(requests).toHaveLength(4);
    now += OFFICIAL_MARKETPLACE_REFRESH_MS + 1;
    await buildMarketplaceCatalog(runtime, undefined, true);
    expect(requests).toHaveLength(6);
  });

  it("migrates legacy advert deadlines to the latest source deadline", async () => {
    const { options } = await remoteAdvertFixture(JSON.stringify({ name: "remote", version: "2.0.0" }), true);
    const start = Date.parse("2026-09-23T00:00:00Z");
    let now = start;
    const { requests, runtime } = trackedAdvertRuntime(options, () => now);
    const manifestUrl = `https://raw.githubusercontent.com/team/plugins/${"a".repeat(40)}/.agenc-plugin/plugin.json`;
    const key = createHash("sha256").update(manifestUrl).digest("hex").slice(0, 24);
    const sidecarPath = join(options.pluginStorageRoot, "marketplaces", ".logo-cache", `${key}.meta.json`);
    await mkdir(join(options.pluginStorageRoot, "marketplaces", ".logo-cache"), { recursive: true });
    await writeFile(sidecarPath, JSON.stringify({ version: "old",
      manifestRetryAfter: new Date(start + 10 * 60_000).toISOString(),
      authRetryAfter: new Date(start + 30 * 60_000).toISOString(),
      authRecoveryAfter: new Date(start + 40 * 60_000).toISOString(),
      authRefreshPending: true }));
    await buildMarketplaceCatalog(runtime, undefined, true);
    expect(requests).toHaveLength(0);
    const migrated = JSON.parse(await readFile(sidecarPath, "utf8"));
    expect(migrated).toMatchObject({ version: "old",
      advertRetryAfter: new Date(start + 40 * 60_000).toISOString() });
    for (const field of ["manifestRetryAfter", "authRetryAfter", "authRecoveryAfter", "authRefreshPending"]) {
      expect(migrated).not.toHaveProperty(field);
    }
    now = start + 30 * 60_000 + 1;
    await buildMarketplaceCatalog(runtime, undefined, true);
    expect(requests).toHaveLength(0);
    now = start + 40 * 60_000 + 1;
    expect((await buildMarketplaceCatalog(runtime, undefined, true)).marketplaces[0]?.plugins[0]?.payloadDigest)
      .toMatch(/^sha256:/u);
    expect(requests).toHaveLength(2);
  });

  it("lets only one independent catalog module claim recovery concurrently", async () => {
    const { options } = await remoteAdvertFixture(JSON.stringify({ name: "remote", version: "2.0.0" }), true);
    let attempts = 0;
    let offline = false;
    const runtime = { ...options, fetcher: async (url: string) => {
      if (offline) { if (url.endsWith("/plugin.json")) attempts++; throw new Error("offline"); }
      return options.fetcher(url);
    } };
    await buildMarketplaceCatalog(runtime, undefined, true);
    await rm(join(options.root, "private", "plugin-adverts", "binding-key"), { force: true });
    offline = true;
    vi.resetModules();
    const first = await import("./catalog-cli.js");
    vi.resetModules();
    const second = await import("./catalog-cli.js");
    await Promise.all([first.buildMarketplaceCatalog(runtime, undefined, true),
      second.buildMarketplaceCatalog(runtime, undefined, true)]);
    expect(attempts).toBe(1);
  });

  it("uses one authentication fetch per window after recovery and ordinary refresh both fail", async () => {
    const { options } = await remoteAdvertFixture(JSON.stringify({ name: "remote", version: "2.0.0" }), true);
    let now = Date.parse("2026-09-23T00:00:00Z");
    let offline = false;
    const requests: string[] = [];
    const runtime = { ...options, now: () => new Date(now), fetcher: async (url: string) => {
      if (offline) {
        requests.push(url);
        if (url.endsWith("/signature.json")) throw new Error("offline");
      }
      return options.fetcher(url);
    } };
    await buildMarketplaceCatalog(runtime, undefined, true);
    await rm(join(options.root, "private", "plugin-adverts", "binding-key"), { force: true });
    offline = true;
    vi.resetModules();
    const fresh = await import("./catalog-cli.js");
    await fresh.buildMarketplaceCatalog(runtime, undefined, true);
    expect(requests).toHaveLength(2);
    for (let window = 0; window < 3; window++) {
      now += OFFICIAL_MARKETPLACE_REFRESH_MS + 1;
      requests.length = 0;
      for (let poll = 0; poll < 3; poll++) {
        const result = await fresh.buildMarketplaceCatalog(runtime, undefined, true);
        expect(result.marketplaces[0]?.plugins[0]?.payloadDigest).toBeUndefined();
      }
      expect(requests.filter((url) => url.endsWith("/plugin.json"))).toHaveLength(1);
      expect(requests.filter((url) => url.endsWith("/signature.json"))).toHaveLength(1);
    }
  });

  it("does not refetch when another module recovers an advert after a stale unbound observation", async () => {
    const { options } = await remoteAdvertFixture(JSON.stringify({ name: "remote", version: "2.0.0" }), true);
    let recovering = false;
    let recoveryRequests = 0;
    let unblockFirstFetch!: () => void;
    let signalFirstFetch!: () => void;
    const firstFetchStarted = new Promise<void>((resolve) => { signalFirstFetch = resolve; });
    const firstFetchGate = new Promise<void>((resolve) => { unblockFirstFetch = resolve; });
    let firstFetchBlocked = false;
    const runtime = { ...options, fetcher: async (url: string) => {
      if (recovering) {
        recoveryRequests++;
        if (!firstFetchBlocked && url.endsWith("/plugin.json")) {
          firstFetchBlocked = true;
          signalFirstFetch();
          await firstFetchGate;
        }
      }
      return options.fetcher(url);
    } };
    await buildMarketplaceCatalog(runtime, undefined, true);
    await rm(join(options.root, "private", "plugin-adverts", "binding-key"), { force: true });
    recovering = true;
    vi.resetModules();
    const first = await import("./catalog-cli.js");
    const firstPoll = first.buildMarketplaceCatalog(runtime, undefined, true);
    await firstFetchStarted;

    const manifestUrl = `https://raw.githubusercontent.com/team/plugins/${"a".repeat(40)}/.agenc-plugin/plugin.json`;
    const key = createHash("sha256").update(manifestUrl).digest("hex").slice(0, 24);
    const authenticatedPath = join(options.pluginStorageRoot, "marketplaces", ".logo-cache", `${key}.authenticated.json`);
    let statCalls = 0;
    let signalSecondObserved!: () => void;
    const secondObserved = new Promise<void>((resolve) => { signalSecondObserved = resolve; });
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const fs = await importOriginal<typeof import("node:fs/promises")>();
      return { ...fs, stat: async (...args: Parameters<typeof fs.stat>) => {
        const result = await fs.stat(...args);
        if (String(args[0]) === authenticatedPath && ++statCalls === 2) {
          signalSecondObserved();
          await firstPoll;
        }
        return result;
      } };
    });
    try {
      vi.resetModules();
      const second = await import("./catalog-cli.js");
      const secondPoll = second.buildMarketplaceCatalog(runtime, undefined, true);
      await secondObserved;
      unblockFirstFetch();
      const [firstResult, secondResult] = await Promise.all([firstPoll, secondPoll]);
      expect(firstResult.marketplaces[0]?.plugins[0]?.payloadDigest).toMatch(/^sha256:/u);
      expect(secondResult.marketplaces[0]?.plugins[0]?.payloadDigest).toMatch(/^sha256:/u);
      expect(recoveryRequests).toBe(2);
    } finally {
      unblockFirstFetch();
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
    await rm(join(options.root, "private", "plugin-adverts", "binding-key"), { force: true });
    const third = await import("./catalog-cli.js");
    await third.buildMarketplaceCatalog(runtime, undefined, true);
    expect(recoveryRequests).toBe(2);
  });

  it("retains a signed advert through an expired offline refresh and rechecks trust", async () => {
    const { options, fetches, updateManifest } = await remoteAdvertFixture(JSON.stringify({ name: "remote", version: "2.0.0" }), true);
    let now = Date.parse("2026-09-23T00:00:00Z");
    let offline = false;
    const fetcher = options.fetcher;
    const runtime = { ...options, now: () => new Date(now), fetcher: async (url: string) => {
      if (offline) throw new Error("offline");
      return fetcher(url);
    } };
    const first = await buildMarketplaceCatalog(runtime, undefined, true);
    const digest = first.marketplaces[0]?.plugins[0]?.payloadDigest;
    expect(digest).toMatch(/^sha256:/u);
    now += OFFICIAL_MARKETPLACE_REFRESH_MS + 1;
    offline = true;
    vi.resetModules();
    const fresh = await import("./catalog-cli.js");
    const expired = await fresh.buildMarketplaceCatalog(runtime, undefined, true);
    expect(expired.marketplaces[0]?.plugins[0]?.payloadDigest).toBe(digest);
    expect(fetches()).toBe(2);
    const trustPath = join(options.root, "plugin-publishers.json");
    const trust = await readFile(trustPath);
    await writeFile(trustPath, JSON.stringify({ publishers: {} }));
    const untrusted = await fresh.buildMarketplaceCatalog(runtime, undefined, true);
    expect(untrusted.marketplaces[0]?.plugins[0]?.payloadDigest).toBeUndefined();
    await writeFile(trustPath, trust);
    updateManifest(JSON.stringify({ name: "remote", version: "3.0.0" }));
    now += OFFICIAL_MARKETPLACE_REFRESH_MS + 1;
    offline = false;
    const replaced = await fresh.buildMarketplaceCatalog(runtime, undefined, true);
    expect(replaced.marketplaces[0]?.plugins[0]?.payloadDigest).toMatch(/^sha256:/u);
    expect(replaced.marketplaces[0]?.plugins[0]?.payloadDigest).not.toBe(digest);
  });

  it("bounds persisted authenticated adverts across distinct pinned commits", async () => {
    const { base, plugins, manifest, signature } = await bulkSignedPins(130);
    const requests = new Map<string, number>();
    const fetcher = async (url: string) => {
      requests.set(url, (requests.get(url) ?? 0) + 1);
      const bytes = url.endsWith("/plugin.json") ? manifest : signature;
      return { ok: true, status: 200, statusText: "OK", text: async () => bytes.toString(),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
    };
    const runtime = { ...base, agencHome: base.root, fetcher };
    await buildMarketplaceCatalog(runtime, undefined, true);
    const entries = await readdir(join(base.pluginStorageRoot, "marketplaces", ".logo-cache"));
    expect(entries.filter((name) => name.endsWith(".authenticated.json")).length).toBeLessThanOrEqual(128);
    const cacheKey = (sha: string) => createHash("sha256").update(
      `https://raw.githubusercontent.com/team/plugins/${sha}/.agenc-plugin/plugin.json`,
    ).digest("hex").slice(0, 24);
    expect(entries).not.toContain(`${cacheKey(plugins[0]!.source.sha)}.authenticated.json`);
    expect(entries).toContain(`${cacheKey(plugins.at(-1)!.source.sha)}.authenticated.json`);
    await buildMarketplaceCatalog(runtime, undefined, true);
    await buildMarketplaceCatalog(runtime, undefined, true);
    expect(requests.size).toBe(plugins.length * 2);
    expect([...requests.values()].every((count) => count === 1)).toBe(true);
    const evictedSidecar = JSON.parse(await readFile(join(base.pluginStorageRoot,
      "marketplaces", ".logo-cache", `${cacheKey(plugins[0]!.source.sha)}.meta.json`), "utf8"));
    expect(Date.parse(evictedSidecar.advertRetryAfter)).toBeGreaterThan(0);
  });

  it("keeps an in-flight source claim when authenticated bytes are evicted", async () => {
    const { base, plugins, manifest, signature } = await bulkSignedPins(129);
    const sourceA = `/${plugins[0]!.source.sha}/`;
    let now = Date.parse("2026-09-23T00:00:00Z");
    let holdRefresh = false;
    let aRequests = 0;
    let signalStarted!: () => void;
    let unblock!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const fetcher = async (url: string) => {
      if (holdRefresh && url.includes(sourceA) && url.endsWith("/plugin.json")) {
        aRequests++;
        if (aRequests === 1) { signalStarted(); await gate; }
      }
      const bytes = url.endsWith("/plugin.json") ? manifest : signature;
      return { ok: true, status: 200, statusText: "OK", text: async () => bytes.toString(),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
    };
    const runtime = { ...base, agencHome: base.root, fetcher, now: () => new Date(now) };
    const selected = (name: string) => (_marketplace: string, plugin: { name: string }) => plugin.name === name;
    await buildMarketplaceCatalog(runtime, undefined, true, false,
      (_marketplace, plugin) => plugin.name !== "remote-128");
    const key = createHash("sha256").update(
      `https://raw.githubusercontent.com/team/plugins/${plugins[0]!.source.sha}/.agenc-plugin/plugin.json`,
    ).digest("hex").slice(0, 24);
    const sidecarPath = join(base.pluginStorageRoot, "marketplaces", ".logo-cache", `${key}.meta.json`);
    const initialSidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
    const skillRetryAfter = new Date(now + 2 * OFFICIAL_MARKETPLACE_REFRESH_MS).toISOString();
    await writeFile(sidecarPath, JSON.stringify({ ...initialSidecar,
      skillClaim: "active-skill", skillRetryAfter }));
    now += OFFICIAL_MARKETPLACE_REFRESH_MS + 1;
    holdRefresh = true;
    vi.resetModules();
    const first = await import("./catalog-cli.js");
    const inFlight = first.buildMarketplaceCatalog(runtime, undefined, true, false, selected("remote-0"));
    await started;
    try {
      await buildMarketplaceCatalog(runtime, undefined, true, false, selected("remote-128"));
      vi.resetModules();
      const second = await import("./catalog-cli.js");
      await second.buildMarketplaceCatalog(runtime, undefined, true, false, selected("remote-0"));
      expect(aRequests).toBe(1);
      const retained = JSON.parse(await readFile(sidecarPath, "utf8"));
      expect(retained.advertClaim).toEqual(expect.any(String));
      expect(retained.skillClaim).toBe("active-skill");
      expect(retained.skillRetryAfter).toBe(skillRetryAfter);
      expect(Date.parse(retained.advertRetryAfter)).toBeGreaterThan(now);
    } finally {
      unblock();
      await inFlight;
    }
  });

  it("does not turn an unsigned 99.0.0 remote manifest into a signed installed update", async () => {
    const options = await tempRuntime();
    await registeredRemoteMarket(options, "unsigned-market", "b".repeat(40));
    const manifest = Buffer.from(JSON.stringify({ name: "remote", version: "99.0.0" }));
    const signature = Buffer.from(JSON.stringify({ publisher: "team", files: {}, signature: "AAAA" }));
    const fetcher = async (url: string) => {
      const bytes = url.endsWith("/plugin.json") ? manifest : signature;
      return { ok: true, status: 200, statusText: "OK", text: async () => bytes.toString(),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
    };
    const catalog = await buildMarketplaceCatalog({ ...options, agencHome: options.root,
      fetcher }, undefined, true);
    expect(catalog.marketplaces[0]?.plugins[0]).toMatchObject({ version: "99.0.0" });
    expect(catalog.marketplaces[0]?.plugins[0]?.payloadDigest).toBeUndefined();
    const compared = pluginListWithCatalog({ plugins: [{ id: "remote", name: "remote",
      version: "1.0.0", enabled: true, root: "/plugins/remote", source: "user",
      marketplace: "team", verificationState: "verified", payloadDigest: "sha256:signed" }],
    errors: [] }, catalog);
    expect(compared.plugins[0]).toMatchObject({ updateAvailable: false,
      updateVerificationState: "unavailable" });
  });

  it("refreshes an existing official marketplace through the persisted throttle", async () => {
    const { root, pluginStorageRoot, workspaceRoot } = await tempRuntime();
    const source = await writeMarketplace(join(root, "source"));
    const t0 = Date.parse("2026-09-23T00:00:00Z");
    await addMarketplaceOp({ pluginStorageRoot, workspaceRoot, source,
      name: OFFICIAL_MARKETPLACE_NAME, now: () => new Date(t0) });
    const attempts: string[] = [];
    const upgrade = async (input: { readonly name?: string }) => {
      attempts.push(input.name ?? "");
      return { upgraded: [], skipped: [] };
    };
    const opts = { pluginStorageRoot, workspaceRoot,
      now: () => new Date(t0 + OFFICIAL_MARKETPLACE_REFRESH_MS + 1) };
    await refreshStaleMarketplaces(opts, upgrade);
    await refreshStaleMarketplaces(opts, upgrade);
    expect(attempts).toEqual([OFFICIAL_MARKETPLACE_NAME]);
  });
  it("honors automatic refresh opt-out before claiming team and official marketplaces", async () => {
    const { pluginStorageRoot, workspaceRoot } = await tempRuntime();
    const t0 = Date.parse("2026-09-23T00:00:00Z");
    let fetches = 0;
    const fetcher = async (url: string) => {
      fetches += 1;
      const name = url.includes("official") ? OFFICIAL_MARKETPLACE_NAME : "team";
      const bytes = Buffer.from(JSON.stringify({ metadata: { name }, plugins: [] }));
      return { ok: true, status: 200, statusText: "OK", text: async () => bytes.toString(),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
    };
    const base = { pluginStorageRoot, workspaceRoot, fetcher };
    for (const [name, source] of [["team", "https://example.test/team.json"],
      [OFFICIAL_MARKETPLACE_NAME, "https://example.test/official.json"]] as const) {
      await addMarketplaceOp({ ...base, source, name, autoUpdate: false, now: () => new Date(t0) });
    }
    expect(fetches).toBe(2);
    const stale = { ...base, now: () => new Date(t0 + OFFICIAL_MARKETPLACE_REFRESH_MS + 1) };
    const attempts: string[] = [];
    await refreshStaleMarketplaces(stale, async (input) => {
      attempts.push(input.name ?? "");
      return { upgraded: [], skipped: [] };
    });
    expect(attempts).toEqual([]);
    expect(await ensureOfficialMarketplace(stale, async () => { fetches += 1; })).toBe(false);
    expect(fetches).toBe(2);
    const index = await readMarketplaceIndex(stale);
    expect(index.marketplaces.team?.lastCheckedAt).toBeUndefined();
    expect(index.marketplaces[OFFICIAL_MARKETPLACE_NAME]?.lastCheckedAt).toBeUndefined();
    const explicit = await upgradeMarketplaceOp({ ...stale, name: "team" });
    expect(explicit.upgraded).toHaveLength(1);
    expect(fetches).toBe(3);
  });
  it("rate limits marketplace refresh from its persisted update time", async () => {
    const { root, pluginStorageRoot, workspaceRoot } = await tempRuntime();
    const source = await writeMarketplace(join(root, "source"));
    const t0 = Date.parse("2026-09-23T00:00:00Z");
    await addMarketplaceOp({ pluginStorageRoot, workspaceRoot, source,
      name: "team", now: () => new Date(t0) });
    const attempts: string[] = [];
    const upgrade = async (input: { readonly name?: string }) => {
      attempts.push(input.name ?? "");
      return { upgraded: [], skipped: [] };
    };
    await refreshStaleMarketplaces({ pluginStorageRoot, workspaceRoot,
      now: () => new Date(t0 + OFFICIAL_MARKETPLACE_REFRESH_MS / 2) }, upgrade);
    expect(attempts).toEqual([]);
    await refreshStaleMarketplaces({ pluginStorageRoot, workspaceRoot,
      now: () => new Date(t0 + OFFICIAL_MARKETPLACE_REFRESH_MS + 1) }, upgrade);
    expect(attempts).toEqual(["team"]);
    await refreshStaleMarketplaces({ pluginStorageRoot, workspaceRoot,
      now: () => new Date(t0 + OFFICIAL_MARKETPLACE_REFRESH_MS + 2) }, upgrade);
    expect(attempts).toEqual(["team"]);
  });
  it.each(["stale-refresh", "official"] as const)(
    "rebases failed %s marketplace checks after a clock correction", async (guard) => {
      const { root, pluginStorageRoot, workspaceRoot } = await tempRuntime();
      const source = await writeMarketplace(join(root, "source"));
      const corrected = Date.parse("2026-09-23T00:00:00Z");
      const week = 7 * 24 * OFFICIAL_MARKETPLACE_REFRESH_MS;
      const name = guard === "official" ? OFFICIAL_MARKETPLACE_NAME : "team";
      await addMarketplaceOp({ pluginStorageRoot, workspaceRoot, source, name,
        now: () => new Date(corrected - week) });
      let now = corrected + week;
      let attempts = 0;
      const options = { pluginStorageRoot, workspaceRoot, now: () => new Date(now) };
      const poll = async () => {
        if (guard === "official") {
          await ensureOfficialMarketplace(options, async () => { attempts++; throw new Error("offline"); });
        } else {
          await refreshStaleMarketplaces(options, async () => {
            attempts++;
            throw new Error("offline");
          });
        }
      };
      await poll();
      expect(attempts).toBe(1);
      now = corrected;
      await poll();
      expect(attempts).toBe(1);
      expect((await readMarketplaceIndex(options)).marketplaces[name]?.lastCheckedAt)
        .toBe(new Date(corrected).toISOString());
      now += OFFICIAL_MARKETPLACE_REFRESH_MS + 1;
      await poll();
      expect(attempts).toBe(2);
    },
  );
  it.each(["stale-refresh", "official"] as const)(
    "rebases future %s marketplace update times after a clock correction", async (guard) => {
      const { root, pluginStorageRoot, workspaceRoot } = await tempRuntime();
      const source = await writeMarketplace(join(root, "source"));
      const corrected = Date.parse("2026-09-23T00:00:00Z");
      const name = guard === "official" ? OFFICIAL_MARKETPLACE_NAME : "team";
      await addMarketplaceOp({ pluginStorageRoot, workspaceRoot, source, name,
        now: () => new Date(corrected + 7 * 24 * OFFICIAL_MARKETPLACE_REFRESH_MS) });
      let now = corrected;
      let attempts = 0;
      const options = { pluginStorageRoot, workspaceRoot, now: () => new Date(now) };
      const poll = async () => {
        if (guard === "official") {
          await ensureOfficialMarketplace(options, async () => { attempts++; throw new Error("offline"); });
        } else {
          await refreshStaleMarketplaces(options, async () => {
            attempts++;
            throw new Error("offline");
          });
        }
      };
      await poll();
      expect(attempts).toBe(0);
      expect((await readMarketplaceIndex(options)).marketplaces[name]?.updatedAt)
        .toBe(new Date(corrected).toISOString());
      now += OFFICIAL_MARKETPLACE_REFRESH_MS + 1;
      await poll();
      expect(attempts).toBe(1);
    },
  );
  it("gates plugins by product policy", () => {
    expect(
      marketplacePluginSupportsProduct(
        { installation: "AVAILABLE", authentication: "ON_USE" },
        undefined,
      ),
    ).toBe(true);
    expect(
      marketplacePluginSupportsProduct(
        {
          installation: "AVAILABLE",
          authentication: "ON_USE",
          products: ["desktop"],
        },
        "desktop",
      ),
    ).toBe(true);
    expect(
      marketplacePluginSupportsProduct(
        {
          installation: "AVAILABLE",
          authentication: "ON_USE",
          products: ["desktop"],
        },
        undefined,
      ),
    ).toBe(false);
    expect(
      marketplacePluginSupportsProduct(
        { installation: "AVAILABLE", authentication: "ON_USE", products: [] },
        "desktop",
      ),
    ).toBe(false);
  });

  it("splits qualified ids on the last @ and accepts bare names", () => {
    expect(parseQualifiedMarketplacePluginId("llm-checker@agenc-plugins")).toEqual({
      pluginName: "llm-checker",
      marketplaceName: "agenc-plugins",
    });
    expect(parseQualifiedMarketplacePluginId("@scope/tool@shop")).toEqual({
      pluginName: "@scope/tool",
      marketplaceName: "shop",
    });
    expect(parseQualifiedMarketplacePluginId("solo")).toEqual({
      pluginName: "solo",
    });
    expect(() => parseQualifiedMarketplacePluginId("  ")).toThrow(
      /must not be empty/,
    );
  });

  it("serializes the product-filtered catalog with in-root logo paths", async () => {
    const { pluginStorageRoot, workspaceRoot } = await tempRuntime();
    const marketplaceRoot = await writeMarketplace(
      join(workspaceRoot, "market"),
    );
    await addMarketplaceOp({
      pluginStorageRoot,
      workspaceRoot,
      source: marketplaceRoot,
      force: false,
    });

    const catalog = await buildMarketplaceCatalog(
      { pluginStorageRoot, workspaceRoot },
      "desktop",
    );
    expect(catalog.kind).toBe("agenc.plugin.marketplace.catalog");
    expect(catalog.product).toBe("desktop");
    expect(catalog.errors).toEqual([]);
    expect(catalog.marketplaces).toHaveLength(1);
    const [market] = catalog.marketplaces;
    const ids = market!.plugins.map((plugin) => plugin.id);
    expect(ids).toContain("desktop-only@team");
    expect(ids).toContain("everywhere@team");
    expect(ids).not.toContain("hidden@team");
    expect(ids).not.toContain("nobody@team");
    const withLogo = market!.plugins.find(
      (plugin) => plugin.name === "desktop-only",
    );
    expect(withLogo?.logoPath).toBeDefined();
    expect(withLogo!.logoPath!.startsWith(withLogo!.root)).toBe(true);
    expect(withLogo!.logoPath!.endsWith("logo.png")).toBe(true);
    const withoutLogo = market!.plugins.find(
      (plugin) => plugin.name === "everywhere",
    );
    expect(withoutLogo?.logoPath).toBeUndefined();

    // A CLI product filters desktop-only plugins away.
    const cliCatalog = await buildMarketplaceCatalog(
      { pluginStorageRoot, workspaceRoot },
      "cli",
    );
    expect(
      cliCatalog.marketplaces[0]!.plugins.map((plugin) => plugin.name),
    ).toEqual(["everywhere"]);
  });

  it("resolves qualified installs and rejects unavailable or unknown ones", async () => {
    const { pluginStorageRoot, workspaceRoot } = await tempRuntime();
    const marketplaceRoot = await writeMarketplace(
      join(workspaceRoot, "market"),
    );
    await addMarketplaceOp({
      pluginStorageRoot,
      workspaceRoot,
      source: marketplaceRoot,
      force: false,
    });
    const options = { pluginStorageRoot, workspaceRoot };

    const target = await resolveMarketplaceInstallTarget(
      options,
      "desktop-only@team",
      "desktop",
    );
    expect(target.marketplaceName).toBe("team");
    expect(target.source).toMatchObject({ type: "local" });

    // Bare names resolve when unambiguous.
    const bare = await resolveMarketplaceInstallTarget(
      options,
      "everywhere",
      "desktop",
    );
    expect(bare.pluginName).toBe("everywhere");

    await expect(
      resolveMarketplaceInstallTarget(options, "desktop-only@team", "cli"),
    ).rejects.toThrow(/not installable/);
    await expect(
      resolveMarketplaceInstallTarget(options, "hidden@team", "desktop"),
    ).rejects.toThrow(/not installable/);
    await expect(
      resolveMarketplaceInstallTarget(options, "missing@nowhere", "desktop"),
    ).rejects.toThrow(/not configured/);
  });
});

describe("the official marketplace stays current", () => {
  // The marketplace was installed once and then read from disk forever: a
  // home that installed it on Sep 10 served a 5-plugin manifest while the
  // live one listed 11, and the Plugins pane showed the 5.
  const hour = 60 * 60_000;
  const t0 = Date.parse("2026-09-11T12:00:00.000Z");
  type Added = { source: string; name: string; force: boolean };
  async function seededOfficial(ageMs: number) {
    const { pluginStorageRoot, workspaceRoot } = await tempRuntime();
    const marketplaceRoot = await writeMarketplace(join(workspaceRoot, "official"));
    await addMarketplaceOp({
      pluginStorageRoot, workspaceRoot, source: marketplaceRoot, force: false,
      name: OFFICIAL_MARKETPLACE_NAME, now: () => new Date(t0 - ageMs),
    });
    const added: Added[] = [];
    const spy = async (input: Added) => { added.push({ source: input.source, name: input.name, force: input.force }); };
    return { options: { pluginStorageRoot, workspaceRoot, now: () => new Date(t0) }, added, spy };
  }

  it("installs it into an empty home", async () => {
    const { pluginStorageRoot, workspaceRoot } = await tempRuntime();
    const added: Added[] = [];
    const refreshed = await ensureOfficialMarketplace(
      { pluginStorageRoot, workspaceRoot, now: () => new Date(t0) },
      async (input) => { added.push({ source: input.source, name: input.name, force: input.force }); },
    );
    expect(refreshed).toBe(true);
    expect(added).toEqual([{ source: OFFICIAL_MARKETPLACE_URL, name: OFFICIAL_MARKETPLACE_NAME, force: false }]);
  });

  it("leaves a fresh copy alone", async () => {
    const { options, added, spy } = await seededOfficial(hour / 2);
    expect(await ensureOfficialMarketplace(options, spy)).toBe(false);
    expect(added).toEqual([]);
  });

  it("fetches it again, in place, once the copy is older than the refresh window", async () => {
    const { options, added, spy } = await seededOfficial(OFFICIAL_MARKETPLACE_REFRESH_MS + 1);
    expect(await ensureOfficialMarketplace(options, spy)).toBe(true);
    // force: the existing install is replaced rather than refused as a duplicate.
    expect(added).toEqual([{ source: OFFICIAL_MARKETPLACE_URL, name: OFFICIAL_MARKETPLACE_NAME, force: true }]);
  });

  it("keeps the cached copy when the refresh fails", async () => {
    // A stale catalog is a catalog. An empty one is an outage.
    const { options } = await seededOfficial(2 * hour);
    const refreshed = await ensureOfficialMarketplace(options, async () => { throw new Error("offline"); });
    expect(refreshed).toBe(false);
    const catalog = await buildMarketplaceCatalog(options, "desktop");
    expect(catalog.marketplaces).toHaveLength(1);
    expect(catalog.marketplaces[0]!.plugins.length).toBeGreaterThan(0);
  });
});
