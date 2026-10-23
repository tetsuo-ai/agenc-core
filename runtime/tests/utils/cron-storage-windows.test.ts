import "../helpers/cron-os-home.js";
import { constants, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { addSessionCronTask, getSessionCronTasks, resetStateForTests, setProjectRoot, setScheduledTasksEnabled } from "../../src/bootstrap/state.js";
import { CronDeliveryOutboxStore } from "../../src/gateway/cron-outbox.js";
import { EventLog } from "../../src/session/event-log.js";
import { startSessionCronScheduler } from "../../src/session/session-cron-scheduler.js";
import type { Session } from "../../src/session/session.js";
import { CronCreateTool } from "../../src/tools/ScheduleCronTool/CronCreateTool.js";
import { CronDeleteTool } from "../../src/tools/ScheduleCronTool/CronDeleteTool.js";
import { CronListTool } from "../../src/tools/ScheduleCronTool/CronListTool.js";
import { readStartupCronTasks } from "../../src/utils/cron-startup.js";
import { withCronStorage } from "../../src/utils/cron-storage.js";
import { CronScheduler, cronEnqueueToCommandQueue, getCronScheduler, resetCronSchedulerForTests } from "../../src/utils/cronScheduler.js";
import { appendCronTask, cronRestoreFailureNeedsWarning, listSessionCronTasks, markCronTasksFired, readCronTasks, removeCronTasks } from "../../src/utils/cronTasks.js";
import { getCommandQueueSnapshot, resetCommandQueueForTesting } from "../../src/utils/messageQueueManager.js";

const acl = vi.hoisted(() => ({
  assertWindowsPrivatePathSecurity: vi.fn(),
}));
const fsHooks = vi.hoisted(() => ({
  descriptorUnavailable: false,
  directorySyncError: undefined as NodeJS.ErrnoException | undefined,
  beforeRename: undefined as ((from: string, to: string) => void) | undefined,
  agencCanonical: undefined as string | undefined,
  agencCreate: undefined as "eexist" | "eexist-private" | undefined,
  realpaths: [] as string[],
  opens: [] as string[],
  openFlags: [] as Array<readonly [string, unknown]>,
  identitySentinel: undefined as ((path: string) => FileIdMode | undefined) | undefined,
  beforeLstat: undefined as ((path: string) => Promise<void> | void) | undefined,
}));
const privatePaths = vi.hoisted(() => new Set<string>());
// Spoofing win32 on Linux sends the real SQLite lock to the Windows system
// namespace, which throws before any cron write. Tests that must observe a
// rewrite swap only the cross-process lock for an in-process stub.
const lockHooks = vi.hoisted(() => ({ stub: false, acquired: 0 }));
type FileIdMode = "zero" | "all-ones" | "dev-zero" | "ino-zero" | "dev-all-ones" | "ino-all-ones";

vi.mock("../../src/utils/sqlite-lock.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/utils/sqlite-lock.js")>();
  return {
    ...original,
    assertLocalPrivateDirectory: async (
      ...args: Parameters<typeof original.assertLocalPrivateDirectory>
    ) => (lockHooks.stub ? args[0] : original.assertLocalPrivateDirectory(...args)),
    acquireLocalSqliteLock: async (...args: Parameters<typeof original.acquireLocalSqliteLock>) => {
      if (!lockHooks.stub) return original.acquireLocalSqliteLock(...args);
      lockHooks.acquired += 1;
      return () => {};
    },
  };
});
vi.mock("../../src/agents/workflow-private-path.js", () => ({
  assertWindowsPrivatePathSecurity: acl.assertWindowsPrivatePathSecurity,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  // Windows reports 0 or all ones when a filesystem has no file id.
  const withoutFileId = <Info extends { dev: number | bigint; ino: number | bigint }>(
    info: Info,
    mode: FileIdMode | undefined,
  ): Info => {
    if (mode === undefined) return info;
    const value = (id: "dev" | "ino"): number | bigint => {
      const missing = mode === "zero" || mode === "all-ones" ||
        (mode === "dev-zero" && id === "dev") || (mode === "ino-zero" && id === "ino") ||
        (mode === "dev-all-ones" && id === "dev") || (mode === "ino-all-ones" && id === "ino");
      if (!missing) return info[id];
      const ones = mode === "all-ones" || mode === "dev-all-ones" || mode === "ino-all-ones";
      if (typeof info.dev === "bigint") return ones ? 0xffff_ffff_ffff_ffffn : 0n;
      return ones ? Number.MAX_SAFE_INTEGER : 0;
    };
    return Object.assign(Object.create(Object.getPrototypeOf(info) as object) as Info, info,
      { dev: value("dev"), ino: value("ino") });
  };
  return {
    ...original,
    lstat: async (...args: Parameters<typeof original.lstat>) => {
      await fsHooks.beforeLstat?.(String(args[0]));
      const info = await original.lstat(...args);
      return withoutFileId(info, fsHooks.identitySentinel?.(String(args[0])));
    },
    realpath: async (...args: Parameters<typeof original.realpath>) => {
      const path = String(args[0]);
      fsHooks.realpaths.push(path);
      if (fsHooks.descriptorUnavailable && /^\/(?:proc\/self\/fd|dev\/fd)\//u.test(path)) {
        throw Object.assign(new Error("No traversable descriptor alias"), { code: "ENOENT" });
      }
      if (fsHooks.agencCanonical !== undefined && path.endsWith(`${sep}.agenc`)) {
        return fsHooks.agencCanonical;
      }
      return original.realpath(...args);
    },
    mkdir: async (path: string, options?: { mode?: number; recursive?: boolean }) => {
      if (path.endsWith(`${sep}.agenc`) && options?.recursive === true) {
        // Recursive mkdir resolves for an existing directory instead of EEXIST.
        throw new Error("recursive mkdir cannot report an existing .agenc");
      }
      if (fsHooks.agencCreate !== undefined && path.endsWith(`${sep}.agenc`)) {
        await original.mkdir(path, options);
        if (fsHooks.agencCreate === "eexist-private") {
          privatePaths.add(`directory\0${path}`);
        }
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      }
      return original.mkdir(path, options);
    },
    rename: async (...args: Parameters<typeof original.rename>) => {
      fsHooks.beforeRename?.(String(args[0]), String(args[1]));
      return original.rename(...args);
    },
    open: async (...args: Parameters<typeof original.open>) => {
      const path = String(args[0]);
      fsHooks.opens.push(path);
      fsHooks.openFlags.push([path, args[1]]);
      if (
        fsHooks.directorySyncError !== undefined &&
        args[1] === "r" &&
        path.endsWith(`${sep}.agenc`)
      ) {
        throw fsHooks.directorySyncError;
      }
      const handle = await original.open(...args);
      const mode = fsHooks.identitySentinel?.(path);
      if (mode !== undefined) {
        const stat = handle.stat.bind(handle);
        handle.stat = (async (options?: { bigint?: boolean }) =>
          withoutFileId(await stat(options as never), mode)) as typeof handle.stat;
      }
      return handle;
    },
  };
});

const taskRecord = {
  tasks: [{ id: "kept", cron: "* * * * *", prompt: "survive restart", createdAt: 1_000 }],
};
const body = `${JSON.stringify(taskRecord, null, 2)}\n`;
const PERMISSIONS_ERROR = "Cron storage must be owned by the current user and not writable by other users";
let root: string;
let workspace: string;
let outside: string;

function installAclMock(): void {
  privatePaths.clear();
  acl.assertWindowsPrivatePathSecurity.mockReset();
  acl.assertWindowsPrivatePathSecurity.mockImplementation((
    path: string,
    role: "directory" | "file",
    initialize: boolean,
  ) => {
    const key = `${role}\0${path}`;
    if (initialize) {
      privatePaths.add(key);
      return;
    }
    if (!privatePaths.has(key)) {
      throw new Error(`private ACL missing for ${path}`);
    }
  });
}

function aclMutations(): ReadonlyArray<readonly unknown[]> {
  return acl.assertWindowsPrivatePathSecurity.mock.calls.filter((call) => call[2] === true);
}

function metadataDirectory(): string {
  return join(realpathSync(workspace), ".agenc");
}

function usedDescriptorAlias(): boolean {
  return [...fsHooks.realpaths, ...fsHooks.opens]
    .some((path) => /^\/(?:proc\/self\/fd|dev\/fd)\//u.test(path));
}

async function writeRecord(): Promise<void> {
  await withCronStorage(workspace, true, async (storage) => {
    await storage.write(body);
  });
}

beforeEach(async () => {
  installAclMock();
  fsHooks.descriptorUnavailable = false;
  fsHooks.directorySyncError = undefined;
  fsHooks.beforeRename = undefined;
  fsHooks.agencCanonical = undefined;
  fsHooks.agencCreate = undefined;
  fsHooks.realpaths = [];
  fsHooks.opens = [];
  fsHooks.openFlags = [];
  fsHooks.identitySentinel = undefined;
  fsHooks.beforeLstat = undefined;
  lockHooks.stub = false;
  lockHooks.acquired = 0;
  root = await mkdtemp(join(tmpdir(), "agenc-cron-windows-"));
  workspace = join(root, "workspace");
  outside = join(root, "outside");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
});
afterEach(async () => {
  fsHooks.beforeRename = undefined;
  fsHooks.beforeLstat = undefined;
  fsHooks.identitySentinel = undefined;
  await resetCronSchedulerForTests();
  resetCommandQueueForTesting();
  resetStateForTests();
  await rm(root, { recursive: true, force: true });
});

async function cronTool(name: "CronCreate" | "CronList" | "CronDelete", session: Partial<Session>) {
  const { createModelFacingTools } = await import("../../src/bin/model-facing-tools.js");
  return createModelFacingTools({ workspaceRoot: workspace, getSession: () => session as Session })
    .find((tool) => tool.name === name)!;
}

describe.skipIf(process.platform === "win32")("POSIX cron storage keeps descriptor confinement", () => {
  test.skipIf(process.platform !== "linux")("persists through descriptor handles without the Windows ACL", async () => {
    await writeRecord();
    expect(await withCronStorage(workspace, false, (storage) => storage.read())).toBe(body);
    expect(acl.assertWindowsPrivatePathSecurity).not.toHaveBeenCalled();
    expect((await readCronTasks(workspace)).map((entry) => entry.id)).toEqual(["kept"]);
  });

  test.skipIf(process.platform !== "linux")("keeps durable creation, startup restore, and gateway scheduling on Linux", async () => {
    await appendCronTask({ ...taskRecord.tasks[0]!, id: "linux-kept" }, workspace);
    expect((await readStartupCronTasks(workspace, () => {})).map((entry) => entry.id)).toEqual(["linux-kept"]);
    await expect(new CronDeliveryOutboxStore(workspace).schedule()).resolves.toEqual([]);
    const create = await cronTool("CronCreate", { conversationId: "linux-durable" });
    const created = await create.execute({ cron: "* * * * *", prompt: "linux durable work", durable: true });
    expect(created.isError).toBeFalsy();
    expect((await readCronTasks(workspace)).map((entry) => entry.prompt))
      .toEqual([taskRecord.tasks[0]!.prompt, "linux durable work"]);
    expect(acl.assertWindowsPrivatePathSecurity).not.toHaveBeenCalled();
  });

  test.skipIf(process.platform !== "linux")("lists durable jobs on Linux without a dormant label", async () => {
    await writeRecord();
    const listed = await (await cronTool("CronList", { conversationId: "linux-list" })).execute({});
    const output = JSON.parse(String(listed.content)) as { warning?: string; crons: Array<Record<string, unknown>> };
    expect(output.warning).toBeUndefined();
    expect(output.crons).toEqual([expect.not.objectContaining({ dormant: true })]);
    expect(output.crons[0]).not.toHaveProperty("dormant");
    setProjectRoot(workspace);
    const legacy = await CronListTool.call({}, { sessionId: "linux-list" } as never);
    expect(legacy.data.warning).toBeUndefined();
    expect(legacy.data.jobs).toEqual([expect.not.objectContaining({ dormant: true })]);
    expect(legacy.data.jobs[0]).not.toHaveProperty("dormant");
  });

  test("rejects an unavailable descriptor alias without applying the Windows fallback", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    fsHooks.descriptorUnavailable = true;
    fsHooks.realpaths = [];
    fsHooks.opens = [];
    try {
      await expect(writeRecord()).rejects.toMatchObject({ code: "DESCRIPTOR_UNSUPPORTED" });
      expect(acl.assertWindowsPrivatePathSecurity).not.toHaveBeenCalled();
      expect(usedDescriptorAlias()).toBe(true);
      expect(await readdir(workspace)).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  test("keeps the Windows private-path policy off the Darwin descriptor failure", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    fsHooks.descriptorUnavailable = true;
    try {
      await expect(writeRecord()).rejects.toMatchObject({ code: "DESCRIPTOR_UNSUPPORTED" });
      expect(acl.assertWindowsPrivatePathSecurity).not.toHaveBeenCalled();
      expect(await readdir(workspace)).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});

describe("Windows cron storage uses private-path persistence", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  beforeEach(() => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
  });

  test("reads back a record when directory descriptors are unavailable", async () => {
    fsHooks.descriptorUnavailable = true;
    fsHooks.realpaths = [];
    fsHooks.opens = [];
    await writeRecord();
    expect(usedDescriptorAlias()).toBe(false);
    expect(await withCronStorage(workspace, false, (storage) => storage.read())).toBe(body);
    expect((await readCronTasks(workspace)).map((entry) => entry.id)).toEqual(["kept"]);
    const paths = acl.assertWindowsPrivatePathSecurity.mock.calls.map(([path]) => basename(String(path)));
    expect(paths).toContain(".agenc");
    expect(paths.some((name) => name.includes("scheduled_tasks.json"))).toBe(true);
    expect(paths.every((name) => name === ".agenc" || name.includes("scheduled_tasks.json"))).toBe(true);
    expect(acl.assertWindowsPrivatePathSecurity).toHaveBeenCalledWith(
      expect.stringMatching(/\.agenc$/u), "directory", true,
    );
    expect(acl.assertWindowsPrivatePathSecurity).toHaveBeenCalledWith(
      expect.stringMatching(/scheduled_tasks\.json\.[^/\\]+\.tmp$/u), "file", true,
    );
  });

  test("does not consult the ACL helper when the metadata directory is absent", async () => {
    expect(await withCronStorage(workspace, false, (storage) => storage.read())).toBeUndefined();
    expect(acl.assertWindowsPrivatePathSecurity).not.toHaveBeenCalled();
    expect(await readCronTasks(workspace)).toEqual([]);
    expect(await readStartupCronTasks(workspace, () => {})).toEqual([]);
  });

  test("publishes when Windows directory sync is unsupported", async () => {
    fsHooks.directorySyncError = Object.assign(new Error("directory sync unsupported"), { code: "EISDIR" });
    await writeRecord();
    expect(await readFile(join(workspace, ".agenc", "scheduled_tasks.json"), "utf8")).toBe(body);
  });

  test("does not publish when the private-directory ACL cannot be established", async () => {
    acl.assertWindowsPrivatePathSecurity.mockImplementation(() => {
      throw new Error("inherited ACL is unsupported");
    });
    await expect(writeRecord()).rejects.toThrow("inherited ACL is unsupported");
    expect(await readdir(join(workspace, ".agenc")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })).not.toContain("scheduled_tasks.json");
  });

  test("does not publish through a canonical metadata directory with a different inode", async () => {
    const decoy = join(outside, "decoy");
    await mkdir(decoy, { mode: 0o700 });
    acl.assertWindowsPrivatePathSecurity(decoy, "directory", true);
    fsHooks.agencCanonical = decoy;
    await expect(writeRecord()).rejects.toThrow(
      "Cron storage must be owned by the current user and not writable by other users",
    );
    expect(await readdir(decoy)).toEqual([]);
    expect(await readdir(join(workspace, ".agenc")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })).not.toContain("scheduled_tasks.json");
  });

  test("rejects a symlinked metadata directory before publication", async () => {
    const planted = join(outside, "scheduled_tasks.json");
    writeFileSync(planted, "outside");
    symlinkSync(outside, join(workspace, ".agenc"));
    await expect(writeRecord()).rejects.toThrow(
      "Cron storage must be owned by the current user and not writable by other users",
    );
    expect(await readFile(planted, "utf8")).toBe("outside");
    expect(acl.assertWindowsPrivatePathSecurity).not.toHaveBeenCalled();
  });

  test("rejects an existing metadata directory with an unsafe ACL without tightening it", async () => {
    const directory = metadataDirectory();
    await mkdir(directory, { mode: 0o700 });
    const record = join(directory, "scheduled_tasks.json");
    writeFileSync(record, body);
    const permissions = { message: PERMISSIONS_ERROR, cause: expect.objectContaining({
      message: expect.stringContaining("private ACL missing"),
    }) };
    await expect(withCronStorage(workspace, false, (storage) => storage.read())).rejects.toMatchObject(permissions);
    await expect(withCronStorage(workspace, true, async (storage) => {
      await storage.write(body);
    })).rejects.toMatchObject(permissions);
    await expect(readCronTasks(workspace)).rejects.toThrow(PERMISSIONS_ERROR);
    await expect(readStartupCronTasks(workspace, () => {})).rejects.toThrow(PERMISSIONS_ERROR);
    expect(acl.assertWindowsPrivatePathSecurity).toHaveBeenCalledWith(
      expect.stringMatching(/\.agenc$/u), "directory", false,
    );
    expect(aclMutations()).toHaveLength(0);
    expect(await readFile(record, "utf8")).toBe(body);
  });

  test("validates an EEXIST metadata directory instead of initializing it", async () => {
    fsHooks.agencCreate = "eexist";
    await expect(writeRecord()).rejects.toMatchObject({
      message: PERMISSIONS_ERROR,
      cause: expect.objectContaining({
        message: expect.stringContaining("private ACL missing"),
      }),
    });
    expect(acl.assertWindowsPrivatePathSecurity).toHaveBeenCalledWith(
      expect.stringMatching(/\.agenc$/u), "directory", false,
    );
    expect(aclMutations()).toHaveLength(0);
    expect(await readdir(metadataDirectory())).not.toContain("scheduled_tasks.json");
  });

  test("does not initialize a private directory reported as EEXIST", async () => {
    fsHooks.agencCreate = "eexist-private";
    await writeRecord();
    const directoryInits = aclMutations().filter((call) => call[1] === "directory");
    expect(directoryInits).toHaveLength(0);
    expect(acl.assertWindowsPrivatePathSecurity).toHaveBeenCalledWith(
      expect.stringMatching(/\.agenc$/u), "directory", false,
    );
    expect(await withCronStorage(workspace, false, (storage) => storage.read())).toBe(body);
  });

  test("initializes a metadata directory once when this call creates it", async () => {
    await writeRecord();
    const directoryCalls = acl.assertWindowsPrivatePathSecurity.mock.calls.filter(
      ([path, role]) => role === "directory" && String(path).endsWith(`${sep}.agenc`),
    );
    expect(directoryCalls.filter((call) => call[2] === true)).toHaveLength(1);
    expect(directoryCalls[0]?.[2]).toBe(true);
    expect(directoryCalls.slice(1).every((call) => call[2] === false)).toBe(true);
    expect(directoryCalls.length).toBeGreaterThan(1);

    acl.assertWindowsPrivatePathSecurity.mockClear();
    expect(await withCronStorage(workspace, false, (storage) => storage.read())).toBe(body);
    const reopened = acl.assertWindowsPrivatePathSecurity.mock.calls.filter(
      ([path, role]) => role === "directory" && String(path).endsWith(`${sep}.agenc`),
    );
    expect(reopened.length).toBeGreaterThan(0);
    expect(reopened.every((call) => call[2] === false)).toBe(true);
  });

  test("replaces an unsafe task file only after the metadata directory is valid", async () => {
    const directory = metadataDirectory();
    await mkdir(directory, { mode: 0o700 });
    const record = join(directory, "scheduled_tasks.json");
    writeFileSync(record, "unsafe");
    privatePaths.add(`directory\0${directory}`);
    await expect(withCronStorage(workspace, false, (storage) => storage.read())).rejects.toMatchObject({
      name: "ConfinedIoError",
      message: expect.stringContaining("child does not have the required private ACL"),
    });
    expect(aclMutations()).toHaveLength(0);
    expect(await readFile(record, "utf8")).toBe("unsafe");

    acl.assertWindowsPrivatePathSecurity.mockClear();
    const renames: Array<[string, string]> = [];
    fsHooks.beforeRename = (from, to) => {
      renames.push([from, to]);
      if (to === record) {
        expect(readFileSync(to, "utf8")).toBe("unsafe");
        expect(readFileSync(from, "utf8")).toBe(body);
      }
    };
    await withCronStorage(workspace, true, async (storage) => {
      await storage.write(body);
    });
    expect(renames.some(([from, to]) => to === record && /scheduled_tasks\.json\.[^/\\]+\.tmp$/u.test(from))).toBe(true);
    expect(await readFile(record, "utf8")).toBe(body);
    expect(aclMutations().filter((call) => call[1] === "directory")).toHaveLength(0);
    expect(acl.assertWindowsPrivatePathSecurity).toHaveBeenCalledWith(
      expect.stringMatching(/scheduled_tasks\.json\.[^/\\]+\.tmp$/u), "file", true,
    );
    expect(await withCronStorage(workspace, false, (storage) => storage.read())).toBe(body);
  });

  test("rejects a temporary file replaced before publication", async () => {
    const planted = join(outside, "planted.json");
    writeFileSync(planted, "outside");
    fsHooks.beforeRename = (from) => {
      fsHooks.beforeRename = undefined;
      unlinkSync(from);
      symlinkSync(planted, from);
    };
    await expect(writeRecord()).rejects.toThrow("Cron temporary publication file was replaced or linked");
    expect(await readFile(planted, "utf8")).toBe("outside");
  });

  test("warns at startup about an existing durable record instead of arming it", async () => {
    await writeRecord();
    const error: unknown = await readStartupCronTasks(workspace, () => {}).catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: "DESCRIPTOR_UNSUPPORTED",
      message: expect.stringContaining("dispatched only on Linux"),
    });
    expect(await cronRestoreFailureNeedsWarning(error, workspace)).toBe(true);
    expect(await readFile(join(workspace, ".agenc", "scheduled_tasks.json"), "utf8")).toBe(body);
  });

  test("refuses durable and delivery-routed creates before writing", async () => {
    const create = await cronTool("CronCreate", { conversationId: "windows-durable" });
    for (const extra of [
      { durable: true },
      { announceChannel: "stdio", announceTo: "windows-recipient" },
      { webhook: "https://example.invalid/hook" },
    ]) {
      const result = await create.execute({ cron: "* * * * *", prompt: "durable work", ...extra });
      expect(result.isError).toBe(true);
      expect(String(result.content)).toContain("Use durable:false");
      expect(result.effectDisposition?.disposition).toBe("confirmed_no_effect");
    }
    setProjectRoot(workspace);
    expect(await CronCreateTool.validateInput({
      cron: "* * * * *", prompt: "delivery work", durable: false,
      announceChannel: "stdio", announceTo: "windows-recipient",
    }, { sessionId: "windows-durable" } as never)).toMatchObject({ result: false, errorCode: 8 });
    await expect(appendCronTask({ ...taskRecord.tasks[0]!, id: "direct" }, workspace))
      .rejects.toMatchObject({ code: "DESCRIPTOR_UNSUPPORTED" });
    expect(await readdir(workspace)).toEqual([]);
    expect(getSessionCronTasks()).toEqual([]);
    expect(acl.assertWindowsPrivatePathSecurity).not.toHaveBeenCalled();
  });

  test("keeps session-only jobs working without durable storage", async () => {
    const session = { conversationId: "windows-session" };
    const created = await (await cronTool("CronCreate", session))
      .execute({ cron: "* * * * *", prompt: "session work" });
    expect(created.isError).toBeFalsy();
    const id = (JSON.parse(String(created.content)) as { cron: { id: string; durable: boolean } }).cron;
    expect(id.durable).toBe(false);
    expect(getSessionCronTasks().map((entry) => entry.id)).toEqual([id.id]);
    const listed = await (await cronTool("CronList", session)).execute({});
    expect(listed.isError).toBeFalsy();
    expect((JSON.parse(String(listed.content)) as { crons: { id: string }[] }).crons)
      .toEqual([expect.objectContaining({ id: id.id })]);
    const deleted = await (await cronTool("CronDelete", session)).execute({ id: id.id });
    expect(JSON.parse(String(deleted.content))).toEqual({ deleted: true, id: id.id });
    expect(getSessionCronTasks()).toEqual([]);
    expect(await readdir(workspace)).toEqual([]);
  });

  test("CronList labels stored durable jobs as dormant, not scheduled", async () => {
    await writeRecord();
    const session = { conversationId: "windows-list" };
    addSessionCronTask({
      id: "session-listed", cron: "* * * * *", prompt: "session work", createdAt: 2_000,
      queueOwner: { kind: "session", conversationId: "windows-list" },
    });
    const listed = await (await cronTool("CronList", session)).execute({});
    expect(listed.isError).toBeFalsy();
    const output = JSON.parse(String(listed.content)) as {
      warning?: string;
      crons: Array<{ id: string; durable?: boolean; dormant?: boolean }>;
    };
    expect(output.warning).toContain("dormant");
    expect(output.crons).toEqual([
      expect.objectContaining({ id: "kept", durable: true, dormant: true }),
      expect.not.objectContaining({ dormant: true }),
    ]);
    expect(output.crons[1]!.id).toBe("session-listed");

    setProjectRoot(workspace);
    const legacy = await CronListTool.call({}, { sessionId: "windows-list" } as never);
    expect(legacy.data.warning).toContain("not scheduled on this host");
    expect(legacy.data.jobs.map((job) => [job.id, job.dormant === true])).toEqual([
      ["kept", true],
      ["session-listed", false],
    ]);
    const rendered = CronListTool.mapToolResultToToolResultBlockParam(legacy.data, "list").content;
    expect(rendered).toMatch(/^kept .*\[dormant: not scheduled on this host\]/mu);
    expect(rendered).not.toMatch(/^session-listed .*dormant/mu);
    expect(await readFile(join(workspace, ".agenc", "scheduled_tasks.json"), "utf8")).toBe(body);
  });

  const manyDurable = `${JSON.stringify({
    tasks: Array.from({ length: 50 }, (_, index) => ({
      id: `dormant-${index}`, cron: "* * * * *", prompt: "stored durable work", createdAt: 1_000,
    })),
  }, null, 2)}\n`;

  test("dormant durable records do not count toward the session job limit", async () => {
    await withCronStorage(workspace, true, async (storage) => {
      await storage.write(manyDurable);
    });
    setProjectRoot(workspace);
    const input = { cron: "* * * * *", prompt: "session work", durable: false };
    expect(await CronCreateTool.validateInput(input, { sessionId: "windows-limit" } as never))
      .toEqual({ result: true });
    const created = await (await cronTool("CronCreate", { conversationId: "windows-limit" }))
      .execute({ cron: "* * * * *", prompt: "session work" });
    expect(created.isError).toBeFalsy();
    expect(await readFile(join(workspace, ".agenc", "scheduled_tasks.json"), "utf8")).toBe(manyDurable);
  });

  test("an unreadable dormant record does not refuse a session-only create", async () => {
    await writeRecord();
    // The stored record no longer passes the private ACL check, so reading it
    // fails with an error other than DESCRIPTOR_UNSUPPORTED.
    privatePaths.clear();
    setProjectRoot(workspace);
    const input = { cron: "* * * * *", prompt: "session work", durable: false };
    expect(await CronCreateTool.validateInput(input, { sessionId: "windows-unreadable" } as never))
      .toEqual({ result: true });
    const created = await CronCreateTool.call(input, { sessionId: "windows-unreadable" } as never);
    expect(created.data.durable).toBe(false);
    expect(getSessionCronTasks().map((task) => task.id)).toEqual([created.data.id]);
    expect(await readFile(join(workspace, ".agenc", "scheduled_tasks.json"), "utf8")).toBe(body);
  });

  test("fires a session-only job and leaves a stored durable record unarmed", async () => {
    await writeRecord();
    lockHooks.stub = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(new Date("2026-07-07T12:00:30Z"));
    const closes: Array<() => Promise<void>> = [];
    const abortController = new AbortController();
    const submit = vi.fn(async (_prompt: string, options: { onAccepted: () => Promise<void> }) => {
      await options.onAccepted();
    });
    const session = {
      conversationId: "windows-session-fire", abortController, eventLog: new EventLog(),
      services: { mcpStartupCancellationToken: { signal: abortController.signal } },
      nextInternalSubId: () => "windows-session-warning",
      onBeforeDurableClose: (close: () => Promise<void>) => { closes.push(close); },
      onTurnDriverReady: (ready: () => void) => { ready(); return () => {}; },
      submit,
    } as unknown as Session;
    try {
      const created = await (await cronTool("CronCreate", session))
        .execute({ cron: "* * * * *", prompt: "session work", recurring: false });
      expect(created.isError).toBeFalsy();
      const scheduler = await startSessionCronScheduler(session, workspace);
      await vi.advanceTimersByTimeAsync(60_000);
      await scheduler.drain();
      expect(submit).toHaveBeenCalledExactlyOnceWith("session work", expect.objectContaining({
        onAccepted: expect.any(Function),
      }));
      expect(await readFile(join(workspace, ".agenc", "scheduled_tasks.json"), "utf8")).toBe(body);
      expect(lockHooks.acquired).toBe(0);
    } finally {
      await Promise.all(closes.map((close) => close()));
      vi.useRealTimers();
    }
  });

  test("keeps gateway delivery off a readable durable record", async () => {
    await writeRecord();
    await expect(new CronDeliveryOutboxStore(workspace).schedule()).rejects.toMatchObject({
      code: "DESCRIPTOR_UNSUPPORTED",
      message: expect.stringContaining("dispatched only on Linux"),
    });
    expect(await readFile(join(workspace, ".agenc", "scheduled_tasks.json"), "utf8")).toBe(body);
  });

  test("creates the publication temporary exclusively", async () => {
    await writeRecord();
    const temporaries = fsHooks.openFlags
      .filter(([path]) => /scheduled_tasks\.json\.[^/\\]+\.tmp$/u.test(path));
    expect(temporaries).toHaveLength(1);
    const flags = Number(temporaries[0]![1]);
    expect(flags & constants.O_EXCL).toBe(constants.O_EXCL);
    expect(flags & constants.O_CREAT).toBe(constants.O_CREAT);
  });

  // Each single-field mode leaves the other field valid, so every clause of
  // hasCronFileIdentity is needed by at least one row.
  const fileIdModes: FileIdMode[] = ["zero", "all-ones", "dev-zero", "ino-zero", "dev-all-ones", "ino-all-ones"];

  test.each(fileIdModes)("rejects a workspace that reports no file id (%s)", async (mode) => {
    fsHooks.identitySentinel = (path) => (path.endsWith(`${sep}workspace`) ? mode : undefined);
    await expect(writeRecord()).rejects.toThrow(PERMISSIONS_ERROR);
    expect(await readdir(workspace)).toEqual([]);
    expect(acl.assertWindowsPrivatePathSecurity).not.toHaveBeenCalled();
  });

  test.each(fileIdModes)("rejects a metadata directory that alone reports no file id (%s)", async (mode) => {
    fsHooks.identitySentinel = (path) => (path.endsWith(`${sep}.agenc`) ? mode : undefined);
    await expect(writeRecord()).rejects.toThrow(PERMISSIONS_ERROR);
    expect(await readdir(join(workspace, ".agenc")).catch(() => [])).toEqual([]);
  });

  test.each(fileIdModes)("rejects a publication temporary that reports no file id (%s)", async (mode) => {
    fsHooks.identitySentinel = (path) =>
      (/scheduled_tasks\.json(?:\.[^/\\]+\.tmp)?$/u.test(path) ? mode : undefined);
    await expect(writeRecord()).rejects.toThrow("Cron temporary publication file was replaced or linked");
    expect(await readdir(metadataDirectory())).not.toContain("scheduled_tasks.json");
  });

  const storedRecord = (recurring: boolean): string => `${JSON.stringify({
    tasks: [{
      id: recurring ? "stored-recurring" : "stored-once",
      cron: "* * * * *",
      prompt: "stored durable work",
      createdAt: Date.parse("2026-07-07T11:59:00Z"),
      ...(recurring ? { recurring: true } : {}),
    }],
  }, null, 2)}\n`;

  test.each([true, false])("the stubbed lock lets the harness observe a stored record rewrite (recurring=%s)",
    async (recurring) => {
      const stored = storedRecord(recurring);
      await withCronStorage(workspace, true, async (storage) => {
        await storage.write(stored);
      });
      const record = join(workspace, ".agenc", "scheduled_tasks.json");
      lockHooks.stub = true;
      if (recurring) await markCronTasksFired(["stored-recurring"], Date.parse("2026-07-07T12:01:00Z"), workspace);
      else await removeCronTasks(["stored-once"], workspace);
      expect(lockHooks.acquired).toBe(1);
      const rewritten = await readFile(record, "utf8");
      expect(rewritten).not.toBe(stored);
      expect(rewritten).toContain(recurring ? "lastFiredAt" : '"tasks": []');
    });

  // Seeds a readable durable record, runs `activate` under fake timers, and
  // proves no process scheduler queued or rewrote that record. The lock stub
  // lets a rewrite reach storage, so the byte check is live, and a lock
  // acquisition alone shows a durable transaction was attempted.
  async function expectStoredRecordUnarmed(
    recurring: boolean,
    activate: () => Promise<void>,
    expectedPrompts: readonly string[],
    scheduler: () => CronScheduler = getCronScheduler,
  ): Promise<void> {
    const stored = storedRecord(recurring);
    await withCronStorage(workspace, true, async (storage) => {
      await storage.write(stored);
    });
    lockHooks.stub = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(new Date("2026-07-07T12:00:30Z"));
    try {
      await activate();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await scheduler().drain();
      expect(await readFile(join(workspace, ".agenc", "scheduled_tasks.json"), "utf8")).toBe(stored);
      expect(lockHooks.acquired).toBe(0);
      expect(getCommandQueueSnapshot().map((command) => command.value)).toEqual(expectedPrompts);
    } finally {
      vi.useRealTimers();
    }
  }

  test.each([true, false])("legacy session-only CronCreate leaves a stored durable record unarmed (recurring=%s)",
    async (recurring) => {
      await expectStoredRecordUnarmed(recurring, async () => {
        setProjectRoot(workspace);
        const created = await CronCreateTool.call(
          { cron: "* * * * *", prompt: "session work", recurring: false, durable: false },
          { sessionId: "windows-legacy" } as never,
        );
        expect(created.data.durable).toBe(false);
        // call() arms with `void reschedule()`; a later awaited reschedule
        // supersedes it, so the timer is armed before virtual time advances.
        await getCronScheduler().reschedule();
      }, ["session work"]);
    });

  test("CronDelete without a session driver leaves a stored durable record unarmed", async () => {
    await expectStoredRecordUnarmed(true, async () => {
      addSessionCronTask({
        id: "session-delete", cron: "* * * * *", prompt: "deleted session work", createdAt: Date.now(),
        queueOwner: { kind: "session", conversationId: "windows-delete" },
      });
      const deleted = await (await cronTool("CronDelete", { conversationId: "windows-delete" }))
        .execute({ id: "session-delete" });
      expect(JSON.parse(String(deleted.content))).toEqual({ deleted: true, id: "session-delete" });
    }, []);
  });

  test("a scheduler with the default loader leaves a stored durable record unarmed", async () => {
    const scheduler = new CronScheduler({ enqueue: cronEnqueueToCommandQueue }, { dir: undefined });
    try {
      await expectStoredRecordUnarmed(true, async () => {
        setScheduledTasksEnabled(true);
        scheduler.start({ queueOwner: { kind: "session", conversationId: "windows-default" }, workspaceRoot: workspace });
        await scheduler.reschedule();
      }, [], () => scheduler);
    } finally {
      scheduler.stop();
      await scheduler.drain();
    }
  });

  test("a mount-style process scheduler activation leaves a stored durable record unarmed", async () => {
    await expectStoredRecordUnarmed(false, async () => {
      setScheduledTasksEnabled(true);
      const scheduler = getCronScheduler();
      scheduler.start({ queueOwner: { kind: "session", conversationId: "windows-mount" }, workspaceRoot: workspace });
      await scheduler.reschedule();
    }, []);
  });
});

// A normal existing Windows `.agenc` inherits its parent's ACL. The fake ACL
// helper rejects any path it did not initialize, which models that inherited
// directory. With no record there, reads must report absence (as before the
// Windows storage path existed) without reading or changing anything.
describe("Windows inherited .agenc without a cron record", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const conversationId = "windows-inherited";
  const context = { sessionId: conversationId } as never;
  beforeEach(async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    await mkdir(metadataDirectory());
    setProjectRoot(workspace);
    addSessionCronTask({
      id: "session-job", cron: "* * * * *", prompt: "session work", createdAt: Date.now(),
      queueOwner: { kind: "session", conversationId },
    });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
  });

  async function expectUntouched(): Promise<void> {
    expect(aclMutations()).toHaveLength(0);
    expect(await readdir(metadataDirectory())).toEqual([]);
  }

  test("the fixture directory fails the private ACL check", () => {
    expect(() => acl.assertWindowsPrivatePathSecurity(metadataDirectory(), "directory", false))
      .toThrow("private ACL missing");
  });

  test("reads report absence and startup needs no warning", async () => {
    expect(await withCronStorage(workspace, false, (storage) => storage.read())).toBeUndefined();
    expect(await readCronTasks(workspace)).toEqual([]);
    let warning = false;
    try { expect(await readStartupCronTasks(workspace, () => {})).toEqual([]); }
    catch (error) { warning = await cronRestoreFailureNeedsWarning(error, workspace); }
    expect(warning).toBe(false);
    await expectUntouched();
  });

  test("legacy and model-facing CronList return the session job without a warning", async () => {
    const legacy = await CronListTool.call({}, context);
    expect(legacy.data.jobs.map((job) => job.id)).toEqual(["session-job"]);
    expect(legacy.data.warning).toBeUndefined();
    const listed = await (await cronTool("CronList", { conversationId })).execute({});
    expect(listed.isError).toBeFalsy();
    const output = JSON.parse(String(listed.content)) as { crons: Array<{ id: string }>; warning?: string };
    expect(output.crons.map((job) => job.id)).toEqual(["session-job"]);
    expect(output.warning).toBeUndefined();
    await expectUntouched();
  });

  test("legacy CronDelete validates and deletes the session job", async () => {
    const input = { id: "session-job" };
    expect((await CronDeleteTool.validateInput(input, context)).result).toBe(true);
    await CronDeleteTool.call(input, context);
    expect(listSessionCronTasks(conversationId)).toHaveLength(0);
    await expectUntouched();
  });

  test("model-facing CronDelete deletes the session job", async () => {
    const deleted = await (await cronTool("CronDelete", { conversationId })).execute({ id: "session-job" });
    expect(JSON.parse(String(deleted.content))).toMatchObject({ deleted: true, id: "session-job" });
    expect(listSessionCronTasks(conversationId)).toHaveLength(0);
    await expectUntouched();
  });

  test("control: an existing record in the inherited directory is still rejected", async () => {
    const record = join(metadataDirectory(), "scheduled_tasks.json");
    writeFileSync(record, body);
    await expect(readCronTasks(workspace)).rejects.toThrow(PERMISSIONS_ERROR);
    await expect(CronListTool.call({}, context)).rejects.toThrow(PERMISSIONS_ERROR);
    const error: unknown = await readStartupCronTasks(workspace, () => {}).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ message: PERMISSIONS_ERROR });
    expect(await cronRestoreFailureNeedsWarning(error, workspace)).toBe(true);
    await expect(withCronStorage(workspace, true, async (storage) => {
      await storage.write("{}\n");
    })).rejects.toThrow(PERMISSIONS_ERROR);
    expect(aclMutations()).toHaveLength(0);
    expect(await readFile(record, "utf8")).toBe(body);
  });

  test("control: a linked record counts as present and is rejected", async () => {
    const planted = join(outside, "scheduled_tasks.json");
    writeFileSync(planted, body);
    symlinkSync(join(outside, "missing.json"), join(metadataDirectory(), "scheduled_tasks.json"));
    await expect(readCronTasks(workspace)).rejects.toThrow(PERMISSIONS_ERROR);
    unlinkSync(join(metadataDirectory(), "scheduled_tasks.json"));
    symlinkSync(planted, join(metadataDirectory(), "scheduled_tasks.json"));
    await expect(readCronTasks(workspace)).rejects.toThrow(PERMISSIONS_ERROR);
    expect(aclMutations()).toHaveLength(0);
    expect(await readFile(planted, "utf8")).toBe(body);
  });

  test("control: a canonical .agenc with a different inode is rejected, not absent", async () => {
    const decoy = join(outside, "decoy");
    await mkdir(decoy);
    fsHooks.agencCanonical = decoy;
    await expect(readCronTasks(workspace)).rejects.toThrow(PERMISSIONS_ERROR);
    await expect(CronListTool.call({}, context)).rejects.toThrow(PERMISSIONS_ERROR);
    expect(aclMutations()).toHaveLength(0);
  });

  test("control: a symlinked (junction-like) .agenc is rejected, not absent", async () => {
    await rm(metadataDirectory(), { recursive: true });
    symlinkSync(outside, metadataDirectory());
    await expect(readCronTasks(workspace)).rejects.toThrow(PERMISSIONS_ERROR);
    expect(acl.assertWindowsPrivatePathSecurity).not.toHaveBeenCalled();
  });

  for (const replacement of ["directory", "link"] as const) {
    test(`control: .agenc replaced by a ${replacement} during the probe is rejected, not absent`, async () => {
      const directory = metadataDirectory();
      const record = join(directory, "scheduled_tasks.json");
      fsHooks.beforeLstat = async (path) => {
        if (path !== record) return;
        fsHooks.beforeLstat = undefined;
        await rename(directory, join(outside, "moved"));
        if (replacement === "directory") await mkdir(directory);
        else symlinkSync(outside, directory);
      };
      await expect(readCronTasks(workspace)).rejects.toThrow(PERMISSIONS_ERROR);
      expect(fsHooks.beforeLstat).toBeUndefined();
      expect(aclMutations()).toHaveLength(0);
    });
  }

  test("control: a workspace replaced during the probe is rejected, not absent", async () => {
    const real = realpathSync(workspace);
    const record = join(metadataDirectory(), "scheduled_tasks.json");
    fsHooks.beforeLstat = async (path) => {
      if (path !== record) return;
      fsHooks.beforeLstat = undefined;
      // The same .agenc inode moves into a new workspace directory, so only
      // the workspace identity recheck can see the change.
      await rename(real, join(outside, "moved-workspace"));
      await mkdir(real);
      await rename(join(outside, "moved-workspace", ".agenc"), join(real, ".agenc"));
    };
    await expect(readCronTasks(workspace)).rejects.toThrow(PERMISSIONS_ERROR);
    expect(fsHooks.beforeLstat).toBeUndefined();
  });

  test("control: an uncertain probe error fails closed through the full checks", async () => {
    const record = join(metadataDirectory(), "scheduled_tasks.json");
    fsHooks.beforeLstat = (path) => {
      if (path === record) throw Object.assign(new Error("access denied"), { code: "EACCES" });
    };
    await expect(readCronTasks(workspace)).rejects.toThrow(PERMISSIONS_ERROR);
    await expect(CronListTool.call({}, context)).rejects.toThrow(PERMISSIONS_ERROR);
    const error: unknown = await readStartupCronTasks(workspace, () => {}).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ message: PERMISSIONS_ERROR });
    expect(await cronRestoreFailureNeedsWarning(error, workspace)).toBe(true);
    expect(acl.assertWindowsPrivatePathSecurity).toHaveBeenCalledWith(
      expect.stringMatching(/\.agenc$/u), "directory", false,
    );
    await expectUntouched();
  });

  test("control: a valid private record still reads through the full checks", async () => {
    privatePaths.add(`directory\0${metadataDirectory()}`);
    await writeRecord();
    acl.assertWindowsPrivatePathSecurity.mockClear();
    expect((await readCronTasks(workspace)).map((entry) => entry.id)).toEqual(["kept"]);
    expect(acl.assertWindowsPrivatePathSecurity).toHaveBeenCalledWith(
      expect.stringMatching(/\.agenc$/u), "directory", false,
    );
    expect(acl.assertWindowsPrivatePathSecurity).toHaveBeenCalledWith(
      expect.stringMatching(/scheduled_tasks\.json$/u), "file", false,
    );
    expect(aclMutations()).toHaveLength(0);
  });
});
