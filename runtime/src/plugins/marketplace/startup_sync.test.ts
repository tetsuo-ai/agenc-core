import { mkdtemp, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchResponse, Fetcher, ProcessRunner } from "./marketplace.js";
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
import { performStartupChecks } from "./startup_checks.js";

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
      enabledPluginIds: [],
      disabledPluginIds: [],
      uninstalledPluginIds: [],
    });
    expect(calls).toEqual(["/ps/plugins/installed", "/ps/plugins/installed"]);
    await expect(hasStartupRemotePluginSyncMarker(agencHome)).resolves.toBe(true);
  });

  it("runs the live startup checks through the AgenC-owned marketplace layer", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-startup-checks-owned-"));
    let state = { plugins: { needsRefresh: false } };
    const setAppState = (update: (prev: typeof state) => typeof state) => {
      state = update(state);
    };

    await performStartupChecks(setAppState, {
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

  it("keeps the live REPL startup import on the AgenC-owned marketplace path", async () => {
    const repl = await readFile(join(process.cwd(), "src/agenc/upstream/screens/REPL.tsx"), "utf8");

    expect(repl).toContain("src/plugins/marketplace/startup_checks.js");
    expect(repl).not.toContain("src/utils/plugins/performStartupChecks.js");
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
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(body.byteLength, 18);
    localHeader.writeUInt32LE(body.byteLength, 22);
    localHeader.writeUInt16LE(nameBytes.byteLength, 26);
    localChunks.push(localHeader, nameBytes, body);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(0, 16);
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
