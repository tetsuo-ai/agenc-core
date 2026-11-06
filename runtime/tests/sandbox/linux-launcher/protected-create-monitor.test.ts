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
// Targets are physical paths, as the planners hand them to the monitor.
beforeEach(() => { root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "protected-create-"))); });
afterEach(() => {
  vi.restoreAllMocks();
  restoreOwnerAccess(root);
  fs.rmSync(root, { recursive: true, force: true });
});

/** Undo modes a test took away so the temporary tree can be removed. */
function restoreOwnerAccess(directory: string): void {
  try {
    if (!fs.lstatSync(directory).isDirectory()) return;
    fs.chmodSync(directory, 0o700);
    for (const entry of fs.readdirSync(directory)) restoreOwnerAccess(path.join(directory, entry));
  } catch {
    // Already gone.
  }
}

/**
 * Runs `action` once per filesystem call it makes, and once more, calling
 * `interleave` just before the n-th call: a concurrent change at every point
 * of the monitor's check and removal.
 */
function atEveryFilesystemStep(
  prepare: () => { readonly action: () => void; readonly interleave: () => void; readonly verify: () => void },
): number {
  const names = [
    "openSync", "closeSync", "lstatSync", "statSync", "existsSync", "readdirSync",
    "rmdirSync", "unlinkSync", "rmSync", "readlinkSync", "chmodSync",
  ] as const;
  let steps = 0;
  for (let at = 1; ; at += 1) {
    const { action, interleave, verify } = prepare();
    let calls = 0;
    let fired = false;
    const step = () => {
      calls += 1;
      if (calls === at) {
        fired = true;
        interleave();
      }
    };
    const real = {
      native: fs.realpathSync.native,
      ...Object.fromEntries(names.map((name) => [name, fs[name]])),
    } as Record<string, (...args: unknown[]) => unknown>;
    let inside = false;
    const wrap = (call: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
      if (!inside) {
        inside = true;
        try { step(); } finally { inside = false; }
      }
      return call(...args);
    };
    const spies = [
      vi.spyOn(fs.realpathSync, "native").mockImplementation(wrap(real.native!) as never),
      ...names.map((name) => vi.spyOn(fs, name).mockImplementation(wrap(real[name]!) as never)),
    ];
    try {
      action();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    verify();
    steps = calls;
    if (!fired) return steps;
  }
}

describe.runIf(process.platform === "linux")("created-path monitor", () => {
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

  it("never removes a target through a parent swapped for a symlink", () => {
    // The sandbox moves the watched target's parent aside and links another
    // repository's metadata in its place. The host-side monitor must not
    // delete that repository's directory through the link.
    const workspace = path.join(root, "workspace"), victim = path.join(root, "victim");
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    fs.mkdirSync(path.join(victim, ".git", "modules", "sub"), { recursive: true });
    fs.writeFileSync(path.join(victim, ".git", "modules", "sub", "HEAD"), "unpushed");
    const target = path.join(workspace, ".git", "modules");
    const monitor = startProtectedCreateMonitor([target]);
    fs.renameSync(path.join(workspace, ".git"), path.join(workspace, ".git.old"));
    fs.symlinkSync(path.join(victim, ".git"), path.join(workspace, ".git"), "dir");
    // The swap itself fails the command, without deleting anything.
    expect(monitor.stop()).toBe(true);
    expect(fs.readFileSync(path.join(victim, ".git", "modules", "sub", "HEAD"), "utf8")).toBe("unpushed");
  });

  it("removes a target under a parent created during the run, not one linked in", () => {
    const workspace = path.join(root, "workspace"), victim = path.join(root, "victim");
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    fs.mkdirSync(path.join(victim, "info"), { recursive: true });
    const created = path.join(workspace, ".git", "objects", "info");
    const linked = path.join(workspace, ".git", "refs", "info");
    const monitor = startProtectedCreateMonitor([created, linked]);
    fs.mkdirSync(created, { recursive: true });
    fs.symlinkSync(victim, path.join(workspace, ".git", "refs"), "dir");
    expect(monitor.stop()).toBe(true);
    expect(fs.existsSync(created)).toBe(false);
    expect(fs.existsSync(path.join(victim, "info"))).toBe(true);
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

  it("keeps a removal in the observed tree when a parent created during the run is swapped at any point", () => {
    // `.git/objects` is missing at launch, so no mount anchors it; the
    // command creates it, then replaces it with a link to another
    // repository's metadata while the host-side check is running.
    let run = 0;
    const steps = atEveryFilesystemStep(() => {
      run += 1;
      const base = path.join(root, `swap-${run}`);
      const workspace = path.join(base, "workspace"), victim = path.join(base, "victim", ".git");
      const objects = path.join(workspace, ".git", "objects");
      fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
      fs.mkdirSync(path.join(victim, "info", "sub"), { recursive: true });
      fs.writeFileSync(path.join(victim, "info", "sub", "HEAD"), "unpushed");
      const monitor = startProtectedCreateMonitor([path.join(objects, "info")]);
      fs.mkdirSync(path.join(objects, "info"), { recursive: true });
      fs.writeFileSync(path.join(objects, "info", "alternates"), "/elsewhere");
      let result: boolean | undefined;
      let swapped = false;
      return {
        action: () => { result = monitor.stop(); },
        interleave: () => {
          swapped = true;
          fs.renameSync(objects, `${objects}.old`);
          fs.symlinkSync(victim, objects, "dir");
        },
        verify: () => {
          expect(result).toBe(true);
          expect(fs.readFileSync(path.join(victim, "info", "sub", "HEAD"), "utf8")).toBe("unpushed");
          if (!swapped) expect(fs.existsSync(path.join(objects, "info"))).toBe(false);
        },
      };
    });
    expect(steps).toBeGreaterThan(2);
  });

  it("never cleans through a link a previous command left on the way to a target", () => {
    // A persistent session sandbox plans once; an earlier command may have
    // put a link where a parent missing at planning should be.
    const workspace = path.join(root, "workspace"), victim = path.join(root, "victim", ".git");
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    fs.mkdirSync(path.join(victim, "info"), { recursive: true });
    fs.writeFileSync(path.join(victim, "info", "exclude"), "kept");
    fs.symlinkSync(victim, path.join(workspace, ".git", "objects"), "dir");
    const monitor = startProtectedCreateMonitor([path.join(workspace, ".git", "objects", "info")]);
    expect(monitor.stop()).toBe(true);
    expect(fs.readFileSync(path.join(victim, "info", "exclude"), "utf8")).toBe("kept");
  });

  it("removes a link inside a created tree as a link when it is swapped in at any point", () => {
    let run = 0;
    atEveryFilesystemStep(() => {
      run += 1;
      const base = path.join(root, `inner-${run}`);
      const hooks = path.join(base, "workspace", ".git", "hooks"), victim = path.join(base, "victim");
      fs.mkdirSync(path.dirname(hooks), { recursive: true });
      fs.mkdirSync(path.join(victim, "deeper"), { recursive: true });
      fs.writeFileSync(path.join(victim, "deeper", "data"), "kept");
      const monitor = startProtectedCreateMonitor([hooks]);
      fs.mkdirSync(path.join(hooks, "sub", "deeper"), { recursive: true });
      fs.writeFileSync(path.join(hooks, "sub", "deeper", "pre-commit"), "x");
      let result: boolean | undefined;
      return {
        action: () => { result = monitor.stop(); },
        interleave: () => {
          // Whatever the removal has reached: put a link where `sub` was.
          try { fs.renameSync(path.join(hooks, "sub"), path.join(hooks, "sub.old")); } catch { /* removed already */ }
          try { fs.symlinkSync(victim, path.join(hooks, "sub"), "dir"); } catch { /* hooks removed already */ }
        },
        verify: () => {
          expect(result).toBe(true);
          expect(fs.readFileSync(path.join(victim, "deeper", "data"), "utf8")).toBe("kept");
        },
      };
    });
  });

  it("cleans the directory now at a moved parent's place, not the moved one", () => {
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    const monitor = startProtectedCreateMonitor([path.join(workspace, ".git", "modules")]);
    fs.renameSync(path.join(workspace, ".git"), path.join(workspace, ".git.old"));
    fs.mkdirSync(path.join(workspace, ".git", "modules", "sub"), { recursive: true });
    fs.mkdirSync(path.join(workspace, ".git.old", "keep"));
    expect(monitor.stop()).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".git", "modules"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, ".git.old", "keep"))).toBe(true);
  });

  it("removes a created target whose owner access the command took away", () => {
    const hooks = path.join(root, "workspace", ".git", "hooks");
    fs.mkdirSync(path.dirname(hooks), { recursive: true });
    const monitor = startProtectedCreateMonitor([hooks]);
    fs.mkdirSync(path.join(hooks, "locked"), { recursive: true });
    fs.writeFileSync(path.join(hooks, "locked", "pre-commit"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(hooks, "pre-push"), "#!/bin/sh\n");
    fs.chmodSync(path.join(hooks, "locked"), 0o500);
    fs.chmodSync(hooks, 0o500);
    expect(monitor.stop()).toBe(true);
    expect(fs.existsSync(hooks)).toBe(false);
  });

  it("answers later stops without checking again", () => {
    const target = path.join(root, ".agenc");
    const monitor = startProtectedCreateMonitor([target]);
    expect(monitor.stop()).toBe(false);
    fs.mkdirSync(target);
    expect(monitor.stop()).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe("protected-create exit code", () => {
  it("fails only a clean exit", () => {
    expect(protectedCreateExitCode(0, true)).toBe(1);
    expect(protectedCreateExitCode(3, true)).toBe(3);
    expect(protectedCreateExitCode(0, false)).toBe(0);
    expect(protectedCreateExitCode(130, false)).toBe(130);
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
