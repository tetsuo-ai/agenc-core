import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { acquireVerifiedPluginGeneration, hashInstalledPlugin } from "./plugin-catalog-cache.js";
import { ConfigStore } from "../config/store.js";
import { withPluginLifecycleMutation } from "./plugin-lifecycle-revision.js";

it("retains a shared generation while a second acquisition is pending", async () => {
  const home = await mkdtemp(join(tmpdir(), "agenc-plugin-lease-"));
  const root = join(home, "installed");
  try {
    await mkdir(root);
    await writeFile(join(root, "entry.js"), "x".repeat(8 * 1024 * 1024));
    const digest = hashInstalledPlugin(root);
    const first = acquireVerifiedPluginGeneration(root, undefined, digest, "sample");
    const second = acquireVerifiedPluginGeneration(root, undefined, digest, "sample");
    const firstLease = await first;
    firstLease.release();
    const secondLease = await second;
    try { expect(secondLease.isCurrent(secondLease.version)).toBe(true); }
    finally { secondLease.release(); }
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("retires a plugin generation when its canonical configuration reloads", async () => {
  const home = await mkdtemp(join(tmpdir(), "agenc-plugin-config-reload-"));
  const root = join(home, "installed");
  const configHome = join(home, "home");
  try {
    await mkdir(root); await mkdir(configHome);
    await writeFile(join(root, "entry.js"), "same");
    const store = new ConfigStore({ home: configHome, cwd: home, projectRoot: home, projectTrusted: false, env: {} });
    await store.reload();
    const acquire = () => acquireVerifiedPluginGeneration(root, undefined, hashInstalledPlugin(root), "sample", configHome);
    let lease = await acquire();
    const unrelated = await acquireVerifiedPluginGeneration(root, undefined, hashInstalledPlugin(root), "sample", join(home, "other-home"));
    await writeFile(join(configHome, "config.toml"), 'config_version = 2\n[plugins]\nenabled = true\n');
    await store.reload();
    expect(lease.isCurrent(lease.version)).toBe(false);
    lease.release();
    lease = await acquire();
    await writeFile(join(configHome, "config.toml"), 'config_version = 2\n[plugins]\nenabled = true\n[plugins.plugins.sample]\nenabled = true\n');
    await store.reload();
    expect(lease.isCurrent(lease.version)).toBe(false);
    expect(unrelated.isCurrent(unrelated.version)).toBe(true);
    lease.release();
    lease = await acquire();
    await writeFile(join(configHome, "config.toml"), 'config_version = 2\n[plugins]\nenabled = true\n[plugins.plugins.sample]\nenabled = true\n[plugins.plugins.sample.mcp_servers.main]\neager = true\n');
    await store.reload();
    expect(lease.isCurrent(lease.version)).toBe(false);
    lease.release();
    unrelated.release();
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("observes ConfigStore revocation published by another module instance", async () => {
  const home = await mkdtemp(join(tmpdir(), "agenc-plugin-config-isolate-"));
  const root = join(home, "installed");
  const configHome = join(home, "home");
  try {
    await mkdir(root); await mkdir(configHome);
    await writeFile(join(root, "entry.js"), "same");
    await writeFile(join(configHome, "config.toml"), "config_version = 2\n");
    const lease = await acquireVerifiedPluginGeneration(root, undefined, hashInstalledPlugin(root), "sample", configHome);
    vi.resetModules();
    const { ConfigStore: IsolatedStore } = await import("../config/store.js");
    const store = new IsolatedStore({ home: configHome, cwd: home, projectRoot: home, projectTrusted: false, env: {} });
    await store.reload();
    await writeFile(join(configHome, "config.toml"), 'config_version = 2\n[plugins.plugins.sample]\nenabled = false\n');
    await store.reload();
    expect(lease.isCurrent(lease.version)).toBe(false);
    lease.release();
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("does not verify old bytes while a lifecycle replacement holds the lock", async () => {
  const home = await mkdtemp(join(tmpdir(), "agenc-plugin-mutation-overlap-"));
  const root = join(home, "installed");
  try {
    await mkdir(root); await writeFile(join(root, "entry.js"), "old");
    const digest = hashInstalledPlugin(root);
    let begin!: () => void;
    let finish!: () => void;
    const begun = new Promise<void>(resolve => { begin = resolve; });
    const finishGate = new Promise<void>(resolve => { finish = resolve; });
    const mutation = withPluginLifecycleMutation(home, "sample", async () => {
      begin();
      await finishGate;
      await writeFile(join(root, "entry.js"), "new");
    });
    await begun;
    const acquisition = acquireVerifiedPluginGeneration(root, undefined, digest, "sample", home);
    let settled = false;
    void acquisition.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 80));
    try { expect(settled).toBe(false); }
    finally { finish(); await mutation; }
    await expect(acquisition).rejects.toThrow();
  } finally { await rm(home, { recursive: true, force: true }); }
});
