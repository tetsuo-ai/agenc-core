import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadCanonicalDaemonConfig, loadLayeredConfig } from "../../src/config/repository.js";
import { defaultConfig, validateAgenCConfigBlocks } from "../../src/config/schema.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "remote-authority-")); roots.push(root);
  const home = join(root, "home"), cwd = join(root, "project"), managed = join(root, "managed");
  for (const path of [home, join(cwd, ".agenc"), join(managed, "config.d")]) mkdirSync(path, { recursive: true });
  const options = { home: undefined, cwd, projectRoot: cwd, projectTrusted: true, env: { AGENC_HOME: home }, managedConfigPath: join(managed, "config.toml"), managedDropInDir: join(managed, "config.d") };
  const write = (path: string, enabled: boolean) => writeFileSync(path, `config_version = 2\n[remote_control]\nenabled = ${enabled}\n`, { mode: 0o600 });
  return { home, cwd, managed, options, write };
}

it("defaults off and accepts only a boolean in the closed owner table", () => {
  expect(defaultConfig().remote_control?.enabled).toBe(false);
  for (const value of ["true", 1, null, { enabled: "true" }, { enabled: true, extra: true }]) {
    expect(() => validateAgenCConfigBlocks({ remote_control: value } as never)).toThrow();
  }
});

it("ignores repository, plugin, explicit file, CLI and environment enablement", async () => {
  const f = fixture();
  f.write(join(f.cwd, ".agenc", "config.toml"), true);
  const flagConfigPath = join(f.cwd, "override.toml"); f.write(flagConfigPath, true);
  const loaded = await loadLayeredConfig({ ...f.options, flagConfigPath, pluginDefaults: { remote_control: { enabled: true } }, cliOverrides: { remote_control: { enabled: true } }, env: { ...f.options.env, AGENC_REMOTE_FULL_CONTROL: "1", AGENC_REMOTE_CONTROL_ENABLED: "true" } });
  expect(loaded.config.remote_control?.enabled).toBe(false);
  for (const scope of ["plugin", "project", "flag", "cli"]) expect(loaded.ignored).toContainEqual(expect.objectContaining({ scope, key: "remote_control" }));
});

it("uses the home file, then managed base, then sorted managed drop-ins", async () => {
  const f = fixture();
  f.write(join(f.home, "config.toml"), true);
  expect((await loadCanonicalDaemonConfig(f.options)).config.remote_control?.enabled).toBe(true);
  f.write(f.options.managedConfigPath, false);
  expect((await loadCanonicalDaemonConfig(f.options)).config.remote_control?.enabled).toBe(false);
  f.write(join(f.managed, "config.d", "10-allow.toml"), true);
  expect((await loadCanonicalDaemonConfig(f.options)).config.remote_control?.enabled).toBe(true);
  f.write(join(f.managed, "config.d", "90-deny.toml"), false);
  const warnings: string[] = [];
  const loaded = await loadCanonicalDaemonConfig({ ...f.options, env: { ...f.options.env, AGENC_REMOTE_FULL_CONTROL: "1" }, onWarn: line => warnings.push(line) });
  expect(loaded.config.remote_control?.enabled).toBe(false);
  expect(warnings.join("\n")).toContain("AGENC_REMOTE_FULL_CONTROL is ignored");
});
