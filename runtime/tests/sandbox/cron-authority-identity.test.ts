import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const identity = vi.hoisted(() => ({ unavailable: false }));
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  return { ...os, userInfo: () => {
    if (identity.unavailable) throw new Error("uv_os_get_passwd returned ENOENT");
    const homedir = process.env.AGENC_TEST_HERMETIC_HOME;
    if (!homedir) throw new Error("Missing owned OS-home fixture");
    return { ...os.userInfo(), homedir };
  } };
});

let workspace: string;
beforeEach(async () => {
  vi.resetModules();
  identity.unavailable = false;
  workspace = await mkdtemp(join(tmpdir(), "agenc-cron-identity-"));
  await mkdir(join(workspace, "home"));
  await mkdir(join(workspace, "tmp"));
});
afterEach(async () => {
  identity.unavailable = false;
  await rm(workspace, { recursive: true, force: true });
});

async function tools() {
  const { SandboxExecutionBroker } = await import("../../src/sandbox/execution-broker.js");
  const { enforceRuntimeSandboxAttempt, permissionProfileForRuntimeContext } = await import("../../src/tools/runtimes/sandboxing.js");
  const { appendCronTask } = await import("../../src/utils/cronTasks.js");
  const { cronLockAuthorityRoot } = await import("../../src/sandbox/cron-authority-protection.js");
  const context = {
    sandboxMode: "workspace_write", approvalResolved: true,
    additionalPermissions: { fileSystem: { entries: [{ path: { kind: "special", value: { kind: "root" } }, access: "write" }] } },
    invocation: { turn: { cwd: workspace }, session: { services: {
      configStore: { homeContext: { path: join(workspace, "home") } },
      runtimeOptions: { sessionTempRoot: join(workspace, "tmp") },
    } } },
  } as never;
  return {
    context, permissionProfileForRuntimeContext, cronLockAuthorityRoot,
    write: (path: string) => enforceRuntimeSandboxAttempt({ context, tool: { name: "Write", metadata: { mutating: true } } as never, args: { file_path: path } }),
    broker: () => new SandboxExecutionBroker({ mode: "workspace_write", cwd: workspace,
      env: { ...process.env, AGENC_HOME: join(workspace, "home") }, sessionTempRoot: join(workspace, "tmp"),
      probe: () => ({ kind: "ready", mode: "workspace_write", platform: process.platform }),
    }),
    persist: () => appendCronTask({ id: "must-not-persist", cron: "* * * * *", prompt: "owned fixture", createdAt: 1, recurring: false }, workspace),
  };
}

describe("cron authority with unavailable OS account identity", () => {
  test("captured-home file policies work while durable storage stays disabled through identity recovery", async () => {
    identity.unavailable = true;
    const f = await tools();
    expect(() => f.write(join(workspace, "ordinary.txt"))).not.toThrow();
    expect(() => f.permissionProfileForRuntimeContext(f.context, { cwd: workspace })).not.toThrow();
    // Fresh POSIX brokers already require OS identity for credential storage,
    // independently of cron. Preserve that existing security boundary.
    expect(() => f.broker()).toThrow(/operating-system account for native secure storage/);
    await expect(f.persist()).rejects.toThrow();
    expect(await readdir(workspace)).toEqual(["home", "tmp"]);
    identity.unavailable = false;
    // An earlier policy was built without a trusted reservation. Recovering a
    // passwd lookup must not enable durable locks under that existing policy.
    await expect(f.persist()).rejects.toThrow(/restart/);
    expect(await readdir(workspace)).toEqual(["home", "tmp"]);
  });

  test("a transient lookup failure retains the known reserved root and permits no durable I/O", async () => {
    const f = await tools();
    const authority = f.cronLockAuthorityRoot();
    const broker = f.broker();
    identity.unavailable = true;
    expect(() => f.write(join(workspace, "ordinary.txt"))).not.toThrow();
    expect(() => f.write(join(authority, "forged"))).toThrow(/Cron locks are reserved/);
    for (const profile of [
      broker.runtimeSandbox("tool")!.permissionProfile,
      f.permissionProfileForRuntimeContext(f.context, { cwd: workspace }),
    ]) expect(profile.fileSystem.reservedReadOnlyPaths).toContain(authority);
    expect(() => f.broker()).toThrow(/operating-system account for native secure storage/);
    await expect(f.persist()).rejects.toThrow();
    expect(await readdir(workspace)).toEqual(["home", "tmp"]);
  });
});
