import "../helpers/cron-os-home.js";
import { constants, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getSessionCronTasks, resetStateForTests, setProjectRoot } from "../../src/bootstrap/state.js";
import { CronDeliveryOutboxStore } from "../../src/gateway/cron-outbox.js";
import { EventLog } from "../../src/session/event-log.js";
import { startSessionCronScheduler } from "../../src/session/session-cron-scheduler.js";
import type { Session } from "../../src/session/session.js";
import { CronCreateTool } from "../../src/tools/ScheduleCronTool/CronCreateTool.js";
import { readStartupCronTasks } from "../../src/utils/cron-startup.js";
import { withCronStorage } from "../../src/utils/cron-storage.js";
import { resetCronSchedulerForTests } from "../../src/utils/cronScheduler.js";
import { appendCronTask, cronRestoreFailureNeedsWarning, readCronTasks } from "../../src/utils/cronTasks.js";

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
  identitySentinel: undefined as ((path: string) => boolean) | undefined,
}));
const privatePaths = vi.hoisted(() => new Set<string>());

vi.mock("../../src/agents/workflow-private-path.js", () => ({
  assertWindowsPrivatePathSecurity: acl.assertWindowsPrivatePathSecurity,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  // Windows reports 0 or all ones when a filesystem has no file id.
  const withoutFileId = <Info extends { dev: number | bigint; ino: number | bigint }>(info: Info): Info =>
    Object.assign(Object.create(Object.getPrototypeOf(info) as object) as Info, info,
      typeof info.dev === "bigint" ? { dev: 0n, ino: 0n } : { dev: 0, ino: 0 });
  return {
    ...original,
    lstat: async (...args: Parameters<typeof original.lstat>) => {
      const info = await original.lstat(...args);
      return fsHooks.identitySentinel?.(String(args[0])) ? withoutFileId(info) : info;
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
      if (fsHooks.identitySentinel?.(path)) {
        const stat = handle.stat.bind(handle);
        handle.stat = (async (options?: { bigint?: boolean }) =>
          withoutFileId(await stat(options as never))) as typeof handle.stat;
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
  root = await mkdtemp(join(tmpdir(), "agenc-cron-windows-"));
  workspace = join(root, "workspace");
  outside = join(root, "outside");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
});
afterEach(async () => {
  fsHooks.beforeRename = undefined;
  fsHooks.identitySentinel = undefined;
  await resetCronSchedulerForTests();
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

  test("fires a session-only job and leaves a stored durable record unarmed", async () => {
    await writeRecord();
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

  test("rejects a workspace and metadata directory that report no file id", async () => {
    fsHooks.identitySentinel = (path) => path.endsWith(`${sep}workspace`) || path.endsWith(`${sep}.agenc`);
    await expect(writeRecord()).rejects.toThrow(PERMISSIONS_ERROR);
    expect(await readdir(workspace)).not.toContain("scheduled_tasks.json");
    expect(await readdir(join(workspace, ".agenc")).catch(() => [])).not.toContain("scheduled_tasks.json");
  });

  test("rejects a publication temporary that reports no file id", async () => {
    fsHooks.identitySentinel = (path) => /scheduled_tasks\.json(?:\.[^/\\]+\.tmp)?$/u.test(path);
    await expect(writeRecord()).rejects.toThrow("Cron temporary publication file was replaced or linked");
    expect(await readdir(metadataDirectory())).not.toContain("scheduled_tasks.json");
  });
});
