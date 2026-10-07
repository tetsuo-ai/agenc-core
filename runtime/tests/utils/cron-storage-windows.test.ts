import "../helpers/cron-os-home.js";
import { linkSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readStartupCronTasks } from "../../src/utils/cron-startup.js";
import { windowsCronRepairCommand } from "../../src/utils/cron-storage-directory.js";
import { withCronStorage } from "../../src/utils/cron-storage.js";
import { cronRestoreFailureNeedsWarning, readCronTasks } from "../../src/utils/cronTasks.js";

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
  lstat: undefined as ((path: string, calls: number) => NodeJS.ErrnoException | "swap" | undefined) | undefined,
  lstatCalls: new Map<string, number>(),
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
    lstat: async (...args: Parameters<typeof original.lstat>) => {
      const path = String(args[0]);
      const calls = (fsHooks.lstatCalls.get(path) ?? 0) + 1;
      fsHooks.lstatCalls.set(path, calls);
      const hooked = fsHooks.lstat?.(path, calls);
      if (hooked === "swap") {
        const info = await original.lstat(...args) as import("node:fs").BigIntStats;
        return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { ino: info.ino + 1n });
      }
      if (hooked !== undefined) throw hooked;
      return original.lstat(...args);
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

/** What `assertWindowsPrivatePathSecurity` throws: a CLIXML reason on the PowerShell cause. */
function verifierFailure(path: string, reason = "inherited ACL is unsupported"): Error {
  return Object.assign(new Error(`Windows private-path validation failed for ${path}`), {
    name: "WindowsPrivatePathSecurityError",
    cause: { stderr: Buffer.from(`#< CLIXML <S S="Error">${reason}_x000D__x000A_</S>`) },
  });
}

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
      throw verifierFailure(path);
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
  fsHooks.lstat = undefined;
  fsHooks.lstatCalls = new Map();
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
    await expect(writeRecord()).rejects.toThrow("(inherited ACL is unsupported)");
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
    const permissions = {
      code: "CRON_STORAGE_UNSAFE_ACL",
      message: expect.stringContaining(PERMISSIONS_ERROR),
      cause: expect.objectContaining({ name: "WindowsPrivatePathSecurityError" }),
    };
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
      code: "CRON_STORAGE_UNSAFE_ACL",
      message: expect.stringContaining(PERMISSIONS_ERROR),
      cause: expect.objectContaining({ name: "WindowsPrivatePathSecurityError" }),
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
      name: "CronStorageAclError",
      code: "CRON_STORAGE_UNSAFE_ACL",
      message: expect.stringContaining("child does not have the required private ACL"),
      cause: expect.objectContaining({ name: "ConfinedIoError" }),
    });
    await expect(readCronTasks(workspace)).rejects.toThrow(
      `(inherited ACL is unsupported). The task file was left unchanged. To make ${directory} and everything in it private`,
    );
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
  test("names the rejected directory and the PowerShell repair in the top-level message", async () => {
    const directory = metadataDirectory();
    await mkdir(directory, { mode: 0o700 });
    const record = join(directory, "scheduled_tasks.json");
    writeFileSync(record, body);
    const error = await readCronTasks(workspace).catch((caught: unknown) => caught) as Error;
    expect(error.message).toBe(
      `${PERMISSIONS_ERROR}: ${directory} has a Windows ACL that is not private to the current user ` +
      "(inherited ACL is unsupported), and it was left unchanged. " +
      `To make ${directory} and everything in it private to the current user (junctions, symbolic links and ` +
      "hard-linked files inside it are skipped, its parent is not changed, and the script stops at the first " +
      `error), run this in PowerShell, then retry: ${windowsCronRepairCommand(directory)}`,
    );
    expect(aclMutations()).toHaveLength(0);
    expect(await readFile(record, "utf8")).toBe(body);
  });

  test("quotes the repair path as one PowerShell literal", () => {
    const directory = "C:\\Users\\Ty L\\it's $x & y (1) ;`b %PATH% [z] ^ \u00e9 \u2019q\u2018\u201a\u201b\\.agenc";
    const literal = "'C:\\Users\\Ty L\\it''s $x & y (1) ;`b %PATH% [z] ^ \u00e9 \u2019\u2019q\u2018\u2018\u201a\u201a\u201b\u201b\\.agenc'";
    const command = windowsCronRepairCommand(directory);
    expect(command).toContain(`; $root = ${literal}; `);
    // The path appears once, as that literal; everything else refers to $root.
    expect(command.split("Users").length - 1).toBe(1);
  });

  test("repairs with one stop-on-error script that never follows links", () => {
    const command = windowsCronRepairCommand("C:\\p\\.agenc");
    // One script block that stops at the first error; no native tool whose exit code could be missed.
    expect(command.startsWith("& { $ErrorActionPreference = 'Stop'; ")).toBe(true);
    expect(command.endsWith(" }")).toBe(true);
    expect(command).not.toMatch(/icacls|takeown|cacls|\/T\b/iu);
    // No API that rewrites the inherited entries of existing children (SetNamedSecurityInfo).
    expect(command).not.toMatch(/Set-Acl|SetAccessControl\(/u);
    expect(command).toContain("[AgencCronRepair.Native]::SetFileSecurityW($path, 0x80000005, $acl.GetSecurityDescriptorBinaryForm())");
    expect(command).toContain("throw (New-Object ComponentModel.Win32Exception(");
    // .agenc itself must be a real directory.
    const refuseRoot = command.indexOf("if (($a -band $link) -ne 0 -or ($a -band $folder) -eq 0) { throw ");
    const lockRoot = command.indexOf("& $private $root $true");
    expect(refuseRoot).toBeGreaterThan(0);
    expect(lockRoot).toBeGreaterThan(refuseRoot);
    expect(command.indexOf("$todo.Push($root)")).toBeGreaterThan(lockRoot);
    // Explicit stack: a reparse point is skipped before any write or descent;
    // a directory is made private before it is pushed and listed.
    const loop = command.slice(command.indexOf("while ($todo.Count -gt 0)"));
    const skipLink = loop.indexOf("if (($a -band $link) -ne 0) { Write-Warning");
    expect(skipLink).toBeGreaterThan(0);
    expect(loop.indexOf("& $private $path $true; $todo.Push($path)")).toBeGreaterThan(skipLink);
    expect(loop.indexOf("LinkType -eq 'HardLink') { Write-Warning")).toBeGreaterThan(skipLink);
    expect(loop.indexOf("else { & $private $path $false }")).toBeGreaterThan(loop.indexOf("'HardLink'"));
    expect(command).not.toMatch(/-Recurse|GetDirectories|EnumerateFileSystemEntries\([^)]*AllDirectories/u);
    // The descriptor workflow-private-path.ts writes.
    expect(command).toContain("$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false)");
    expect(command).toContain("$inherit = 'ContainerInherit, ObjectInherit'");
    expect(command).toContain("$inherit = 'None'");
    expect(command).toContain("FileSystemAccessRule($sid, 'FullControl', $inherit, 'None', 'Allow')");
  });

  test("documents the same repair script the error prints", async () => {
    const docs = await readFile(resolve(__dirname, "../../../docs/durable-cron-storage.md"), "utf8");
    const block = docs.match(/```powershell\n([^\n]+)\n```/u)?.[1];
    expect(block).toBe(windowsCronRepairCommand("C:\\src\\my project\\.agenc"));
  });

  test("offers no ACL repair for a linked or non-regular task file", async () => {
    const directory = metadataDirectory();
    await mkdir(directory, { mode: 0o700 });
    privatePaths.add(`directory\0${directory}`);
    const record = join(directory, "scheduled_tasks.json");
    const planted = join(outside, "planted.json");
    writeFileSync(planted, body);
    for (const plant of [() => symlinkSync(planted, record), () => linkSync(planted, record)]) {
      plant();
      const error = await readCronTasks(workspace).catch((caught: unknown) => caught) as Error;
      expect(error).toMatchObject({ code: "CRON_STORAGE_UNSAFE_ACL" });
      expect(error.message).toBe(
        `${PERMISSIONS_ERROR}: ${record} is a symbolic link, a junction, a hard-linked file or not a regular ` +
        "entry, and it was left unchanged. Remove it, or replace it with a regular file or directory, then retry.",
      );
      expect(error.message).not.toContain("PowerShell");
      expect(await readFile(planted, "utf8")).toBe(body);
      unlinkSync(record);
    }
    expect(aclMutations()).toHaveLength(0);
  });

  test("offers no ACL repair when the verifier fails for a reason it does not name", async () => {
    acl.assertWindowsPrivatePathSecurity.mockImplementation(() => {
      throw Object.assign(new Error("Windows private-path validation failed"), {
        name: "WindowsPrivatePathSecurityError",
        cause: Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" }),
      });
    });
    const directory = metadataDirectory();
    await mkdir(directory, { mode: 0o700 });
    const error = await readCronTasks(workspace).catch((caught: unknown) => caught) as Error;
    expect(error.message).toBe(
      `${PERMISSIONS_ERROR}: ${directory} could not be verified as private to the current user ` +
      "(Windows private-path validation failed), and it was left unchanged.",
    );
  });

  test("names the task file and the repair when it cannot be inspected after the directory verified", async () => {
    const directory = metadataDirectory();
    await mkdir(directory, { mode: 0o700 });
    privatePaths.add(`directory\0${directory}`);
    const record = join(directory, "scheduled_tasks.json");
    writeFileSync(record, body);
    for (const code of ["EACCES", "EPERM"]) {
      fsHooks.lstat = (path) => path === record
        ? Object.assign(new Error(`${code}: operation not permitted, lstat '${path}'`), { code, path })
        : undefined;
      const error = await readCronTasks(workspace).catch((caught: unknown) => caught) as Error;
      expect(error).toMatchObject({ name: "CronStorageAclError", code: "CRON_STORAGE_UNSAFE_ACL", cause: { code } });
      expect(error.message).toContain(`${PERMISSIONS_ERROR}: ${record} could not be inspected (${code}), and it was left unchanged.`);
      expect(error.message).toContain(`run this in PowerShell (elevated if access is denied), then retry: ${windowsCronRepairCommand(directory)}`);
    }
    expect(aclMutations()).toHaveLength(0);
    expect(await readFile(record, "utf8")).toBe(body);
  });

  test("names the repair when a created metadata directory cannot be made private", async () => {
    acl.assertWindowsPrivatePathSecurity.mockImplementation((path: string) => {
      throw verifierFailure(path, "current-user full-control ACE is missing");
    });
    const directory = metadataDirectory();
    const error = await writeRecord().catch((caught: unknown) => caught) as Error;
    expect(error).toMatchObject({ code: "CRON_STORAGE_UNSAFE_ACL" });
    expect(error.message).toContain(
      `${PERMISSIONS_ERROR}: ${directory} was created, but it could not be made private to the current user ` +
      "(current-user full-control ACE is missing). Remove that directory, or repair it, then retry. " +
      `To make ${directory} and everything in it private`,
    );
    expect(error.message).not.toContain("empty");
    expect(await readdir(directory)).toEqual([]);
    expect(aclMutations()).toHaveLength(1);
    // The next call sees an existing directory: it validates only and still names the repair.
    await expect(writeRecord()).rejects.toThrow(`run this in PowerShell, then retry: ${windowsCronRepairCommand(directory)}`);
    expect(aclMutations()).toHaveLength(1);
  });

  test("rechecks the metadata directory identity immediately before initializing it", async () => {
    const directory = metadataDirectory();
    fsHooks.lstat = (path, calls) => path === directory && calls === 3 ? "swap" : undefined;
    await expect(writeRecord()).rejects.toThrow(PERMISSIONS_ERROR);
    expect(aclMutations()).toHaveLength(0);
  });

  test("does not offer an ACL repair for an unsupported volume", async () => {
    acl.assertWindowsPrivatePathSecurity.mockImplementation(() => {
      throw Object.assign(new Error("Windows private-path validation failed"), {
        cause: { stderr: Buffer.from('<S S="Error">NTFS is required_x000D__x000A_</S>') },
      });
    });
    const directory = metadataDirectory();
    await mkdir(directory, { mode: 0o700 });
    const error = await readCronTasks(workspace).catch((caught: unknown) => caught) as Error;
    expect(error.message).toContain(`${directory} is on a volume that Windows durable cron storage does not support (NTFS is required)`);
    expect(error.message).not.toContain("PowerShell");
  });

  test("startup restore stays quiet only when the task file is proven absent", async () => {
    const directory = metadataDirectory();
    await mkdir(directory, { mode: 0o700 });
    const absent = await readCronTasks(workspace).catch((caught: unknown) => caught);
    expect(absent).toMatchObject({ code: "CRON_STORAGE_UNSAFE_ACL" });
    await expect(readStartupCronTasks(workspace, () => {})).rejects.toMatchObject({ code: "CRON_STORAGE_UNSAFE_ACL" });
    expect(await cronRestoreFailureNeedsWarning(absent, workspace)).toBe(false);
  });

  test("startup restore warns with the path and repair when an unsafe directory holds a task file", async () => {
    const directory = metadataDirectory();
    await mkdir(directory, { mode: 0o700 });
    writeFileSync(join(directory, "scheduled_tasks.json"), body);
    const present = await readStartupCronTasks(workspace, () => {}).catch((caught: unknown) => caught) as Error;
    expect(await cronRestoreFailureNeedsWarning(present, workspace)).toBe(true);
    expect(present.message).toContain(directory);
    expect(present.message).toContain(windowsCronRepairCommand(directory));
    expect(await readFile(join(directory, "scheduled_tasks.json"), "utf8")).toBe(body);
  });

  test("startup restore warns with the path and repair when the task file cannot be checked", async () => {
    const directory = metadataDirectory();
    await mkdir(directory, { mode: 0o700 });
    const denied = (path: string) => Object.assign(new Error(`EACCES: permission denied, lstat '${path}'`), {
      code: "EACCES", path,
    });
    fsHooks.lstat = (path) => path.endsWith(`${sep}scheduled_tasks.json`) ? denied(path) : undefined;
    const unknown = await readCronTasks(workspace).catch((caught: unknown) => caught) as Error;
    expect(await cronRestoreFailureNeedsWarning(unknown, workspace)).toBe(true);
    expect(unknown.message).toContain(windowsCronRepairCommand(directory));

    fsHooks.lstat = (path) => path === directory || path.endsWith(`${sep}scheduled_tasks.json`)
      ? Object.assign(denied(path), { code: "EPERM" }) : undefined;
    const inaccessible = await readCronTasks(workspace).catch((caught: unknown) => caught) as Error;
    expect(inaccessible).toMatchObject({ code: "CRON_STORAGE_UNSAFE_ACL" });
    expect(inaccessible.message).toContain(`${directory} could not be inspected (EPERM)`);
    expect(inaccessible.message).toContain(windowsCronRepairCommand(directory));
    expect(await cronRestoreFailureNeedsWarning(inaccessible, workspace)).toBe(true);
    expect(aclMutations()).toHaveLength(0);
  });
});
