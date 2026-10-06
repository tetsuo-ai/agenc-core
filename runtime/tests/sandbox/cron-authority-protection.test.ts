import "../helpers/cron-os-home.js";
import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cronLockAuthorityRoot, protectCronAuthority } from "../../src/sandbox/cron-authority-protection.js";
import { canWritePathWithCwd } from "../../src/sandbox/engine/index.js";
import { effectivePermissionProfile } from "../../src/sandbox/engine/policy-transforms.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import { createBwrapCommandArgs } from "../../src/sandbox/linux-launcher/bwrap.js";
import { enforceRuntimeSandboxAttempt, permissionProfileForRuntimeContext, permissionProfileForSandboxMode } from "../../src/tools/runtimes/sandboxing.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "agenc-cron-authority-"));
  roots.push(workspace);
  const authority = cronLockAuthorityRoot();
  await mkdir(authority, { recursive: true, mode: 0o700 });
  const sessionTempRoot = join(workspace, "tmp");
  await mkdir(sessionTempRoot);
  await mkdir(join(workspace, "session-home"), { mode: 0o700 });
  const context = {
    sandboxMode: "workspace_write", approvalResolved: true,
    additionalPermissions: { fileSystem: { entries: [
      { path: { kind: "special", value: { kind: "root" } }, access: "write" },
      { path: { kind: "path", path: authority }, access: "write" },
    ] } },
    invocation: { turn: { cwd: workspace }, session: { services: {
      configStore: { homeContext: { path: join(workspace, "session-home") } },
      runtimeOptions: { sessionTempRoot },
    } } },
  } as never;
  return { workspace, authority, sessionTempRoot, context };
}

describe("native cron lock reservation", () => {
  test("resolves OS identity independently of model, process, and session home settings", async () => {
    const f = await fixture();
    vi.stubEnv("HOME", f.workspace);
    vi.stubEnv("AGENC_HOME", join(f.workspace, "another-home"));
    expect(cronLockAuthorityRoot()).toBe(join(userInfo().homedir, ".agenc-cron-locks-v1"));
    expect(cronLockAuthorityRoot()).toBe(f.authority);
    const profile = permissionProfileForRuntimeContext(f.context, { cwd: f.workspace });
    expect(profile.fileSystem.reservedReadOnlyPaths).toContain(f.authority);
    expect(canWritePathWithCwd(profile.fileSystem, join(f.authority, "tasks.lock.sqlite"), f.workspace, f.sessionTempRoot)).toBe(false);
  });

  test("hard-denies file targets, aliases, and ancestor replacement despite approved grants", async () => {
    const f = await fixture();
    const alias = join(f.workspace, "alias");
    await symlink(f.authority, alias, "dir");
    for (const target of [join(f.authority, "forged"), join(alias, "forged"), f.authority, dirname(f.authority)]) {
      expect(() => enforceRuntimeSandboxAttempt({ context: f.context,
        tool: { name: "Write", metadata: { mutating: true } } as never,
        args: { file_path: target },
      })).toThrow(/Cron locks are reserved for the native host/);
    }
    expect(() => enforceRuntimeSandboxAttempt({ context: f.context,
      tool: { name: "Write", metadata: { mutating: true } } as never,
      args: { file_path: join(f.workspace, "ordinary.txt") },
    })).not.toThrow();
  });

  test("additional permission transforms cannot remove the reservation", async () => {
    const f = await fixture();
    const profile = effectivePermissionProfile(protectCronAuthority(
      permissionProfileForSandboxMode("workspace_write", { cwd: f.workspace }), f.authority,
    ), { fileSystem: { entries: [
      { path: { kind: "special", value: { kind: "root" } }, access: "write" },
      { path: { kind: "path", path: f.authority }, access: "write" },
    ] } });
    expect(canWritePathWithCwd(profile.fileSystem, join(f.authority, "forged"), f.workspace, f.sessionTempRoot)).toBe(false);
  });

  test("broker and cwd forks retain the OS lock authority with changed child home variables", async () => {
    const f = await fixture();
    const broker = new SandboxExecutionBroker({ mode: "workspace_write", cwd: f.workspace,
      env: { ...process.env, HOME: f.workspace, AGENC_HOME: join(f.workspace, "different-home") },
      sessionTempRoot: f.sessionTempRoot,
      probe: () => ({ kind: "ready", mode: "workspace_write", platform: process.platform }),
    });
    for (const active of [broker, broker.forkForCwd(f.authority)]) {
      const profile = active.runtimeSandbox("tool")!.permissionProfile;
      expect(profile.fileSystem.reservedReadOnlyPaths).toContain(f.authority);
      expect(canWritePathWithCwd(profile.fileSystem, join(f.authority, "forged"), active.cwd, f.sessionTempRoot)).toBe(false);
    }
  });

  test("unsafe unused cron storage does not break unrelated sandbox launches or file writes", async () => {
    const f = await fixture();
    const held = `${f.authority}-held`;
    await rename(f.authority, held);
    await symlink(f.workspace, f.authority, "dir");
    try {
      expect(() => enforceRuntimeSandboxAttempt({ context: f.context,
        tool: { name: "Write", metadata: { mutating: true } } as never,
        args: { file_path: join(f.workspace, "ordinary.txt") },
      })).not.toThrow();
      expect(() => enforceRuntimeSandboxAttempt({ context: f.context,
        tool: { name: "Write", metadata: { mutating: true } } as never,
        args: { file_path: f.authority },
      })).toThrow(/Cron locks are reserved/);
      const broker = new SandboxExecutionBroker({ mode: "workspace_write", cwd: f.workspace,
        env: { ...process.env, AGENC_HOME: join(f.workspace, "session-home") },
        sessionTempRoot: f.sessionTempRoot,
        probe: () => ({ kind: "ready", mode: "workspace_write", platform: process.platform }),
      });
      const profile = broker.runtimeSandbox("tool")!.permissionProfile;
      expect(() => createBwrapCommandArgs(["/bin/true"], profile.fileSystem,
        f.workspace, f.workspace, { mountProc: false, networkMode: "isolated", sessionTempRoot: f.sessionTempRoot },
      )).not.toThrow();
    } finally {
      await rm(f.authority);
      await rename(held, f.authority);
    }
  });

  test("an unavailable OS home does not prevent unrelated commands using a configured home", async () => {
    const f = await fixture();
    const missingOsHome = `${f.workspace}-missing-os-home`;
    vi.stubEnv("AGENC_TEST_HERMETIC_HOME", missingOsHome);
    expect(cronLockAuthorityRoot()).toBe(join(missingOsHome, ".agenc-cron-locks-v1"));
    expect(() => enforceRuntimeSandboxAttempt({ context: f.context,
      tool: { name: "Write", metadata: { mutating: true } } as never,
      args: { file_path: join(f.workspace, "ordinary.txt") },
    })).not.toThrow();
    const broker = new SandboxExecutionBroker({ mode: "workspace_write", cwd: f.workspace,
      env: { ...process.env, AGENC_HOME: join(f.workspace, "session-home") },
      sessionTempRoot: f.sessionTempRoot,
      probe: () => ({ kind: "ready", mode: "workspace_write", platform: process.platform }),
    });
    const profile = broker.runtimeSandbox("tool")!.permissionProfile;
    expect(() => createBwrapCommandArgs(["/bin/true"], profile.fileSystem,
      f.workspace, f.workspace, { mountProc: false, networkMode: "isolated", sessionTempRoot: f.sessionTempRoot },
    )).not.toThrow();
  });
});
