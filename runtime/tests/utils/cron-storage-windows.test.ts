import "../helpers/cron-os-home.js";
import { readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readStartupCronTasks } from "../../src/utils/cron-startup.js";
import { withCronStorage } from "../../src/utils/cron-storage.js";
import { readCronTasks } from "../../src/utils/cronTasks.js";

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
}));
const privatePaths = vi.hoisted(() => new Set<string>());

vi.mock("../../src/agents/workflow-private-path.js", () => ({
  assertWindowsPrivatePathSecurity: acl.assertWindowsPrivatePathSecurity,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
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
      if (
        fsHooks.directorySyncError !== undefined &&
        args[1] === "r" &&
        path.endsWith(`${sep}.agenc`)
      ) {
        throw fsHooks.directorySyncError;
      }
      return original.open(...args);
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
  root = await mkdtemp(join(tmpdir(), "agenc-cron-windows-"));
  workspace = join(root, "workspace");
  outside = join(root, "outside");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
});
afterEach(async () => {
  fsHooks.beforeRename = undefined;
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("POSIX cron storage keeps descriptor confinement", () => {
  test.skipIf(process.platform !== "linux")("persists through descriptor handles without the Windows ACL", async () => {
    await writeRecord();
    expect(await withCronStorage(workspace, false, (storage) => storage.read())).toBe(body);
    expect(acl.assertWindowsPrivatePathSecurity).not.toHaveBeenCalled();
    expect((await readCronTasks(workspace)).map((entry) => entry.id)).toEqual(["kept"]);
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

  test("restores a record when directory descriptors are unavailable", async () => {
    fsHooks.descriptorUnavailable = true;
    fsHooks.realpaths = [];
    fsHooks.opens = [];
    await writeRecord();
    expect(usedDescriptorAlias()).toBe(false);
    expect(await withCronStorage(workspace, false, (storage) => storage.read())).toBe(body);
    expect((await readCronTasks(workspace)).map((entry) => entry.id)).toEqual(["kept"]);
    expect((await readStartupCronTasks(workspace, () => {})).map((entry) => entry.id)).toEqual(["kept"]);
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
});
