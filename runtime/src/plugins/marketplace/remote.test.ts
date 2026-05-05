import { describe, expect, it } from "vitest";
import type { FetchResponse, Fetcher } from "./marketplace.js";
import {
  fetchRemoteInstalledPlugins,
  fetchRemoteMarketplaces,
  fetchRemotePluginDetailWithDownloadUrls,
  installRemotePlugin,
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
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    text: async () => text,
    arrayBuffer: async () => Buffer.from(text).buffer,
  };
}
