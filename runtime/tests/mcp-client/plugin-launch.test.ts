import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { assertPluginSnapshotLaunchSafe } from "./plugin-launch.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("compares Windows spelling, case, separators, trailing separators and file URLs", () => {
  const root = win32.join("C:\\Plugins", "Sample") + "\\";
  for (const argument of ["c:/plugins/sample/server.mjs", "file:///C:/PLUGINS/SAMPLE/bootstrap.mjs"]) {
    expect(() => assertPluginSnapshotLaunchSafe("sample", root,
      { command: "node", args: [argument], cwd: "D:\\snapshot" }, {}, "win32"))
      .toThrow(/launch references its mutable installation/);
  }
  expect(() => assertPluginSnapshotLaunchSafe("sample", root,
    { command: "node", args: ["D:/snapshot/server.mjs"], cwd: "D:\\snapshot" }, {}, "win32"))
    .not.toThrow();
});

it("compares macOS paths without case sensitivity", () => {
  expect(() => assertPluginSnapshotLaunchSafe("sample", "/Users/Plugins/Sample/",
    { command: "node", args: ["/users/plugins/sample/server.mjs"] }, {}, "darwin"))
    .toThrow(/launch references its mutable installation/);
});

it("allows paths that resolve outside the installation", () => {
  expect(() => assertPluginSnapshotLaunchSafe("sample", "/tmp/plugins/sample",
    { command: "node", args: ["/tmp/plugins/sample/../outside/server.mjs", "/tmp/plugins/sampleish/server.mjs"] }, {}))
    .not.toThrow();
});

it("rejects a PATH executable reached through a symlink into the installation", async () => {
  const home = await mkdtemp(join(tmpdir(), "agenc-plugin-link-")); roots.push(home);
  const installed = join(home, "installed"); const bin = join(home, "bin");
  await mkdir(installed); await mkdir(bin);
  const executable = join(installed, "sample-server");
  await writeFile(executable, "#!/bin/sh\nexit 0\n"); await chmod(executable, 0o755);
  await symlink(executable, join(bin, "sample-server"));
  expect(() => assertPluginSnapshotLaunchSafe("sample", installed,
    { command: "sample-server" }, { PATH: bin }))
    .toThrow(/launch references its mutable installation/);
});

it("rejects an encoded file URL through a symlink into the installation", async () => {
  const home = await mkdtemp(join(tmpdir(), "agenc-plugin-url-link-")); roots.push(home);
  const installed = join(home, "installed"); await mkdir(installed);
  const alias = join(home, "alias with space"); await symlink(installed, alias);
  const url = pathToFileURL(join(alias, "bootstrap.mjs")).href;
  expect(() => assertPluginSnapshotLaunchSafe("sample", installed,
    { command: "node", args: ["--import", url] }, {}))
    .toThrow(/launch references its mutable installation/);
  expect(() => assertPluginSnapshotLaunchSafe("sample", installed,
    { command: "node", cwd: alias }, {}))
    .toThrow(/launch references its mutable installation/);
});
