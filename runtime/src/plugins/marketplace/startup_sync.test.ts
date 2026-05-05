import { mkdtemp, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  marketplaceIndexPath,
  type FetchResponse,
  type Fetcher,
  type ProcessRunner,
} from "./marketplace.js";
import {
  curatedPluginsRepoPath,
  curatedPluginsShaPath,
  hasLocalCuratedPluginsSnapshot,
  syncCuratedPluginsRepo,
  syncCuratedPluginsRepoViaBackupArchive,
  syncCuratedPluginsRepoViaGit,
  syncCuratedPluginsRepoViaHttp,
} from "./startup_sync.js";
import {
  hasStartupRemotePluginSyncMarker,
  startStartupRemotePluginSyncOnce,
  startupRemotePluginSyncLockPath,
} from "./startup_remote_sync.js";
import {
  DEFAULT_REMOTE_PLUGIN_SERVICE_BASE_URL,
  performStartupChecks,
  REMOTE_PLUGIN_SERVICE_URL_ENV,
} from "./startup_checks.js";
import { syncRemoteInstalledPluginBundles } from "./remote.js";

describe("startup marketplace sync", () => {
  it("clones the curated marketplace only when the remote HEAD changed", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-startup-sync-"));
    const calls: string[] = [];
    const run: ProcessRunner = async (_command, args) => {
      calls.push(args.join(" "));
      if (args[0] === "ls-remote") {
        return { stdout: "abc123\tHEAD\n", stderr: "" };
      }
      if (args[0] === "clone") {
        const destination = args[args.length - 1]!;
        await writeCuratedMarketplace(destination);
        return { stdout: "", stderr: "" };
      }
      if (args.includes("rev-parse")) {
        return { stdout: "abc123\n", stderr: "" };
      }
      throw new Error(`unexpected git command: ${args.join(" ")}`);
    };

    await expect(syncCuratedPluginsRepoViaGit(
      agencHome,
      "https://agenc.tech/plugins/curated.git",
      "git",
      run,
    )).resolves.toBe("abc123");
    await expect(readFile(curatedPluginsShaPath(agencHome), "utf8"))
      .resolves.toBe("abc123\n");
    await expect(hasLocalCuratedPluginsSnapshot(agencHome)).resolves.toBe(true);

    await expect(syncCuratedPluginsRepoViaGit(
      agencHome,
      "https://agenc.tech/plugins/curated.git",
      "git",
      run,
    )).resolves.toBe("abc123");
    expect(calls.filter((call) => call.startsWith("clone "))).toHaveLength(1);
  });

  it("rejects unsafe curated marketplace git transports before running git", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-startup-sync-unsafe-git-"));
    const calls: string[] = [];

    await expect(syncCuratedPluginsRepoViaGit(
      agencHome,
      "ssh://git@agenc.tech/plugins/curated.git",
      "git",
      async (_command, args) => {
        calls.push(args.join(" "));
        return { stdout: "", stderr: "" };
      },
    )).rejects.toThrow("must use HTTPS or loopback HTTP");

    expect(calls).toEqual([]);
  });

  it("runs remote plugin sync once after curated marketplace prerequisites exist", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-startup-sync-"));
    await writeCuratedMarketplace(curatedPluginsRepoPath(agencHome));
    await writeFile(curatedPluginsShaPath(agencHome), "abc123\n");
    const additiveValues: boolean[] = [];

    const first = await startStartupRemotePluginSyncOnce({
      agencHome,
      prerequisiteTimeoutMs: 10,
      pollMs: 1,
      now: () => new Date("2026-05-05T00:00:00.000Z"),
      syncPluginsFromRemote: async (additiveOnly) => {
        additiveValues.push(additiveOnly);
        return {
          installedPluginIds: ["linear"],
          failedRemotePluginIds: [],
          enabledPluginIds: ["linear"],
          disabledPluginIds: [],
          uninstalledPluginIds: [],
        };
      },
    });

    expect(first?.installedPluginIds).toEqual(["linear"]);
    expect(additiveValues).toEqual([true]);
    await expect(hasStartupRemotePluginSyncMarker(agencHome)).resolves.toBe(true);
    await expect(startStartupRemotePluginSyncOnce({
      agencHome,
      prerequisiteTimeoutMs: 10,
      pollMs: 1,
      syncPluginsFromRemote: async () => {
        throw new Error("should not run twice");
      },
    })).resolves.toBeNull();
  });

  it("can run startup remote plugin sync through the concrete remote bundle reconciler", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-startup-sync-concrete-"));
    await writeCuratedMarketplace(curatedPluginsRepoPath(agencHome));
    await writeFile(curatedPluginsShaPath(agencHome), "abc123\n");
    const calls: string[] = [];

    const result = await startStartupRemotePluginSyncOnce({
      agencHome,
      prerequisiteTimeoutMs: 10,
      pollMs: 1,
      now: () => new Date("2026-05-05T00:00:00.000Z"),
      remotePluginServiceConfig: { baseUrl: "https://agenc.tech" },
      remoteAuth: { headers: { Authorization: "Bearer test" } },
      fetcher: async (url) => {
        const parsed = new URL(url);
        calls.push(parsed.pathname);
        if (parsed.pathname === "/ps/plugins/installed") {
          return jsonResponse({ plugins: [], pagination: {} });
        }
        return jsonResponse({ message: "not found" }, false, 404);
      },
    });

    expect(result).toEqual({
      installedPluginIds: [],
      failedRemotePluginIds: [],
      enabledPluginIds: [],
      disabledPluginIds: [],
      uninstalledPluginIds: [],
    });
    expect(calls).toEqual(["/ps/plugins/installed", "/ps/plugins/installed"]);
    await expect(hasStartupRemotePluginSyncMarker(agencHome)).resolves.toBe(true);
  });

  it("does not write the startup marker when concrete remote bundle sync has failures", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-startup-sync-failed-bundle-"));
    await writeCuratedMarketplace(curatedPluginsRepoPath(agencHome));
    await writeFile(curatedPluginsShaPath(agencHome), "abc123\n");

    const result = await startStartupRemotePluginSyncOnce({
      agencHome,
      prerequisiteTimeoutMs: 10,
      pollMs: 1,
      now: () => new Date("2026-05-05T00:00:00.000Z"),
      remotePluginServiceConfig: { baseUrl: "https://agenc.tech" },
      remoteAuth: { headers: { Authorization: "Bearer test" } },
      fetcher: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/ps/plugins/installed") {
          return jsonResponse({
            plugins: [{
              plugin: {
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
                  interface: {
                    short_description: "Issue tracking",
                    screenshot_urls: [],
                  },
                  skills: [],
                },
              },
              enabled: true,
              disabled_skill_names: [],
            }],
            pagination: {},
          });
        }
        if (url === "https://agenc.tech/plugins/linear.tgz") {
          return jsonResponse({ message: "temporarily unavailable" }, false, 503);
        }
        return jsonResponse({ message: "not found" }, false, 404);
      },
    });

    expect(result).toEqual({
      installedPluginIds: [],
      failedRemotePluginIds: ["linear"],
      enabledPluginIds: [],
      disabledPluginIds: [],
      uninstalledPluginIds: [],
    });
    await expect(hasStartupRemotePluginSyncMarker(agencHome)).resolves.toBe(false);
  });

  it("runs the live startup checks through the AgenC-owned marketplace layer", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-startup-checks-owned-"));
    let state = { plugins: { needsRefresh: false } };
    const setAppState = (update: (prev: typeof state) => typeof state) => {
      state = update(state);
    };

    await performStartupChecks(setAppState, {
      trustAccepted: true,
      agencHome,
      runProcess: async (_command, args) => {
        if (args[0] === "ls-remote") {
          return { stdout: "abc123\tHEAD\n", stderr: "" };
        }
        if (args[0] === "clone") {
          const destination = args[args.length - 1]!;
          await writeCuratedMarketplace(destination);
          return { stdout: "", stderr: "" };
        }
        if (args.includes("rev-parse")) {
          return { stdout: "abc123\n", stderr: "" };
        }
        throw new Error(`unexpected git command: ${args.join(" ")}`);
      },
    });

    expect(state.plugins.needsRefresh).toBe(true);
    await expect(hasLocalCuratedPluginsSnapshot(agencHome)).resolves.toBe(true);
  });

  it("marks refresh when trusted startup rematerializes a missing curated snapshot with the same SHA", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-startup-checks-same-sha-missing-snapshot-"));
    await mkdir(join(agencHome, "plugins", "marketplaces"), { recursive: true });
    await writeFile(curatedPluginsShaPath(agencHome), "abc123\n");
    let state = { plugins: { needsRefresh: false } };
    const setAppState = (update: (prev: typeof state) => typeof state) => {
      state = update(state);
    };

    await performStartupChecks(setAppState, {
      trustAccepted: true,
      agencHome,
      runProcess: async (_command, args) => {
        if (args[0] === "ls-remote") {
          return { stdout: "abc123\tHEAD\n", stderr: "" };
        }
        if (args[0] === "clone") {
          const destination = args[args.length - 1]!;
          await writeCuratedMarketplace(destination);
          return { stdout: "", stderr: "" };
        }
        if (args.includes("rev-parse")) {
          return { stdout: "abc123\n", stderr: "" };
        }
        throw new Error(`unexpected git command: ${args.join(" ")}`);
      },
    });

    expect(state.plugins.needsRefresh).toBe(true);
    await expect(hasLocalCuratedPluginsSnapshot(agencHome)).resolves.toBe(true);
  });

  it("skips all startup install work until workspace trust is accepted", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-startup-checks-untrusted-"));
    let state = { plugins: { needsRefresh: false } };
    const setAppState = (update: (prev: typeof state) => typeof state) => {
      state = update(state);
    };
    const marketplaceRoot = join(agencHome, "team-marketplace");
    await writeLocalMarketplace(marketplaceRoot, "team");
    let touchedExternalWork = false;

    await performStartupChecks(setAppState, {
      trustAccepted: false,
      agencHome,
      declaredMarketplaces: {
        team: { source: { source: "local", path: marketplaceRoot } },
      },
      runProcess: async () => {
        touchedExternalWork = true;
        throw new Error("should not run git");
      },
      remoteFetcher: async () => {
        touchedExternalWork = true;
        throw new Error("should not fetch remote plugins");
      },
      remoteAuth: { headers: { authorization: "Bearer test" } },
      remotePluginServiceConfig: { baseUrl: "https://agenc.tech" },
    });

    expect(touchedExternalWork).toBe(false);
    expect(state.plugins.needsRefresh).toBe(false);
    await expect(readFile(marketplaceIndexPath({ agencHome }), "utf8"))
      .rejects.toThrow();
  });

  it("reconciles declared marketplaces during trusted startup checks", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-startup-checks-reconcile-"));
    const marketplaceRoot = join(agencHome, "team-marketplace");
    await writeLocalMarketplace(marketplaceRoot, "team");
    let state = {
      plugins: {
        needsRefresh: false,
        installationStatus: { marketplaces: [], plugins: [] as unknown[] },
      },
    };
    const setAppState = (update: (prev: typeof state) => typeof state) => {
      state = update(state);
    };

    await performStartupChecks(setAppState, {
      trustAccepted: true,
      agencHome,
      declaredMarketplaces: {
        team: {
          source: { source: "local", path: marketplaceRoot },
          autoUpdate: true,
        },
      },
      runProcess: curatedGitRunner("abc123"),
    });

    const index = JSON.parse(await readFile(marketplaceIndexPath({ agencHome }), "utf8")) as {
      marketplaces: Record<string, { autoUpdate?: boolean; sourceType?: string }>;
    };
    expect(index.marketplaces.team?.sourceType).toBe("local");
    expect(index.marketplaces.team?.autoUpdate).toBe(true);
    expect(state.plugins.needsRefresh).toBe(true);
    expect(state.plugins.installationStatus.marketplaces)
      .toContainEqual({ name: "team", status: "installed" });
  });

  it("registers marketplaces from AGENC_PLUGIN_SEED_DIR during trusted startup checks", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-startup-checks-seed-"));
    const seedDir = await mkdtemp(join(tmpdir(), "agenc-plugin-seed-"));
    const seededMarketplaceRoot = join(seedDir, "marketplaces", "seeded");
    await writeLocalMarketplace(seededMarketplaceRoot, "seeded");
    await writeFile(
      join(seedDir, "known_marketplaces.json"),
      `${JSON.stringify({
        seeded: {
          source: { source: "local", path: "/build-time/seeded" },
          installLocation: "/build-time/seeded",
          lastUpdated: "2026-05-05T00:00:00.000Z",
        },
      }, null, 2)}\n`,
    );
    let state = { plugins: { needsRefresh: false } };
    const setAppState = (update: (prev: typeof state) => typeof state) => {
      state = update(state);
    };

    await performStartupChecks(setAppState, {
      trustAccepted: true,
      agencHome,
      env: { AGENC_PLUGIN_SEED_DIR: seedDir },
      runProcess: curatedGitRunner("abc123"),
    });

    const index = JSON.parse(await readFile(marketplaceIndexPath({ agencHome }), "utf8")) as {
      marketplaces: Record<string, {
        autoUpdate?: boolean;
        installedPath?: string;
        manifestPath?: string;
        source?: string;
        sourceDescriptor?: { source?: string; path?: string };
        sourceType?: string;
      }>;
    };
    expect(index.marketplaces.seeded?.manifestPath).toBe(join(seededMarketplaceRoot, "marketplace.json"));
    expect(index.marketplaces.seeded?.installedPath).toBe(seededMarketplaceRoot);
    expect(index.marketplaces.seeded?.source).toBe(seededMarketplaceRoot);
    expect(index.marketplaces.seeded?.sourceDescriptor).toEqual({
      source: "local",
      path: seededMarketplaceRoot,
    });
    expect(index.marketplaces.seeded?.sourceType).toBe("local");
    expect(index.marketplaces.seeded?.autoUpdate).toBe(false);
    expect(state.plugins.needsRefresh).toBe(true);
  });

  it("rejects unsafe seed marketplace names before path lookup and persistence", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-startup-checks-seed-safe-names-"));
    const seedDir = await mkdtemp(join(tmpdir(), "agenc-plugin-seed-safe-names-"));
    const safeMarketplaceRoot = join(seedDir, "marketplaces", "safe");
    await writeLocalMarketplace(safeMarketplaceRoot, "safe");
    await writeLocalMarketplace(join(seedDir, "outside"), "outside");
    await writeLocalMarketplace(join(seedDir, "marketplaces", "absolute"), "absolute");
    await writeLocalMarketplace(join(seedDir, "marketplaces", "C:\\outside"), "windows");
    await writeFile(
      join(seedDir, "known_marketplaces.json"),
      `${JSON.stringify({
        " safe ": {
          source: { source: "local", path: "/build-time/safe" },
          lastUpdated: "2026-05-05T00:00:00.000Z",
        },
        safe: {
          source: { source: "local", path: "/duplicate/safe" },
          lastUpdated: "2026-05-06T00:00:00.000Z",
        },
        "../outside": { source: { source: "local", path: "/build-time/outside" } },
        "/absolute": { source: { source: "local", path: "/build-time/absolute" } },
        "C:\\outside": { source: { source: "local", path: "/build-time/windows" } },
      }, null, 2)}\n`,
    );
    let state = { plugins: { needsRefresh: false } };
    const setAppState = (update: (prev: typeof state) => typeof state) => {
      state = update(state);
    };

    await performStartupChecks(setAppState, {
      trustAccepted: true,
      agencHome,
      env: { AGENC_PLUGIN_SEED_DIR: seedDir },
      runProcess: curatedGitRunner("abc123"),
    });

    const index = JSON.parse(await readFile(marketplaceIndexPath({ agencHome }), "utf8")) as {
      marketplaces: Record<string, {
        installedPath?: string;
        sourceDescriptor?: { source?: string; path?: string };
        updatedAt?: string;
      }>;
    };
    expect(Object.keys(index.marketplaces)).toEqual(["safe"]);
    expect(index.marketplaces.safe?.installedPath).toBe(safeMarketplaceRoot);
    expect(index.marketplaces.safe?.sourceDescriptor).toEqual({
      source: "local",
      path: safeMarketplaceRoot,
    });
    expect(index.marketplaces.safe?.updatedAt).toBe("2026-05-05T00:00:00.000Z");
    expect(state.plugins.needsRefresh).toBe(true);
  });

  it("marks plugins for refresh when later startup work fails after marketplace reconciliation", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-startup-checks-partial-failure-"));
    const marketplaceRoot = join(agencHome, "team-marketplace");
    await writeLocalMarketplace(marketplaceRoot, "team");
    let state = { plugins: { needsRefresh: false } };
    const setAppState = (update: (prev: typeof state) => typeof state) => {
      state = update(state);
    };
    const warnings: string[] = [];

    await performStartupChecks(setAppState, {
      trustAccepted: true,
      agencHome,
      declaredMarketplaces: {
        team: { source: { source: "local", path: marketplaceRoot } },
      },
      runProcess: async () => {
        throw new Error("git unavailable");
      },
      fetcher: async () => jsonResponse({ message: "offline" }, false, 503),
      onWarn: (message) => warnings.push(message),
    });

    const index = JSON.parse(await readFile(marketplaceIndexPath({ agencHome }), "utf8")) as {
      marketplaces: Record<string, unknown>;
    };
    expect(index.marketplaces.team).toBeDefined();
    expect(state.plugins.needsRefresh).toBe(true);
    expect(warnings.join("\n")).toContain("startup plugin checks failed");
  });

  it("marks plugins for refresh when remote startup sync only changes enablement", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-startup-checks-remote-enable-"));
    await writeCuratedMarketplace(curatedPluginsRepoPath(agencHome));
    await writeFile(curatedPluginsShaPath(agencHome), "abc123\n");
    let state = { plugins: { needsRefresh: false } };
    const setAppState = (update: (prev: typeof state) => typeof state) => {
      state = update(state);
    };

    await performStartupChecks(setAppState, {
      trustAccepted: true,
      agencHome,
      runProcess: curatedGitRunner("abc123"),
      prerequisiteTimeoutMs: 10,
      pollMs: 1,
      syncPluginsFromRemote: async () => ({
        installedPluginIds: [],
        failedRemotePluginIds: [],
        enabledPluginIds: ["alpha"],
        disabledPluginIds: ["beta"],
        uninstalledPluginIds: [],
      }),
    });

    expect(state.plugins.needsRefresh).toBe(true);
  });

  it("uses remote auth state from the auth layer for live startup remote sync", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-startup-checks-remote-auth-"));
    let state = { plugins: { needsRefresh: false } };
    const setAppState = (update: (prev: typeof state) => typeof state) => {
      state = update(state);
    };
    const calls: Array<{ readonly path: string; readonly authorization?: string }> = [];

    await performStartupChecks(setAppState, {
      trustAccepted: true,
      agencHome,
      env: {
        AGENC_REMOTE_AUTH_TOKEN: "remote-token",
        [REMOTE_PLUGIN_SERVICE_URL_ENV]: DEFAULT_REMOTE_PLUGIN_SERVICE_BASE_URL,
      },
      runProcess: curatedGitRunner("abc123"),
      prerequisiteTimeoutMs: 10,
      pollMs: 1,
      remoteFetcher: async (url, init) => {
        const parsed = new URL(url);
        calls.push({
          path: parsed.pathname,
          authorization: init?.headers?.authorization,
        });
        if (parsed.pathname === "/ps/plugins/installed") {
          return jsonResponse({ plugins: [], pagination: {} });
        }
        return jsonResponse({ message: "not found" }, false, 404);
      },
    });

    expect(calls).toEqual([
      { path: "/ps/plugins/installed", authorization: "Bearer remote-token" },
      { path: "/ps/plugins/installed", authorization: "Bearer remote-token" },
    ]);
    await expect(hasStartupRemotePluginSyncMarker(agencHome)).resolves.toBe(true);
  });

  it("does not send startup auth headers to loopback HTTP unless explicitly allowed", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-startup-checks-loopback-auth-"));
    let state = { plugins: { needsRefresh: false } };
    const setAppState = (update: (prev: typeof state) => typeof state) => {
      state = update(state);
    };
    const calls: string[] = [];
    const warnings: string[] = [];

    await performStartupChecks(setAppState, {
      trustAccepted: true,
      agencHome,
      env: {
        AGENC_REMOTE_AUTH_TOKEN: "remote-token",
        [REMOTE_PLUGIN_SERVICE_URL_ENV]: "http://127.0.0.1:4173",
      },
      runProcess: curatedGitRunner("abc123"),
      prerequisiteTimeoutMs: 10,
      pollMs: 1,
      remoteFetcher: async (url, init) => {
        calls.push(`${url} ${init?.headers?.authorization ?? ""}`);
        return jsonResponse({ plugins: [], pagination: {} });
      },
      onWarn: (message) => warnings.push(message),
    });

    expect(calls).toEqual([]);
    expect(warnings.join("\n")).toContain("remote plugin API URL must use HTTPS");
    expect(state.plugins.needsRefresh).toBe(true);
  });

  it("keeps the live REPL startup import on the AgenC-owned marketplace path", async () => {
    const repl = await readFile(join(process.cwd(), "src/agenc/upstream/screens/REPL.tsx"), "utf8");

    expect(repl).toContain("src/plugins/marketplace/startup_checks.js");
    expect(repl).not.toContain("src/utils/plugins/performStartupChecks.js");
    expect(repl).toContain("trustAccepted: checkHasTrustDialogAccepted()");
    expect(repl).toContain("config: getGlobalConfig()");
  });

  it("uses the existing curated snapshot when refresh mechanisms fail", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-startup-sync-existing-"));
    await writeCuratedMarketplace(curatedPluginsRepoPath(agencHome));
    await writeFile(curatedPluginsShaPath(agencHome), "abc123\n");

    await expect(syncCuratedPluginsRepo(agencHome, {
      runProcess: async () => {
        throw new Error("git unavailable");
      },
      fetcher: async () => jsonResponse({ message: "offline" }, false, 503),
    })).resolves.toBe("abc123");
  });

  it("coalesces concurrent remote startup sync attempts with a filesystem lock", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-startup-sync-concurrent-"));
    await writeCuratedMarketplace(curatedPluginsRepoPath(agencHome));
    await writeFile(curatedPluginsShaPath(agencHome), "abc123\n");
    const additiveValues: boolean[] = [];
    let releaseSync = () => {};
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });

    const first = startStartupRemotePluginSyncOnce({
      agencHome,
      prerequisiteTimeoutMs: 10,
      pollMs: 1,
      now: () => new Date("2026-05-05T00:00:00.000Z"),
      syncPluginsFromRemote: async (additiveOnly) => {
        additiveValues.push(additiveOnly);
        await syncGate;
        return {
          installedPluginIds: ["linear"],
          failedRemotePluginIds: [],
          enabledPluginIds: ["linear"],
          disabledPluginIds: [],
          uninstalledPluginIds: [],
        };
      },
    });
    const second = startStartupRemotePluginSyncOnce({
      agencHome,
      prerequisiteTimeoutMs: 10,
      pollMs: 1,
      syncPluginsFromRemote: async (additiveOnly) => {
        additiveValues.push(additiveOnly);
        return {
          installedPluginIds: ["second"],
          failedRemotePluginIds: [],
          enabledPluginIds: ["second"],
          disabledPluginIds: [],
          uninstalledPluginIds: [],
        };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseSync();
    const results = await Promise.all([first, second]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(additiveValues).toEqual([true]);
    await expect(hasStartupRemotePluginSyncMarker(agencHome)).resolves.toBe(true);
  });

  it("recovers stale remote startup sync lock directories", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-startup-sync-stale-"));
    await writeCuratedMarketplace(curatedPluginsRepoPath(agencHome));
    await writeFile(curatedPluginsShaPath(agencHome), "abc123\n");
    const lockPath = startupRemotePluginSyncLockPath(agencHome);
    await mkdir(lockPath, { recursive: true });
    const stale = new Date("2026-05-05T00:00:00.000Z");
    await utimes(lockPath, stale, stale);

    const result = await startStartupRemotePluginSyncOnce({
      agencHome,
      prerequisiteTimeoutMs: 10,
      pollMs: 1,
      now: () => new Date("2026-05-05T00:20:00.000Z"),
      syncPluginsFromRemote: async () => ({
        installedPluginIds: ["linear"],
        failedRemotePluginIds: [],
        enabledPluginIds: ["linear"],
        disabledPluginIds: [],
        uninstalledPluginIds: [],
      }),
    });

    expect(result?.installedPluginIds).toEqual(["linear"]);
  });

  it("does not throw when concurrent attempts race over a stale lock", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-startup-sync-stale-race-"));
    await writeCuratedMarketplace(curatedPluginsRepoPath(agencHome));
    await writeFile(curatedPluginsShaPath(agencHome), "abc123\n");
    const lockPath = startupRemotePluginSyncLockPath(agencHome);
    await mkdir(lockPath, { recursive: true });
    const stale = new Date("2026-05-05T00:00:00.000Z");
    await utimes(lockPath, stale, stale);

    const attempts = await Promise.allSettled([
      startStartupRemotePluginSyncOnce({
        agencHome,
        prerequisiteTimeoutMs: 10,
        pollMs: 1,
        now: () => new Date("2026-05-05T00:20:00.000Z"),
        syncPluginsFromRemote: async () => ({
          installedPluginIds: ["first"],
          failedRemotePluginIds: [],
          enabledPluginIds: ["first"],
          disabledPluginIds: [],
          uninstalledPluginIds: [],
        }),
      }),
      startStartupRemotePluginSyncOnce({
        agencHome,
        prerequisiteTimeoutMs: 10,
        pollMs: 1,
        now: () => new Date("2026-05-05T00:20:00.000Z"),
        syncPluginsFromRemote: async () => ({
          installedPluginIds: ["second"],
          failedRemotePluginIds: [],
          enabledPluginIds: ["second"],
          disabledPluginIds: [],
          uninstalledPluginIds: [],
        }),
      }),
    ]);

    expect(attempts.every((attempt) => attempt.status === "fulfilled")).toBe(true);
    expect(attempts
      .filter((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof startStartupRemotePluginSyncOnce>>> =>
        attempt.status === "fulfilled")
      .filter((attempt) => attempt.value !== null)).toHaveLength(1);
  });

  it("does not write the startup marker when remote bundle sync is already in flight", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-remote-startup-sync-in-flight-"));
    await writeCuratedMarketplace(curatedPluginsRepoPath(agencHome));
    await writeFile(curatedPluginsShaPath(agencHome), "abc123\n");
    let releaseDirectSync = () => {};
    const directSyncGate = new Promise<void>((resolve) => {
      releaseDirectSync = resolve;
    });
    const remotePluginServiceConfig = { baseUrl: "https://agenc.tech" };
    const remoteAuth = { headers: { Authorization: "Bearer test" } };
    const directSync = syncRemoteInstalledPluginBundles(
      agencHome,
      remotePluginServiceConfig,
      remoteAuth,
      {
        fetcher: async (url) => {
          const parsed = new URL(url);
          if (parsed.pathname === "/ps/plugins/installed") {
            await directSyncGate;
            return jsonResponse({ plugins: [], pagination: {} });
          }
          return jsonResponse({ message: "not found" }, false, 404);
        },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(startStartupRemotePluginSyncOnce({
      agencHome,
      prerequisiteTimeoutMs: 10,
      pollMs: 1,
      remotePluginServiceConfig,
      remoteAuth,
      fetcher: async () => {
        throw new Error("startup should skip while direct sync is in flight");
      },
    })).resolves.toBeNull();
    await expect(hasStartupRemotePluginSyncMarker(agencHome)).resolves.toBe(false);

    releaseDirectSync();
    await directSync;
  });

  it("syncs curated marketplace zipballs without shelling out to unzip", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-http-startup-sync-"));
    const zipball = createZip({
      "repo/.agents/plugins/marketplace.json": JSON.stringify({
        metadata: { name: "agenc-curated" },
        plugins: [],
      }),
      "repo/.git/HEAD": "abc123\n",
    });
    const runCalls: string[] = [];

    await expect(syncCuratedPluginsRepoViaHttp(
      agencHome,
      "https://agenc.tech/api/plugins/curated",
      createCuratedZipFetcher(zipball, "abc123"),
      async (command, args) => {
        runCalls.push(`${command} ${args.join(" ")}`);
        return { stdout: "", stderr: "" };
      },
    )).resolves.toBe("abc123");

    expect(runCalls).toEqual([]);
    await expect(readFile(join(curatedPluginsRepoPath(agencHome), ".agents", "plugins", "marketplace.json"), "utf8"))
      .resolves.toContain("agenc-curated");
  });

  it("rejects curated marketplace zipballs whose embedded git identity differs from advertised SHA", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-http-startup-sync-sha-mismatch-"));
    const zipball = createZip({
      "repo/.agents/plugins/marketplace.json": JSON.stringify({
        metadata: { name: "agenc-curated" },
        plugins: [],
      }),
      "repo/.git/HEAD": "different-sha\n",
    });

    await expect(syncCuratedPluginsRepoViaHttp(
      agencHome,
      "https://agenc.tech/api/plugins/curated",
      createCuratedZipFetcher(zipball, "abc123"),
    )).rejects.toThrow("archive git identity mismatch");
  });

  it("rejects curated marketplace zipballs with same-size corrupted entry contents", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-http-startup-sync-crc-mismatch-"));
    const zipball = corruptZipEntryPayload(createZip({
      "repo/.agents/plugins/marketplace.json": JSON.stringify({
        metadata: { name: "agenc-curated" },
        plugins: [],
      }),
      "repo/.git/HEAD": "abc123\n",
    }), "repo/.agents/plugins/marketplace.json");

    await expect(syncCuratedPluginsRepoViaHttp(
      agencHome,
      "https://agenc.tech/api/plugins/curated",
      createCuratedZipFetcher(zipball, "abc123"),
    )).rejects.toThrow("CRC mismatch");
  });

  it("rejects curated marketplace zipballs that escape the extraction root", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-http-startup-sync-slip-"));
    const zipball = createZip({
      "repo/.agents/plugins/marketplace.json": JSON.stringify({
        metadata: { name: "agenc-curated" },
        plugins: [],
      }),
      "repo/../escape.txt": "x",
    });

    await expect(syncCuratedPluginsRepoViaHttp(
      agencHome,
      "https://agenc.tech/api/plugins/curated",
      createCuratedZipFetcher(zipball, "abc123"),
    )).rejects.toThrow("escapes extraction root");
  });

  it("rejects unsafe backup archive redirects", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-backup-startup-sync-redirect-"));

    await expect(syncCuratedPluginsRepoViaBackupArchive(
      agencHome,
      "https://agenc.tech/api/plugins/curated/archive",
      async (url) => {
        if (url.endsWith("/archive")) {
          return jsonResponse({ download_url: "http://agenc.tech/plugins/curated.zip?token=secret" });
        }
        return jsonResponse({ message: "not found" }, false, 404);
      },
    )).rejects.toThrow("must use HTTPS");
  });
});

async function writeCuratedMarketplace(destination: string): Promise<void> {
  await mkdir(join(destination, ".git"), { recursive: true });
  await mkdir(join(destination, ".agents", "plugins"), { recursive: true });
  await writeFile(
    join(destination, ".agents", "plugins", "marketplace.json"),
    `${JSON.stringify({
      metadata: { name: "agenc-curated" },
      plugins: [],
    }, null, 2)}\n`,
  );
}

async function writeLocalMarketplace(destination: string, name: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  await writeFile(
    join(destination, "marketplace.json"),
    `${JSON.stringify({
      metadata: { name },
      plugins: [],
    }, null, 2)}\n`,
  );
}

function curatedGitRunner(sha: string): ProcessRunner {
  return async (_command, args) => {
    if (args[0] === "ls-remote") {
      return { stdout: `${sha}\tHEAD\n`, stderr: "" };
    }
    if (args[0] === "clone") {
      const destination = args[args.length - 1]!;
      await writeCuratedMarketplace(destination);
      return { stdout: "", stderr: "" };
    }
    if (args.includes("rev-parse")) {
      return { stdout: `${sha}\n`, stderr: "" };
    }
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  };
}

function createCuratedZipFetcher(zipball: Buffer, sha: string): Fetcher {
  return async (url) => {
    if (url.endsWith("/sha")) return jsonResponse({ sha });
    if (url.includes("/zipball/")) return binaryResponse(zipball);
    return jsonResponse({ message: "not found" }, false, 404);
  };
}

function createZip(files: Readonly<Record<string, string>>): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8");
    const body = Buffer.from(content, "utf8");
    const crc = crc32(body);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(body.byteLength, 18);
    localHeader.writeUInt32LE(body.byteLength, 22);
    localHeader.writeUInt16LE(nameBytes.byteLength, 26);
    localChunks.push(localHeader, nameBytes, body);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(body.byteLength, 20);
    centralHeader.writeUInt32LE(body.byteLength, 24);
    centralHeader.writeUInt16LE(nameBytes.byteLength, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralChunks.push(centralHeader, nameBytes);

    offset += localHeader.byteLength + nameBytes.byteLength + body.byteLength;
  }
  const centralDirectory = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralDirectory.byteLength, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localChunks, centralDirectory, eocd]);
}

function corruptZipEntryPayload(zipball: Buffer, entryName: string): Buffer {
  const corrupted = Buffer.from(zipball);
  let offset = 0;
  while (offset + 30 <= corrupted.byteLength) {
    if (corrupted.readUInt32LE(offset) !== 0x04034b50) break;
    const compressedSize = corrupted.readUInt32LE(offset + 18);
    const nameLength = corrupted.readUInt16LE(offset + 26);
    const extraLength = corrupted.readUInt16LE(offset + 28);
    const name = corrupted.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const dataStart = offset + 30 + nameLength + extraLength;
    if (name === entryName) {
      corrupted[dataStart] = (corrupted[dataStart] ?? 0) ^ 0x01;
      return corrupted;
    }
    offset = dataStart + compressedSize;
  }
  throw new Error(`zip entry not found: ${entryName}`);
}

const CRC32_TABLE = makeCrc32Table();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
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
