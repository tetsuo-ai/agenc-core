import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ watch: 0, poll: 0 }));
vi.mock("node:fs", async importOriginal => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: () => { calls.watch++; throw new Error("installation watcher created"); },
  watchFile: () => { calls.poll++; throw new Error("installation poller created"); },
}));

import { acquireVerifiedPluginGeneration, hashInstalledPlugin } from "./plugin-catalog-cache.js";

it("creates no watcher or poller for an installation or snapshot", async () => {
  const home = await mkdtemp(join(tmpdir(), "agenc-no-plugin-watch-"));
  const root = join(home, "installed");
  const snapshot = join(home, "snapshot");
  try {
    await mkdir(root); await mkdir(snapshot);
    await writeFile(join(root, "entry.js"), "same");
    await writeFile(join(snapshot, "entry.js"), "same");
    const lease = await acquireVerifiedPluginGeneration(root, snapshot, hashInstalledPlugin(root), "sample");
    try {
      expect(lease.isCurrent(lease.version)).toBe(true);
      expect(calls).toEqual({ watch: 0, poll: 0 });
    } finally { lease.release(); }
  } finally { await rm(home, { recursive: true, force: true }); }
});
