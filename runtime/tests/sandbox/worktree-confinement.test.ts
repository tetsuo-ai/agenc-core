import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  canReadPathWithCwd,
  canWritePathWithCwd,
  getWritableRootsWithCwd,
  restrictedFileSystemPolicy,
  unrestrictedFileSystemPolicy,
  type PermissionProfile,
} from "../../src/sandbox/engine/index.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import { createBwrapCommandArgs } from "../../src/sandbox/linux-launcher/bwrap.js";
import { SECCOMP_STDIN_FD } from "../../src/sandbox/linux-launcher/config.js";
import { confineProfileToWorktree } from "../../src/sandbox/worktree-confinement.js";
import { permissionProfileForLiveSandboxPolicies } from "../../src/tools/runtimes/sandboxing.js";

// A Goal step works in <checkout>/.agenc-worktrees/<run>. Its commands got
// the parent's sandbox: the checkout itself was a writable root.
let base: string;
let checkout: string;
let worktree: string;
let temp: string;
let shared: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "agenc-worktree-confinement-")));
  checkout = join(base, "checkout");
  worktree = join(checkout, ".agenc-worktrees", "m5-run");
  temp = join(base, "temp");
  shared = join(base, "shared");
  for (const dir of [join(worktree, "src"), join(checkout, "src"), join(checkout, "secrets"), temp, shared]) {
    mkdirSync(dir, { recursive: true });
  }
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A workspace-write session in the checkout, with one more folder it may write. */
function sessionProfile(): PermissionProfile {
  return permissionProfileForLiveSandboxPolicies(
    "workspace_write",
    checkout,
    {
      allowWrite: [checkout, shared],
      denyWrite: [join(checkout, "secrets")],
      allowRead: [],
      denyRead: [],
    },
    { allowlist: [], denylist: [], allowManagedDomainsOnly: false },
  );
}

function writable(profile: PermissionProfile, target: string, tempRoot = temp): boolean {
  return canWritePathWithCwd(profile.fileSystem, target, worktree, tempRoot);
}

describe("confineProfileToWorktree", () => {
  it("drops every write grant outside the worktree and the temp root and keeps reads", () => {
    expect(writable(sessionProfile(), join(checkout, "src", "a.js"))).toBe(true);
    const profile = confineProfileToWorktree(sessionProfile(), { worktree, checkout }, worktree, temp);
    expect(writable(profile, join(checkout, "src", "a.js"))).toBe(false);
    expect(writable(profile, join(shared, "notes.md"))).toBe(false);
    expect(writable(profile, join(worktree, "src", "a.js"))).toBe(true);
    expect(writable(profile, join(temp, "scratch.txt"))).toBe(true);
    expect(canReadPathWithCwd(profile.fileSystem, join(checkout, "src", "a.js"), worktree, temp)).toBe(true);
    expect(profile.network).toBe("disabled");
  });

  it("narrows an unrestricted profile to workspace-write over the worktree", () => {
    const profile = confineProfileToWorktree(
      { fileSystem: unrestrictedFileSystemPolicy(), network: "enabled" },
      { worktree, checkout },
      worktree,
      temp,
    );
    expect(profile.fileSystem.kind).toBe("restricted");
    expect(writable(profile, join(checkout, "src", "a.js"))).toBe(false);
    expect(writable(profile, join(worktree, "src", "a.js"))).toBe(true);
    expect(canReadPathWithCwd(profile.fileSystem, join(checkout, "src", "a.js"), worktree, temp)).toBe(true);
    expect(profile.network).toBe("enabled");
  });

  it("keeps the checkout read-only when the temp root holds it", () => {
    // A project under /tmp: the whole temp root stays writable, the checkout does not.
    const profile = confineProfileToWorktree(sessionProfile(), { worktree, checkout }, worktree, base);
    expect(writable(profile, join(checkout, "src", "a.js"), base)).toBe(false);
    expect(writable(profile, join(checkout, "new.js"), base)).toBe(false);
    expect(writable(profile, join(worktree, "src", "a.js"), base)).toBe(true);
    expect(writable(profile, join(base, "scratch.txt"), base)).toBe(true);
  });

  it("mounts the temp root before the worktree it holds, so bubblewrap does not cover the worktree", () => {
    const profile = confineProfileToWorktree(sessionProfile(), { worktree, checkout }, worktree, base);
    const roots = getWritableRootsWithCwd(profile.fileSystem, worktree, base).map((root) => root.root);
    expect(roots.indexOf(base)).toBeGreaterThanOrEqual(0);
    expect(roots.indexOf(base)).toBeLessThan(roots.indexOf(worktree));
    const { args } = createBwrapCommandArgs(["/bin/true"], profile.fileSystem, worktree, worktree, {
      mountProc: true,
      networkMode: "isolated",
      sessionTempRoot: base,
      seccompFd: SECCOMP_STDIN_FD,
    });
    const mount = (flag: string, target: string): number =>
      args.findIndex((arg, index) => arg === flag && args[index + 1] === target);
    expect(mount("--bind", base)).toBeGreaterThanOrEqual(0);
    expect(mount("--bind", base)).toBeLessThan(mount("--ro-bind", checkout));
    expect(mount("--ro-bind", checkout)).toBeLessThan(mount("--bind", worktree));
  });

  it("leaves a temp folder inside the checkout writable, as a routine run's scratch folder is", () => {
    const scratch = join(checkout, "scratch");
    mkdirSync(scratch);
    const profile = confineProfileToWorktree(sessionProfile(), { worktree, checkout }, worktree, scratch);
    expect(writable(profile, join(scratch, "out.txt"), scratch)).toBe(true);
    expect(writable(profile, join(checkout, "src", "a.js"), scratch)).toBe(false);
  });

  it("keeps reserved read-only paths and the platform defaults", () => {
    const reserved = join(worktree, "reserved");
    const profile = confineProfileToWorktree(
      {
        fileSystem: restrictedFileSystemPolicy(
          [{ path: { kind: "special", value: { kind: "project_roots" } }, access: "write" }],
          { includePlatformDefaults: true, reservedReadOnlyPaths: [reserved] },
        ),
        network: "disabled",
      },
      { worktree, checkout },
      worktree,
      temp,
    );
    expect(profile.fileSystem.includePlatformDefaults).toBe(true);
    expect(profile.fileSystem.reservedReadOnlyPaths).toEqual([reserved]);
  });
});

describe("a worktree child's sandbox broker", () => {
  function parentBroker(): SandboxExecutionBroker {
    return new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: checkout,
      sessionTempRoot: temp,
      permissionProfile: sessionProfile(),
      probe: (probe) => ({ kind: "ready", mode: probe.mode, platform: process.platform }),
    });
  }

  it("confines the child's command surfaces and leaves its services as the session set them", () => {
    const child = parentBroker().forkForCwd(worktree, { worktreeConfinement: { worktree, checkout } });
    for (const surface of ["tool", "child_agent", "background"] as const) {
      const sandbox = child.runtimeSandbox(surface)!;
      const canWrite = (target: string): boolean => canWritePathWithCwd(
        sandbox.permissionProfile.fileSystem, target, sandbox.sandboxPolicyCwd, sandbox.sessionTempRoot,
      );
      expect(canWrite(join(shared, "notes.md"))).toBe(false);
      expect(canWrite(join(worktree, "src", "a.js"))).toBe(true);
    }
    const lsp = child.runtimeSandbox("lsp")!;
    expect(canWritePathWithCwd(
      lsp.permissionProfile.fileSystem, join(shared, "notes.md"), lsp.sandboxPolicyCwd, lsp.sessionTempRoot,
    )).toBe(true);
  });

  it("keeps a descendant in the same worktree unless it gets its own", () => {
    const child = parentBroker().forkForCwd(worktree, { worktreeConfinement: { worktree, checkout } });
    expect(child.forkForCwd(worktree).worktreeConfinement).toEqual({ worktree, checkout });
    const nested = join(worktree, ".agenc-worktrees", "m5-nested");
    expect(child.forkForCwd(nested, { worktreeConfinement: { worktree: nested, checkout: worktree } }).worktreeConfinement)
      .toEqual({ worktree: nested, checkout: worktree });
    expect(parentBroker().forkForCwd(worktree).worktreeConfinement).toBeUndefined();
    // The runtime's own Git work on the repository (a nested worktree's
    // creation and removal) is not the child's command.
    expect(child.forkForCwd(checkout, { worktreeConfinement: null }).worktreeConfinement).toBeUndefined();
  });

  it("confines a command surface's own profile override", () => {
    const transform = vi.fn(() => {
      throw new Error("captured");
    });
    const child = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: checkout,
      sessionTempRoot: temp,
      platform: process.platform,
      sandboxManager: { selectInitial: vi.fn(() => "linux_seccomp" as const), transform } as never,
      probe: (probe) => ({ kind: "ready", mode: probe.mode, platform: process.platform }),
    }).forkForCwd(worktree, { worktreeConfinement: { worktree, checkout } });
    expect(() => child.prepareSpawn("tool", {
      program: "/bin/echo",
      args: ["ok"],
      cwd: worktree,
      env: {},
      permissionProfileOverride: {
        fileSystem: restrictedFileSystemPolicy([
          { path: { kind: "special", value: { kind: "root" } }, access: "read" },
          { path: { kind: "path", path: checkout }, access: "write" },
        ]),
        network: "disabled",
      },
    })).toThrow();
    expect(transform).toHaveBeenCalledOnce();
    const request = (transform.mock.calls[0] as unknown as [{ readonly permissions: PermissionProfile }])[0];
    expect(canWritePathWithCwd(request.permissions.fileSystem, join(checkout, "src", "a.js"), worktree, temp)).toBe(false);
  });
});
