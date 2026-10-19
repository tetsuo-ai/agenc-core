import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";
import { isRemoteControlAuthorityPath, remoteControlAuthorityPaths } from "../../src/sandbox/remote-control-protection.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("captures link authority once per bound config generation and refreshes it on reload", async () => {
  const root = mkdtempSync(join(tmpdir(), "remote-cache-")); roots.push(root);
  const home = join(root, "home"), managed = join(root, "managed");
  mkdirSync(home); mkdirSync(managed);
  const first = join(root, "owner-first.toml"), second = join(root, "owner-second.toml");
  for (const path of [first, second]) writeFileSync(path, "config_version = 2\n");
  symlinkSync(first, join(home, "config.toml"));
  const store = new ConfigStore({ home, managedConfigPath: join(managed, "config.toml") });
  await store.reload();
  await runWithCanonicalSettingsAuthority(store, async () => {
    const paths = remoteControlAuthorityPaths();
    for (let i = 0; i < 1000; i += 1) {
      expect(remoteControlAuthorityPaths()).toBe(paths);
      expect(isRemoteControlAuthorityPath(first)).toBe(true);
    }
    rmSync(join(home, "config.toml")); symlinkSync(second, join(home, "config.toml"));
    await store.reload();
    expect(remoteControlAuthorityPaths()).toContain(second);
    expect(remoteControlAuthorityPaths()).not.toContain(first);
    expect(remoteControlAuthorityPaths()).not.toBe(paths);
    expect(isRemoteControlAuthorityPath(dirname(home))).toBe(false);
    expect(isRemoteControlAuthorityPath(join(root, "*.log"))).toBe(false);
    expect(isRemoteControlAuthorityPath(join(managed, "other-policy.json"))).toBe(false);
  });
});
