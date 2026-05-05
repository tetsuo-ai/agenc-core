import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProcessRunner } from "./marketplace.js";
import {
  curatedPluginsRepoPath,
  curatedPluginsShaPath,
  hasLocalCuratedPluginsSnapshot,
  syncCuratedPluginsRepoViaGit,
} from "./startup_sync.js";
import {
  hasStartupRemotePluginSyncMarker,
  startStartupRemotePluginSyncOnce,
} from "./startup_remote_sync.js";

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
