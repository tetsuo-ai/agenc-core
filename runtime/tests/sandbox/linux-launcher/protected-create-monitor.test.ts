/**
 * The created-path monitor for missing protected metadata paths, shared by
 * the per-command Node launcher, the persistent session sandbox and opted-in
 * direct bubblewrap launches: a protected path a command creates is removed
 * and a clean exit fails. Plans that leave such paths unmounted reach only a
 * launcher that runs the monitor.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachProtectedCreateMonitor,
  protectedCreateExitCode,
  startProtectedCreateMonitor,
  stopAttachedProtectedCreateMonitor,
} from "../../../src/sandbox/linux-launcher/protected-create-monitor.js";
import {
  consumeDirectBwrapPlan,
  prepareDirectBwrapPlan,
  prepareDirectBwrapV3Plan,
  prepareSessionBwrapPlan,
} from "../../../src/sandbox/linux-launcher/direct-bwrap.js";
import * as launcher from "../../../src/sandbox/linux-launcher/launcher.js";
import * as proc from "../../../src/sandbox/linux-launcher/proc-probe.js";

const runtime = fileURLToPath(new URL("../../../", import.meta.url));
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "protected-create-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe("created-path monitor", () => {
  it("reports nothing when no target appears", () => {
    const target = path.join(root, ".agenc");
    const monitor = startProtectedCreateMonitor([target]);
    expect(monitor.stop()).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("removes a target created while the command runs and fails the command", async () => {
    const target = path.join(root, ".agenc");
    const monitor = startProtectedCreateMonitor([target]);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "config.toml"), "x");
    // The poll removes it before the command ends.
    await vi.waitFor(() => expect(fs.existsSync(target)).toBe(false), { timeout: 2_000, interval: 20 });
    expect(monitor.stop()).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("catches a target created after the last poll in its final check", () => {
    const target = path.join(root, ".git");
    const monitor = startProtectedCreateMonitor([target]);
    fs.mkdirSync(target);
    expect(monitor.stop()).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("treats a target already present at start as a violation", () => {
    const target = path.join(root, ".agents");
    fs.mkdirSync(target);
    const monitor = startProtectedCreateMonitor([target]);
    expect(fs.existsSync(target)).toBe(false);
    expect(monitor.stop()).toBe(true);
  });

  it("fails only a clean exit", () => {
    expect(protectedCreateExitCode(0, true)).toBe(1);
    expect(protectedCreateExitCode(3, true)).toBe(3);
    expect(protectedCreateExitCode(0, false)).toBe(0);
    expect(protectedCreateExitCode(130, false)).toBe(130);
  });

  it("stops an attached monitor once", async () => {
    const target = path.join(root, ".agenc");
    const child = {};
    attachProtectedCreateMonitor(child, startProtectedCreateMonitor([target]));
    fs.mkdirSync(target);
    expect(stopAttachedProtectedCreateMonitor(child)).toBe(true);
    expect(stopAttachedProtectedCreateMonitor(child)).toBe(false);
    expect(stopAttachedProtectedCreateMonitor({})).toBe(false);
    // Stopped: nothing polls any more.
    fs.mkdirSync(target);
    await delay(250);
    expect(fs.existsSync(target)).toBe(true);
  });
});

/**
 * A workspace whose missing `.agenc` has an ancestor `.agenc` (a project under
 * a HOME holding ~/.agenc): it cannot get a placeholder mount.
 */
function fixture() {
  const base = path.join(root, "home");
  const cwd = path.join(base, "work"), temp = path.join(cwd, "temp");
  fs.mkdirSync(temp, { recursive: true });
  fs.mkdirSync(path.join(base, ".agenc"));
  fs.mkdirSync(path.join(cwd, ".agents"));
  const profile = { fileSystem: { kind: "restricted", entries: [
    { path: { kind: "special", value: { kind: "root" } }, access: "read" },
    { path: { kind: "path", path: cwd }, access: "write" },
  ], includePlatformDefaults: true }, network: "disabled" };
  const args = [path.join(runtime, "bin/agenc-linux-sandbox"), "--sandbox-policy-cwd", cwd,
    "--command-cwd", cwd, "--permission-profile", JSON.stringify(profile), "--session-temp-root", temp,
    "--", "/bin/bash", "-c", "printf once"];
  vi.spyOn(launcher, "preferredBubblewrapLauncher").mockReturnValue({ program: process.execPath, supportsArgv0: true });
  vi.spyOn(proc, "runProcMountProbe").mockReturnValue({ status: 0 } as ReturnType<typeof proc.runProcMountProbe>);
  return { program: process.execPath, args, cwd, env: { PATH: "/usr/bin:/bin" }, target: path.join(cwd, ".agenc") };
}

describe.runIf(process.platform === "linux")("plans that leave protected paths unmounted", () => {
  it("keeps a per-command direct launch on the Node launcher unless its caller runs the monitor", () => {
    const f = fixture();
    expect(prepareDirectBwrapPlan(f)).toBeUndefined();
    expect(prepareDirectBwrapV3Plan(f)).toBeUndefined();
    const prepared = prepareDirectBwrapV3Plan({ ...f, monitorProtectedCreates: true });
    expect(prepared).toBeDefined();
    const plan = consumeDirectBwrapPlan(prepared!);
    try {
      expect(plan.protectedCreateTargets).toContain(fs.realpathSync(f.cwd) + "/.agenc");
      expect(plan.sessionSandbox).toBeUndefined();
    } finally { plan.dispose(); }
    // Placeholder-safe workspaces carry no targets at all.
    fs.mkdirSync(f.target);
    const plain = consumeDirectBwrapPlan(prepareDirectBwrapV3Plan({ ...f, monitorProtectedCreates: true })!);
    try { expect(plain.protectedCreateTargets).toBeUndefined(); } finally { plain.dispose(); }
  });

  it("gives the session sandbox the targets it must watch", () => {
    const f = fixture();
    const prepared = prepareSessionBwrapPlan(f);
    expect(prepared).toBeDefined();
    const plan = consumeDirectBwrapPlan(prepared!);
    try {
      expect(plan.sessionSandbox?.protectedCreateTargets).toContain(fs.realpathSync(f.cwd) + "/.agenc");
      expect(plan.protectedCreateTargets).toBeUndefined();
    } finally { plan.dispose(); }
  });

  it("keeps a git workspace on the session sandbox with its narrowed .git carve-outs watched", () => {
    const f = fixture();
    fs.mkdirSync(f.target);
    fs.mkdirSync(path.join(f.cwd, ".git"));
    expect(prepareDirectBwrapV3Plan(f)).toBeUndefined();
    const plan = consumeDirectBwrapPlan(prepareSessionBwrapPlan(f)!);
    try {
      const gitDir = fs.realpathSync(path.join(f.cwd, ".git"));
      expect(plan.sessionSandbox?.protectedCreateTargets).toEqual(
        expect.arrayContaining([path.join(gitDir, "hooks"), path.join(gitDir, "config"), path.join(gitDir, "commondir")]));
      // Planning creates nothing inside the repository's .git.
      expect(fs.readdirSync(gitDir)).toEqual([]);
    } finally { plan.dispose(); }
  });
});
