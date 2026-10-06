import { chmod, link, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tryReadDaemonAutostart } from "../../src/app-server/daemon-autostart-projection.js";
import { shouldAutostartAgenCDaemon } from "../../src/app-server/daemon-autostart.js";
import { loadCanonicalDaemonConfig } from "../../src/config/repository.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agenc-autostart-projection-"));
  roots.push(root);
  const home = join(root, "home");
  const managed = join(root, "managed");
  await mkdir(home);
  await mkdir(join(managed, "config.d"), { recursive: true });
  const env: NodeJS.ProcessEnv = { AGENC_HOME: home };
  const paths = { managedConfigPath: join(managed, "config.toml") };
  const project = () => tryReadDaemonAutostart(env, home, paths);
  const canonical = async () => (await loadCanonicalDaemonConfig({ env, home, ...paths })).config.daemon?.autostart ?? true;
  const write = (path: string, content: string) => writeFile(path, "config_version = 2\n" + content, { mode: 0o600 });
  return { root, home, managed, env, paths, project, canonical, write };
}

describe("daemon-global autostart projection", () => {
  it("matches defaults and ignores workspace-looking paths", async () => {
    const f = await fixture();
    await mkdir(join(f.home, ".agenc"));
    await writeFile(join(f.home, ".agenc", "config.toml"), "invalid workspace content");
    expect(await f.project()).toBe(await f.canonical());
    expect(await f.project()).toBe(true);
  });
  it.each([
    "model = 'gpt-5'\n", "[daemon]\nautostart = false\n", "daemon.autostart = true\n",
    "daemon = { autostart = false }\n", "[daemon]\nagent_stop_timeout_ms = 1234\n",
  ])("matches the canonical user projection for %s", async content => {
    const f = await fixture();
    await f.write(join(f.home, "config.toml"), content);
    expect(await f.project()).toBe(await f.canonical());
  });
  it("matches managed precedence and sorted drop-ins, skipping hidden and non-TOML files", async () => {
    const f = await fixture();
    await f.write(join(f.home, "config.toml"), "daemon.autostart = false\n");
    await f.write(f.paths.managedConfigPath, "daemon.autostart = true\n");
    expect(await f.project()).toBe(await f.canonical());
    expect(await f.project()).toBe(true);
    const dir = join(f.managed, "config.d");
    await f.write(join(dir, "20-last.toml"), "daemon.autostart = false\n");
    await f.write(join(dir, "10-first.toml"), "daemon.autostart = true\n");
    await f.write(join(dir, "30-empty.toml"), "[daemon]\n");
    await writeFile(join(dir, ".hidden.toml"), "invalid");
    await writeFile(join(dir, "99-ignore.txt"), "invalid");
    expect(await f.project()).toBe(await f.canonical());
    expect(await f.project()).toBe(false);
  });
  it.each(["0", "false", " off ", "1", "TRUE", "", "unexpected"])("keeps explicit environment switch %s precedence", async value => {
    const f = await fixture();
    f.env.AGENC_DAEMON_AUTOSTART = value;
    await f.write(f.paths.managedConfigPath, "daemon.autostart = false\n");
    expect(shouldAutostartAgenCDaemon(f.env, (await f.project())!)).toBe(
      shouldAutostartAgenCDaemon(f.env, await f.canonical()),
    );
  });
  it.each([
    "config_version = 1\n", "config_version = 2\n[daemon\n", "config_version = 2\ndaemon = false\n",
    "config_version = 2\ndaemon.autostart = 'false'\n",
    "config_version = 2\ndaemon.autostart = true\ndaemon.autostart = false\n",
  ])("defers invalid versions, syntax, types and duplicates to the canonical error: %s", async text => {
    const f = await fixture();
    await writeFile(join(f.home, "config.toml"), text);
    expect(await f.project()).toBeNull();
    await expect(f.canonical()).rejects.toThrow();
  });
  it("uses canonical validation for selected profiles", async () => {
    const f = await fixture();
    f.env.AGENC_PROFILE = "selected";
    expect(await f.project()).toBeNull();
  });
  it("allows a stable user symlink but rejects duplicate physical authorities", async () => {
    const f = await fixture();
    const target = join(f.root, "target.toml");
    await f.write(target, "daemon.autostart = false\n");
    await symlink(target, join(f.home, "config.toml"));
    expect(await f.project()).toBe(await f.canonical());
    await link(target, f.paths.managedConfigPath);
    expect(await f.project()).toBeNull();
    await expect(f.canonical()).rejects.toThrow();
  });
  it.each(["leaf", "directory", "ancestor", "writable"])("falls back on unsafe managed %s", async kind => {
    const f = await fixture();
    if (kind === "writable") {
      await f.write(f.paths.managedConfigPath, "daemon.autostart = true\n");
      await chmod(f.paths.managedConfigPath, 0o666);
    } else if (kind === "leaf") {
      const target = join(f.root, "target.toml");
      await f.write(target, "daemon.autostart = true\n");
      await symlink(target, f.paths.managedConfigPath);
    } else if (kind === "directory") {
      await rm(join(f.managed, "config.d"), { recursive: true });
      await symlink(f.home, join(f.managed, "config.d"));
    } else {
      const alias = join(f.root, "alias");
      await symlink(f.managed, alias);
      f.paths.managedConfigPath = join(alias, "config.toml");
    }
    expect(await f.project()).toBeNull();
    await expect(f.canonical()).rejects.toThrow();
  });
  it("does not cache a hint or substitute for full unrelated-key validation", async () => {
    const f = await fixture();
    expect(await f.project()).toBe(true);
    await f.write(join(f.home, "config.toml"), "daemon.autostart = false\n");
    expect(await f.project()).toBe(false);
    await f.write(join(f.home, "config.toml"), "unknown_key = true\n");
    expect(await f.project()).toBe(true);
    await expect(f.canonical()).rejects.toThrow();
  });
});
