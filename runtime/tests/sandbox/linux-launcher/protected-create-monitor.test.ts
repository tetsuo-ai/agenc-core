/**
 * The created-path monitor for missing protected metadata paths, shared by
 * the per-command Node launcher, the persistent session sandbox and opted-in
 * direct bubblewrap launches: a protected path a command creates is removed
 * and a clean exit fails. Plans that leave such paths unmounted reach only a
 * launcher that runs the monitor.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachProtectedCreateMonitor,
  PROTECTED_CREATE_POLL_MS,
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

describe.runIf(process.platform === "linux")("nested-repository scan", () => {
  /** A real repository, as git init writes: HEAD and an objects directory. */
  const makeRepo = (dir: string) => {
    fs.mkdirSync(path.join(dir, ".git", "objects"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  };
  /** readdir calls of the nested-repository walk (string paths under root). */
  const walkCalls = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([dir]) =>
    typeof dir === "string" && (dir === root || dir.startsWith(`${root}${path.sep}`))).length;

  it("walks the writable roots only at start and in stop, never on the poll", async () => {
    const readdir = vi.spyOn(fs, "readdirSync");
    const target = path.join(root, ".agenc");
    const monitor = startProtectedCreateMonitor([target], [root]);
    const atStart = walkCalls(readdir);
    // The baseline walk ran once at start.
    expect(atStart).toBeGreaterThan(0);
    makeRepo(path.join(root, "sub"));
    fs.writeFileSync(target, "x");
    // The poll still runs for the top-level target and removes it promptly...
    await vi.waitFor(() => expect(fs.existsSync(target)).toBe(false), { timeout: 2_000, interval: 20 });
    await delay(3 * PROTECTED_CREATE_POLL_MS);
    // ...but no poll walked the tree: the new nested repository is untouched.
    expect(walkCalls(readdir)).toBe(atStart);
    expect(fs.existsSync(path.join(root, "sub", ".git"))).toBe(true);
    // stop() walks once more, removes it and fails the command.
    expect(monitor.stop()).toBe(true);
    expect(walkCalls(readdir)).toBeGreaterThan(atStart);
    expect(fs.existsSync(path.join(root, "sub", ".git"))).toBe(false);
  });

  it("starts no poll timer when there are only scan roots", () => {
    const timer = vi.spyOn(globalThis, "setInterval");
    const monitor = startProtectedCreateMonitor([], [root]);
    expect(timer).not.toHaveBeenCalled();
    expect(monitor.stop()).toBe(false);
  });

  it("leaves a nested repository that existed at start alone", () => {
    makeRepo(path.join(root, "kept"));
    const monitor = startProtectedCreateMonitor([], [root]);
    expect(monitor.stop()).toBe(false);
    expect(fs.existsSync(path.join(root, "kept", ".git", "HEAD"))).toBe(true);
  });

  const movedAside = (folder: string) =>
    fs.readdirSync(folder).filter((name) => name.startsWith(".git.agenc-moved-"));
  // git with a ceiling at the test root's parent, so it cannot find an
  // enclosing repository above the test tree.
  const gitIn = (folder: string, ...args: string[]) => spawnSync("git", args, {
    cwd: folder, encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, GIT_CEILING_DIRECTORIES: path.dirname(root) },
  });

  it("moves a nested repository created during the run aside instead of deleting it", () => {
    const monitor = startProtectedCreateMonitor([], [root]);
    expect(gitIn(root, "init", "-q", "sub").status).toBe(0);
    fs.writeFileSync(path.join(root, "sub", ".git", "config"), "[core]\n\tfsmonitor = /planted\n");
    expect(monitor.stop()).toBe(true);
    // Moved, not deleted: .git is gone, one sibling holds its contents intact.
    expect(fs.existsSync(path.join(root, "sub", ".git"))).toBe(false);
    const aside = movedAside(path.join(root, "sub"));
    expect(aside).toHaveLength(1);
    const kept = path.join(root, "sub", aside[0]!);
    expect(fs.lstatSync(path.join(kept, "HEAD")).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(kept, "config"), "utf8")).toContain("fsmonitor = /planted");
    // The failure message says where it went, does not claim who made it,
    // and cautions before renaming it back.
    const notice = monitor.notice?.() ?? "";
    expect(notice).toContain(kept);
    expect(notice).toContain("appeared at");
    expect(notice).toContain("check its hooks and config");
    expect(notice).not.toMatch(/this command created|you created/u);
  });

  const busy = () => { throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" }); };
  const plainRepo = (dir: string) => {
    fs.mkdirSync(path.join(dir, ".git", "objects"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  };

  it("removes the nested .git when it cannot be moved aside, and says so", () => {
    // Review fallback F1: the rename fails, so the protection holds by removal.
    const monitor = startProtectedCreateMonitor([], [root]);
    plainRepo(path.join(root, "sub"));
    vi.spyOn(fs, "renameSync").mockImplementation(busy as never);
    expect(monitor.stop()).toBe(true);
    expect(fs.existsSync(path.join(root, "sub", ".git"))).toBe(false);
    expect(movedAside(path.join(root, "sub"))).toHaveLength(0);
    expect(monitor.notice?.()).toMatch(/could not be moved aside, so its \.git was removed\./u);
  });

  it("reports a nested .git it can neither move aside nor remove", () => {
    // Review fallback F2: rename and removal both fail; the repository is left
    // in place, the command fails, and the notice says what to check.
    const monitor = startProtectedCreateMonitor([], [root]);
    plainRepo(path.join(root, "sub"));
    vi.spyOn(fs, "renameSync").mockImplementation(busy as never);
    vi.spyOn(fs, "unlinkSync").mockImplementation(busy as never);
    vi.spyOn(fs, "rmdirSync").mockImplementation(busy as never);
    const violation = monitor.stop();
    vi.restoreAllMocks();
    expect(violation).toBe(true);
    expect(fs.existsSync(path.join(root, "sub", ".git", "HEAD"))).toBe(true);
    const notice = monitor.notice?.() ?? "";
    expect(notice).toContain("could not be moved aside or removed");
    expect(notice).toContain(`${path.join(root, "sub")}/.git/hooks`);
  });

  it("restores the parent folder's mode after moving a nested .git aside", () => {
    const monitor = startProtectedCreateMonitor([], [root]);
    plainRepo(path.join(root, "sub"));
    // A folder the owner cannot write: the move needs write on it, so the
    // monitor raises the owner's access for the rename and puts it back.
    fs.chmodSync(path.join(root, "sub"), 0o500);
    try {
      expect(monitor.stop()).toBe(true);
      expect(fs.statSync(path.join(root, "sub")).mode & 0o7777).toBe(0o500);
      expect(fs.existsSync(path.join(root, "sub", ".git"))).toBe(false);
      expect(movedAside(path.join(root, "sub"))).toHaveLength(1);
    } finally {
      fs.chmodSync(path.join(root, "sub"), 0o700);
    }
  });

  it("leaves host git no longer treating the folder as a repository once moved aside", () => {
    const monitor = startProtectedCreateMonitor([], [root]);
    expect(gitIn(root, "init", "-q", "sub").status).toBe(0);
    // Before the final check git sees sub as its own repository.
    expect(gitIn(path.join(root, "sub"), "rev-parse", "--git-dir").stdout.trim()).toBe(".git");
    expect(monitor.stop()).toBe(true);
    // After it, sub is not a repository: the moved name is not one git uses.
    const after = gitIn(path.join(root, "sub"), "rev-parse", "--git-dir");
    expect(after.status).not.toBe(0);
    expect(after.stderr).toMatch(/not a git repository/u);
  });

  it("leaves a pre-existing nested repository untouched, with nothing moved aside", () => {
    expect(gitIn(root, "init", "-q", "kept").status).toBe(0);
    const monitor = startProtectedCreateMonitor([], [root]);
    expect(monitor.stop()).toBe(false);
    expect(monitor.notice?.()).toBeUndefined();
    expect(fs.lstatSync(path.join(root, "kept", ".git")).isDirectory()).toBe(true);
    expect(movedAside(path.join(root, "kept"))).toHaveLength(0);
    expect(gitIn(path.join(root, "kept"), "rev-parse", "--git-dir").stdout.trim()).toBe(".git");
  });

  it("catches at stop a nested .git gitfile or symlink created during the run", () => {
    // A nested `.git` that is a pointer (a gitfile, or a symlink) is a
    // descent redirect a later host-side git would follow, not inert data.
    const subGit = path.join(root, "sub", ".git");
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    const monitor = startProtectedCreateMonitor([], [root]);
    fs.writeFileSync(subGit, "gitdir: /elsewhere\n");
    expect(monitor.stop()).toBe(true);
    expect(fs.existsSync(subGit)).toBe(false);
  });

  it("leaves a pre-existing nested .git gitfile (a linked worktree) alone", () => {
    // A linked worktree records `sub/.git` as a gitfile before the command.
    // It is in the baseline, so the monitor must not remove it.
    const subGit = path.join(root, "wt", ".git");
    fs.mkdirSync(path.join(root, "wt"), { recursive: true });
    fs.writeFileSync(subGit, "gitdir: /main/.git/worktrees/wt\n");
    const monitor = startProtectedCreateMonitor([], [root]);
    expect(monitor.stop()).toBe(false);
    expect(fs.existsSync(subGit)).toBe(true);
  });

  it("catches at stop a nested .git promoted to a real repository during the run", () => {
    const sub = path.join(root, "sub", ".git");
    // Not a repository at start (no HEAD, no objects): not in the baseline.
    fs.mkdirSync(path.join(sub, "hooks"), { recursive: true });
    const monitor = startProtectedCreateMonitor([], [root]);
    fs.writeFileSync(path.join(sub, "HEAD"), "ref: refs/heads/main\n");
    fs.mkdirSync(path.join(sub, "objects"));
    expect(monitor.stop()).toBe(true);
    expect(fs.existsSync(sub)).toBe(false);
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

describe("off Linux", () => {
  // The descriptor walk needs Linux /proc, so off Linux the monitor removes
  // nothing and fails the command (fail closed). Stubbing the platform keeps
  // this covered on the Linux gate without a skipped test. (macOS uses the
  // Seatbelt sandbox, not this monitor.)
  it("removes nothing and fails the command", () => {
    const real = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const target = path.join(root, ".agenc");
      fs.mkdirSync(target);
      const monitor = startProtectedCreateMonitor([target]);
      expect(monitor.stop()).toBe(true);
      expect(fs.existsSync(target)).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: real, configurable: true });
    }
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
    // A real repository (HEAD + objects, as git init writes): only a real
    // repository is narrowed, so its missing surface carve-outs are watched.
    fs.mkdirSync(path.join(f.cwd, ".git", "objects"), { recursive: true });
    fs.writeFileSync(path.join(f.cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
    const before = fs.readdirSync(path.join(f.cwd, ".git")).sort();
    expect(prepareDirectBwrapV3Plan(f)).toBeUndefined();
    const plan = consumeDirectBwrapPlan(prepareSessionBwrapPlan(f)!);
    try {
      const gitDir = fs.realpathSync(path.join(f.cwd, ".git"));
      expect(plan.sessionSandbox?.protectedCreateTargets).toEqual(
        expect.arrayContaining([path.join(gitDir, "hooks"), path.join(gitDir, "config"), path.join(gitDir, "commondir")]));
      // Planning creates nothing new inside the repository's .git.
      expect(fs.readdirSync(gitDir).sort()).toEqual(before);
    } finally { plan.dispose(); }
  });
});
