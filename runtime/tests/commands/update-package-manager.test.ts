import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  homebrewExecTarget,
  npmExecTarget,
  packageManagerCommand,
  readInstalledAgenCVersion,
  runCapturing,
  runPackageManagerUpdate,
} from "../../src/commands/update-package-manager.js";

describe("package manager updates", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "upm-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const script = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  it("runs the documented commands", () => {
    expect(packageManagerCommand("Homebrew")).toEqual({
      file: "brew", args: ["upgrade", "tetsuo-ai/agenc/agenc"], display: "brew upgrade tetsuo-ai/agenc/agenc",
    });
    expect(packageManagerCommand("npm").args).toEqual(["install", "-g", "@tetsuo-ai/agenc@latest"]);
  });

  it("keeps the output tail and never waits for terminal input", async () => {
    const seen: string[] = [];
    const run = await runCapturing("/bin/sh", ["-c", "echo one; echo 'two \u001b[31mred\u001b[0m' >&2; read answer || echo no-input; exit 3"], {
      onLine: (line) => seen.push(line),
    });
    expect(run).toMatchObject({ ok: false, code: 3 });
    // stdout and stderr are separate pipes, so only the set of lines is fixed.
    expect([...run.tail].sort()).toEqual(["no-input", "one", "two red"]);
    expect(seen).toEqual(run.tail);
  });

  it("keeps the old Homebrew keg the running TUI and daemon use; npm runs as is", async () => {
    const probe = script("probe", 'echo "cleanup=${HOMEBREW_NO_INSTALL_CLEANUP:-unset} keep=${KEEP:-unset}"');
    const viaProbe = ((file: string, args: readonly string[], options: object) =>
      spawn(file === "brew" || file === "npm" ? probe : file, [...args], options)) as never;
    const env = { PATH: process.env.PATH, KEEP: "yes" };
    expect((await runPackageManagerUpdate("Homebrew", { spawn: viaProbe, env })).tail).toEqual(["cleanup=1 keep=yes"]);
    // Even when the user turned the cleanup on, this one upgrade leaves the running keg.
    expect((await runPackageManagerUpdate("Homebrew", { spawn: viaProbe, env: { ...env, HOMEBREW_NO_INSTALL_CLEANUP: "0" } })).tail)
      .toEqual(["cleanup=1 keep=yes"]);
    expect((await runPackageManagerUpdate("npm", { spawn: viaProbe, env })).tail).toEqual(["cleanup=unset keep=yes"]);
  });

  it("finds the Homebrew opt bin of a keg runtime", () => {
    expect(homebrewExecTarget("/opt/homebrew/Cellar/agenc/0.19.26/libexec/node_modules/@tetsuo-ai/runtime/bin/agenc"))
      .toBe("/opt/homebrew/opt/agenc/bin/agenc");
    expect(homebrewExecTarget("/home/u/.agenc/runtime/0.19.26/tree/bin/agenc")).toBeNull();
  });

  it("reads the installed version and the npm global bin", async () => {
    expect(await readInstalledAgenCVersion(script("agenc", "echo 'agenc 0.19.26'"))).toBe("0.19.26");
    expect(await readInstalledAgenCVersion(script("broken", "echo nope; exit 1"))).toBeNull();
    const npm = script("npm", `echo "${dir}/prefix"`);
    const viaScript = ((file: string, args: readonly string[], options: object) =>
      spawn(file === "npm" ? npm : file, [...args], options)) as never;
    expect(await npmExecTarget(viaScript)).toBe(join(dir, "prefix", "bin", "agenc"));
  });
});
