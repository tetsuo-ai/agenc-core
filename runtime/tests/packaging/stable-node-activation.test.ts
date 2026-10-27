import "../helpers/cron-os-home.js";
import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { activateGeneratedWrappers, parseGeneratedWrapper, renderGeneratedWrapper } from "../../src/bin/update-cli.js";
import { darwinPlatformFixturePrelude, installDarwinPlatformFixture } from "../helpers/darwin-platform-fixture.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "agenc-node-activation-")));
  roots.push(home);
  mkdirSync(join(home, "runtime"), { mode: 0o700 });
  return home;
}
function runtime(home: string, version: string) {
  const digest = createHash("sha256").update(version).digest("hex");
  const tree = join(home, "runtime", version, `darwin-arm64-native-node-abi-147-sha256-${digest}`);
  const nodeBin = join(tree, "node_modules/.agenc-node/bin/node");
  const runtimeBin = join(tree, "node_modules/@tetsuo-ai/runtime/bin/agenc");
  mkdirSync(dirname(nodeBin), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(runtimeBin), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`#!/bin/sh\n# ${version}\nexec '${process.execPath}' "$@"\n`);
  writeFileSync(nodeBin, bytes, { mode: 0o755 });
  writeFileSync(runtimeBin, `console.log(${JSON.stringify(version)});`);
  writeFileSync(join(tree, ".agenc-runtime-ok"), digest);
  writeFileSync(join(dirname(dirname(nodeBin)), "identity.json"), JSON.stringify({
    schemaVersion: 1, executable: "bin/node", executableBytes: bytes.length,
    executableSha256: createHash("sha256").update(bytes).digest("hex"),
  }));
  return { nodeBin, runtimeBin, targetVersion: version };
}

describe.skipIf(process.platform === "win32")("stable macOS activation", () => {
  let restorePlatform: () => void;
  // The filesystem contract is POSIX. Exercise the macOS activation branch
  // on Linux as well; native macOS runs use these same assertions.
  beforeEach(() => { restorePlatform = installDarwinPlatformFixture(childProcess, syncBuiltinESMExports); });
  afterEach(() => { restorePlatform(); });
  test("updater migrates both wrappers, retains newer on unpinned activation, and supports pin rollback", async () => {
    const home = fixture(), old = runtime(home, "0.19.14"), next = runtime(home, "0.19.15");
    const paths = [join(home, "agenc-a"), join(home, "agenc-b")];
    for (const path of paths) writeFileSync(path, renderGeneratedWrapper({ kind: "posix", agencHome: home, ...old }), { mode: 0o755 });
    const wrappers = paths.map((path) => parseGeneratedWrapper(path)!);
    await activateGeneratedWrappers({ agencHome: home, ...next, wrappers, allowDowngrade: false });
    for (const path of paths) expect(parseGeneratedWrapper(path)?.nodeBin).toBe(join(home, "bin/agenc-node"));
    expect(readFileSync(join(home, "bin/agenc-node"))).toEqual(readFileSync(next.nodeBin));
    expect((await activateGeneratedWrappers({ agencHome: home, ...old, wrappers, allowDowngrade: false })).activated).toBe(false);
    expect(readFileSync(join(home, "bin/agenc-node"))).toEqual(readFileSync(next.nodeBin));
    await activateGeneratedWrappers({ agencHome: home, ...old, wrappers, allowDowngrade: true });
    expect(readFileSync(join(home, "bin/agenc-node"))).toEqual(readFileSync(old.nodeBin));
    expect(JSON.parse(readFileSync(join(home, "runtime/.activation-history.json"), "utf8"))).toEqual({ current: "0.19.14", previous: "0.19.15" });
    expect(spawnSync(paths[0]!, [], { encoding: "utf8" }).stdout.trim()).toBe("0.19.14");
  });

  test("installer killed after replacing Node recovers its journal through the updater", async () => {
    const home = fixture(), old = runtime(home, "0.19.14"), next = runtime(home, "0.19.15");
    const wrapper = join(home, "agenc");
    writeFileSync(wrapper, renderGeneratedWrapper({ kind: "posix", agencHome: home, ...old }), { mode: 0o755 });
    const desired = join(home, "desired");
    writeFileSync(desired, renderGeneratedWrapper({ kind: "posix", agencHome: home, ...next }));
    const helper = join(home, "installer.cjs");
    const source = readFileSync(resolve("../scripts/install/runtime-installer.cjs"), "utf8");
    writeFileSync(helper, `${darwinPlatformFixturePrelude}
const os = require("node:os"); const userInfo = os.userInfo;
os.userInfo = () => ({ ...userInfo(), homedir: ${JSON.stringify(process.env.AGENC_TEST_HERMETIC_HOME)} });
require("node:module").syncBuiltinESMExports();\n` + source);
    const child = spawn(process.execPath, [helper, "activate", desired, wrapper, home, next.targetVersion, "false"], {
      env: { ...process.env, HOME: home, AGENC_HOME: home, AGENC_INSTALL_TEST_AFTER_STABLE_NODE_MS: "5000" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    try {
      const target = join(home, "bin/agenc-node");
      for (let i = 0; i < 250 && !existsSync(target) && child.exitCode === null; i++) await delay(20);
      expect(existsSync(target), stderr).toBe(true);
      child.kill("SIGKILL"); await exited;
      expect(existsSync(join(home, "runtime/.activation-transaction.json"))).toBe(true);
      expect(parseGeneratedWrapper(wrapper)?.runtimeBin).toBe(old.runtimeBin);
      expect(readFileSync(target)).toEqual(readFileSync(next.nodeBin));
      await activateGeneratedWrappers({ agencHome: home, ...next, wrappers: [parseGeneratedWrapper(wrapper)!], allowDowngrade: false });
      expect(existsSync(join(home, "runtime/.activation-transaction.json"))).toBe(false);
      expect(parseGeneratedWrapper(wrapper)?.runtimeBin).toBe(next.runtimeBin);
      expect(spawnSync(wrapper, [], { encoding: "utf8" }).stdout.trim()).toBe("0.19.15");
    } finally { child.kill(); await exited; }
  });
});
