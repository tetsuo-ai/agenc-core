import { gzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchResponse, Fetcher } from "./marketplace.js";
import {
  fetchRemoteInstalledPlugins,
  fetchRemoteMarketplaces,
  fetchRemotePluginDetailWithDownloadUrls,
  installRemotePlugin,
  markRemotePluginCacheMutationInFlight,
  syncRemoteInstalledPluginBundles,
  syncRemoteInstalledPluginBundlesOnce,
  uninstallRemotePlugin,
  validateRemotePluginId,
  type RemoteAuth,
  type RemotePluginServiceConfig,
} from "./remote.js";

const config: RemotePluginServiceConfig = { baseUrl: "https://agenc.tech" };
const auth: RemoteAuth = { headers: { Authorization: "Bearer test" } };

describe("remote plugin marketplace API", () => {
  it("merges directory and installed remote plugin listings by marketplace scope", async () => {
    const fetcher = createRemoteFetcher();

    await expect(fetchRemoteMarketplaces(config, auth, fetcher)).resolves.toEqual([{
      name: "agenc-global",
      displayName: "AgenC Plugins",
      plugins: [{
        id: "linear",
        name: "linear",
        installed: true,
        enabled: false,
        installPolicy: "AVAILABLE",
        authPolicy: "ON_INSTALL",
        availability: "AVAILABLE",
        interface: {
          displayName: "Linear",
          shortDescription: "Issue tracking",
          capabilities: ["issues"],
          screenshotUrls: [],
        },
      }],
    }]);

    await expect(fetchRemoteInstalledPlugins(config, auth, fetcher)).resolves.toEqual([{
      marketplaceName: "agenc-global",
      id: "linear",
      name: "linear",
      enabled: false,
    }]);
  });

  it("fetches remote plugin details with download URLs and skill enablement", async () => {
    const detail = await fetchRemotePluginDetailWithDownloadUrls(
      config,
      auth,
      "agenc-global",
      "linear",
      true,
      createRemoteFetcher(),
    );

    expect(detail).toMatchObject({
      marketplaceName: "agenc-global",
      marketplaceDisplayName: "AgenC Plugins",
      releaseVersion: "1.0.0",
      bundleDownloadUrl: "https://agenc.tech/plugins/linear.tgz",
      appIds: ["linear-app"],
      skills: [{
        name: "triage",
        enabled: false,
        interface: {
          displayName: "Triage",
        },
      }],
    });
  });

  it("posts install and uninstall mutations and clears local cache roots", async () => {
    const calls: string[] = [];
    const fetcher = createRemoteFetcher(calls);

    await installRemotePlugin(config, auth, "linear", fetcher);
    await uninstallRemotePlugin(config, auth, "/tmp/agenc-test-home", "linear", fetcher);

    expect(calls).toContain("POST /ps/plugins/linear/install");
    expect(calls).toContain("POST /ps/plugins/linear/uninstall");
  });

  it("rejects backend-controlled uninstall cache traversal before mutation", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-uninstall-traversal-"));
    const outside = join(agencHome, "escape");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "sentinel.txt"), "keep\n");
    const calls: string[] = [];

    await expect(uninstallRemotePlugin(config, auth, agencHome, "linear", async (url, init = {}) => {
      const parsed = new URL(url);
      calls.push(`${init.method ?? "GET"} ${parsed.pathname}`);
      if (parsed.pathname === "/ps/plugins/linear") {
        return jsonResponse({ ...remotePlugin(), name: "../escape" });
      }
      if (parsed.pathname === "/ps/plugins/linear/uninstall") {
        return jsonResponse({ id: "linear", enabled: false });
      }
      return jsonResponse({ message: "not found" }, false, 404);
    })).rejects.toThrow("invalid local plugin id");

    expect(calls).not.toContain("POST /ps/plugins/linear/uninstall");
    await expect(readFile(join(outside, "sentinel.txt"), "utf8")).resolves.toBe("keep\n");
  });

  it("syncs remote installed plugin bundles and removes stale cache entries", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-bundle-sync-"));
    const staleManifest = join(
      agencHome,
      "plugins",
      "cache",
      "agenc-global",
      "stale",
      "1.0.0",
      ".agenc-plugin",
      "plugin.json",
    );
    await mkdir(join(staleManifest, ".."), { recursive: true });
    await writeFile(staleManifest, JSON.stringify({ name: "stale", version: "1.0.0" }));

    const outcome = await syncRemoteInstalledPluginBundlesOnce(
      agencHome,
      config,
      auth,
      { fetcher: createRemoteBundleSyncFetcher() },
    );

    expect(outcome).toEqual({
      installedPluginIds: ["linear@agenc-global"],
      removedCachePluginIds: ["stale@agenc-global"],
      failedRemotePluginIds: [],
    });
    await expect(readFile(join(
      agencHome,
      "plugins",
      "cache",
      "agenc-global",
      "linear",
      "1.0.0",
      ".agenc-plugin",
      "plugin.json",
    ), "utf8")).resolves.toContain("\"linear\"");
    await expect(readFile(staleManifest, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips stale remote cache cleanup while a cache mutation guard is active", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-cache-guard-"));
    const cachedManifest = join(
      agencHome,
      "plugins",
      "cache",
      "agenc-global",
      "linear",
      "1.0.0",
      ".agenc-plugin",
      "plugin.json",
    );
    await mkdir(join(cachedManifest, ".."), { recursive: true });
    await writeFile(cachedManifest, JSON.stringify({ name: "linear", version: "1.0.0" }));
    const guard = markRemotePluginCacheMutationInFlight(agencHome, "agenc-global", "linear");
    try {
      const outcome = await syncRemoteInstalledPluginBundlesOnce(
        agencHome,
        config,
        auth,
        { fetcher: createEmptyRemoteInstalledFetcher() },
      );
      expect(outcome.removedCachePluginIds).toEqual([]);
      await expect(readFile(cachedManifest, "utf8")).resolves.toContain("\"linear\"");
    } finally {
      guard.dispose();
    }
  });

  it("dedupes concurrent remote bundle syncs by cache root", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-bundle-sync-dedupe-"));
    let releaseBundle = () => {};
    const bundleGate = new Promise<void>((resolve) => {
      releaseBundle = resolve;
    });
    const first = syncRemoteInstalledPluginBundles(
      agencHome,
      config,
      auth,
      { fetcher: createRemoteBundleSyncFetcher(bundleGate) },
    );
    const second = syncRemoteInstalledPluginBundles(
      agencHome,
      config,
      auth,
      { fetcher: createRemoteBundleSyncFetcher() },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseBundle();

    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(results.find((result) => result !== null)?.installedPluginIds)
      .toEqual(["linear@agenc-global"]);
  });

  it("rejects malformed remote plugin ids before issuing requests", () => {
    expect(() => validateRemotePluginId("linear")).not.toThrow();
    expect(() => validateRemotePluginId("bad/id")).toThrow("invalid remote plugin id");
  });

  it("rejects repeated remote pagination tokens", async () => {
    const fetcher: Fetcher = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/ps/plugins/list") {
        return jsonResponse({
          plugins: [],
          pagination: { next_page_token: "same-token" },
        });
      }
      if (parsed.pathname === "/ps/plugins/installed") {
        return jsonResponse({ plugins: [], pagination: {} });
      }
      return jsonResponse({ message: "not found" }, false, 404);
    };

    await expect(fetchRemoteMarketplaces(config, auth, fetcher))
      .rejects.toThrow("repeated token");
  });

  it("caps remote JSON response bodies before decoding", async () => {
    const fetcher: Fetcher = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
          controller.close();
        },
      }),
      text: async () => "",
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    await expect(fetchRemoteInstalledPlugins(config, auth, fetcher))
      .rejects.toThrow("exceeded maximum size");
  });

  it("rejects malformed remote JSON shapes before mapping responses", async () => {
    await expect(fetchRemoteMarketplaces(config, auth, async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/ps/plugins/list") {
        return jsonResponse({ plugins: [] });
      }
      return jsonResponse({ plugins: [], pagination: {} });
    })).rejects.toThrow("pagination must be an object");

    await expect(fetchRemoteMarketplaces(config, auth, async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/ps/plugins/list") {
        return jsonResponse({ plugins: {}, pagination: {} });
      }
      return jsonResponse({ plugins: [], pagination: {} });
    })).rejects.toThrow("plugins must be an array");

    await expect(fetchRemoteMarketplaces(config, auth, async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/ps/plugins/list") {
        return jsonResponse({
          plugins: [{ ...remotePlugin(), release: undefined }],
          pagination: {},
        });
      }
      return jsonResponse({ plugins: [], pagination: {} });
    })).rejects.toThrow("release must be an object");
  });
});

function createRemoteFetcher(calls: string[] = []): Fetcher {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push(`${init.method ?? "GET"} ${parsed.pathname}`);
    if (parsed.pathname === "/ps/plugins/list") {
      const scope = parsed.searchParams.get("scope");
      return jsonResponse({
        plugins: scope === "GLOBAL" ? [remotePlugin()] : [],
        pagination: {},
      });
    }
    if (parsed.pathname === "/ps/plugins/installed") {
      const scope = parsed.searchParams.get("scope");
      return jsonResponse({
        plugins: scope === "GLOBAL"
          ? [{
              plugin: remotePlugin(),
              enabled: false,
              disabled_skill_names: ["triage"],
            }]
          : [],
        pagination: {},
      });
    }
    if (parsed.pathname === "/ps/plugins/linear") {
      return jsonResponse(remotePlugin());
    }
    if (parsed.pathname === "/ps/plugins/linear/install") {
      return jsonResponse({ id: "linear", enabled: true });
    }
    if (parsed.pathname === "/ps/plugins/linear/uninstall") {
      return jsonResponse({ id: "linear", enabled: false });
    }
    return jsonResponse({ message: "not found" }, false, 404);
  };
}

function createEmptyRemoteInstalledFetcher(): Fetcher {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/ps/plugins/installed") {
      return jsonResponse({ plugins: [], pagination: {} });
    }
    return jsonResponse({ message: "not found" }, false, 404);
  };
}

function createRemoteBundleSyncFetcher(bundleGate?: Promise<void>): Fetcher {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/ps/plugins/installed") {
      const scope = parsed.searchParams.get("scope");
      return jsonResponse({
        plugins: scope === "GLOBAL"
          ? [{
              plugin: remotePlugin(),
              enabled: true,
              disabled_skill_names: [],
            }]
          : [],
        pagination: {},
      });
    }
    if (url === "https://agenc.tech/plugins/linear.tgz") {
      await bundleGate;
      return binaryResponse(createPluginBundleTarGz());
    }
    return jsonResponse({ message: "not found" }, false, 404);
  };
}

function remotePlugin() {
  return {
    id: "linear",
    name: "linear",
    scope: "GLOBAL",
    installation_policy: "AVAILABLE",
    authentication_policy: "ON_INSTALL",
    status: "AVAILABLE",
    release: {
      version: "1.0.0",
      display_name: "Linear",
      description: "Issue tracking",
      bundle_download_url: "https://agenc.tech/plugins/linear.tgz",
      app_ids: ["linear-app"],
      interface: {
        short_description: "Issue tracking",
        capabilities: ["issues"],
        screenshot_urls: [],
      },
      skills: [{
        name: "triage",
        description: "Prioritize issues",
        interface: {
          display_name: "Triage",
        },
      }],
    },
  };
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): FetchResponse {
  const text = JSON.stringify(body);
  const bytes = Buffer.from(text, "utf8");
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    text: async () => text,
    arrayBuffer: async () => exactArrayBuffer(bytes),
  };
}

function binaryResponse(bytes: Buffer, ok = true, status = ok ? 200 : 500): FetchResponse {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    text: async () => bytes.toString("utf8"),
    arrayBuffer: async () => exactArrayBuffer(bytes),
  };
}

function exactArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function createPluginBundleTarGz(): Buffer {
  return createTarGz({
    "linear/.agenc-plugin/plugin.json": JSON.stringify({
      name: "linear",
      version: "1.0.0",
      description: "Remote plugin",
      commands: "./commands",
    }),
    "linear/commands/hello.md": "# Hello\n",
  });
}

function createTarGz(files: Readonly<Record<string, string>>): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content, "utf8");
    chunks.push(createTarHeader(name, body.length), body, Buffer.alloc(padding(body.length)));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function createTarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function writeTarString(header: Buffer, offset: number, length: number, value: string): void {
  header.write(value.slice(0, length), offset, length, "utf8");
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  writeTarString(header, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function padding(size: number): number {
  return (512 - (size % 512)) % 512;
}
