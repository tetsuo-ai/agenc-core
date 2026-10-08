import "../helpers/cron-os-home.js";
import { linkSync, lstatSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readStartupCronTasks } from "../../src/utils/cron-startup.js";
import { windowsCronRepairCommand } from "../../src/utils/cron-storage-directory.js";
import { simulateWindowsPublication } from "../helpers/windows-publication-simulation.js";
import { withCronStorage } from "../../src/utils/cron-storage.js";
import { cronRestoreFailureNeedsWarning, readCronTasks } from "../../src/utils/cronTasks.js";

const acl = vi.hoisted(() => ({
  assertWindowsPrivatePathSecurity: vi.fn(),
  runWindowsSecurityScript: vi.fn(),
  beforeHandleInit: undefined as ((path: string) => void) | undefined,
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
  runWindowsSecurityScript: acl.runWindowsSecurityScript,
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

/** The repair advice every ACL-repair message ends with. */
function repairAdvice(directory: string, extra = ""): string {
  return `To make ${directory} itself and its scheduled_tasks.json private to the current user, ` +
    `run this in PowerShell${extra}, then retry. This replaces the ACL of that directory and task file with one ` +
    "full-control entry for the current user, so every other account loses access to them: SYSTEM, Administrators, " +
    "Users, Authenticated Users, Everyone, sandbox or AppContainer groups such as CodexSandboxUsers, and any other " +
    "explicit entries (for example, backup or antivirus software running as SYSTEM can no longer list the directory " +
    "or read the task file). Other entries in the directory keep their current ACLs, links are refused, nothing " +
    `outside it is changed, and the script stops at the first error. Command: ${windowsCronRepairCommand(directory)}`;
}

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
  acl.beforeHandleInit = undefined;
  acl.runWindowsSecurityScript.mockReset();
  // Directory initialization marks `.agenc` private. Publication runs the
  // handle-bound script's Linux stand-in so the task file lands in that directory.
  acl.runWindowsSecurityScript.mockImplementation((
    path: string,
    encoded?: string,
    variables?: Record<string, string>,
    _temporary?: string,
    input?: Buffer,
  ) => {
    if (variables?.AGENC_CRON_PUBLISH_DIRECTORY !== undefined) {
      simulateWindowsPublication({
        directory: variables.AGENC_CRON_PUBLISH_DIRECTORY,
        volume: variables.AGENC_CRON_VOLUME ?? "",
        fileId: variables.AGENC_CRON_FILE_ID ?? "",
        name: variables.AGENC_CRON_NAME ?? "",
        temporary: variables.AGENC_CRON_TEMPORARY ?? "",
        bytes: Buffer.isBuffer(input) ? input : Buffer.alloc(0),
        script: Buffer.from(String(variables.AGENC_CRON_PUBLISH_BODY ?? encoded ?? ""), "base64").toString(
          variables.AGENC_CRON_PUBLISH_BODY === undefined ? "utf16le" : "utf8",
        ),
        onStage: (stage, info) => {
          if (stage === "before-rename") fsHooks.beforeRename?.(info.temporaryPath, info.destinationPath);
        },
      });
      privatePaths.add(`file\0${join(variables.AGENC_CRON_PUBLISH_DIRECTORY, variables.AGENC_CRON_NAME ?? "")}`);
      return;
    }
    acl.beforeHandleInit?.(path);
    privatePaths.add(`directory\0${path}`);
  });
}

/** Every ACL write: path-based initialization and the handle-based `.agenc` initialization. */
function directoryInitCalls(): ReadonlyArray<readonly unknown[]> {
  return acl.runWindowsSecurityScript.mock.calls.filter((call) => {
    const variables = call[2] as { AGENC_CRON_DIRECTORY?: string; AGENC_CRON_PUBLISH_DIRECTORY?: string } | undefined;
    return variables?.AGENC_CRON_DIRECTORY !== undefined && variables.AGENC_CRON_PUBLISH_DIRECTORY === undefined;
  });
}

function publicationCalls(): ReadonlyArray<readonly unknown[]> {
  return acl.runWindowsSecurityScript.mock.calls.filter((call) => {
    const variables = call[2] as { AGENC_CRON_PUBLISH_DIRECTORY?: string } | undefined;
    return variables?.AGENC_CRON_PUBLISH_DIRECTORY !== undefined;
  });
}

function aclMutations(): ReadonlyArray<readonly unknown[]> {
  return [
    ...acl.assertWindowsPrivatePathSecurity.mock.calls.filter((call) => call[2] === true),
    ...directoryInitCalls().map(([path]) => [path, "directory", "handle"]),
  ];
}

/** Path-based initializations of `.agenc` (SetAccessControl, which propagates to children). */
function pathBasedDirectoryInits(): ReadonlyArray<readonly unknown[]> {
  return acl.assertWindowsPrivatePathSecurity.mock.calls.filter(
    ([path, role, initialize]) => role === "directory" && initialize === true && String(path).endsWith(".agenc"),
  );
}

/** The script `runWindowsSecurityScript` ran, decoded. */
function decodedScript(call: readonly unknown[] | undefined): string {
  return Buffer.from(String(call?.[1] ?? ""), "base64").toString("utf16le");
}

function decodedInitScript(): string {
  return decodedScript(directoryInitCalls()[0]);
}

/** The C# source a script loads with Add-Type. */
function addTypeSource(script: string): string {
  const start = script.indexOf("Add-Type -TypeDefinition '") + "Add-Type -TypeDefinition '".length;
  return script.slice(start, script.indexOf("'", start));
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
    expect(acl.runWindowsSecurityScript).toHaveBeenCalledWith(
      expect.stringMatching(/\.agenc$/u), expect.any(String), expect.any(Object), tmpdir(),
    );
    expect(pathBasedDirectoryInits()).toHaveLength(0);
    expect(acl.assertWindowsPrivatePathSecurity.mock.calls.filter((call) => call[2] === true)).toEqual([]);
    expect(publicationCalls()).toHaveLength(1);
    const publication = publicationCalls()[0]!;
    expect(publication[4]).toEqual(Buffer.from(body, "utf8"));
    expect(publication[2]).toMatchObject({
      AGENC_CRON_PUBLISH_FAULT: "",
      AGENC_CRON_PUBLISH_HOOK: "",
      AGENC_CRON_NAME: "scheduled_tasks.json",
    });
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
    const linked = join(workspace, ".agenc");
    const message = `${PERMISSIONS_ERROR}: ${linked} is a symbolic link, a junction or not a directory, and it was ` +
      "left unchanged. Remove it, or replace it with a regular directory, then retry.";
    // No ACL repair is offered for a linked .agenc, on write or read.
    await expect(writeRecord()).rejects.toMatchObject({ code: "CRON_STORAGE_UNSAFE_ACL", message });
    await expect(readCronTasks(workspace)).rejects.toMatchObject({ code: "CRON_STORAGE_UNSAFE_ACL", message });
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
    expect(directoryInitCalls()).toHaveLength(1);
    expect(publicationCalls()).toHaveLength(1);
    const directoryCalls = acl.assertWindowsPrivatePathSecurity.mock.calls.filter(
      ([path, role]) => role === "directory" && String(path).endsWith(`${sep}.agenc`),
    );
    // After the handle-based initialization, the path is only verified.
    expect(directoryCalls.length).toBeGreaterThan(0);
    expect(directoryCalls.every((call) => call[2] === false)).toBe(true);

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
      `(inherited ACL is unsupported). The task file was left unchanged. ${repairAdvice(directory)}`,
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
    expect(acl.assertWindowsPrivatePathSecurity.mock.calls.filter((call) => call[2] === true)).toEqual([]);
    expect(publicationCalls()).toHaveLength(1);
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
      `(inherited ACL is unsupported), and it was left unchanged. ${repairAdvice(directory)}`,
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

  test("repairs only .agenc and its task file, through handles, stopping at the first error", () => {
    const command = windowsCronRepairCommand("C:\\p\\.agenc");
    // One script block that stops at the first error; no native tool whose exit code could be missed.
    expect(command.startsWith("& { $ErrorActionPreference = 'Stop'; ")).toBe(true);
    expect(command.endsWith(" }")).toBe(true);
    expect(command).not.toMatch(/icacls|takeown|cacls|\/T\b/iu);
    // No tree walk and no API that propagates to existing children (SetNamedSecurityInfo).
    expect(command).not.toMatch(/Set-Acl|SetAccessControl|SetFileSecurity|SetNamedSecurityInfo|SetSecurityInfo/u);
    expect(command).not.toMatch(/GetFileSystemEntries|GetDirectories|EnumerateFile|Get-ChildItem|-Recurse|while \(/u);
    // Exactly two writes, both through an open handle.
    expect(command.match(/\[AgencCronRepair\]::Protect\(/gu)).toHaveLength(2);
    expect(command).toContain("SetKernelObjectSecurity(handle, 0x80000005, descriptor)");
    // .agenc is opened without following a link, and its type comes from that handle.
    expect(command).toContain("CreateFileW(path, access, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)");
    expect(command).toContain("public static SafeFileHandle OpenFolder(string path) { return Open(path, 0x1E00A0); }");
    const open = command.indexOf("$dir = [AgencCronRepair]::OpenFolder($root)");
    const describe = command.indexOf("$id = [AgencCronRepair]::Describe($dir, $root)");
    const refuse = command.indexOf("if (($id.Attributes -band $link) -ne 0 -or ($id.Attributes -band $folder) -eq 0) { throw ");
    expect(open).toBeGreaterThan(0);
    expect(describe).toBeGreaterThan(open);
    expect(refuse).toBeGreaterThan(describe);
    // The task file is opened relative to that handle and must be a regular,
    // non-reparse file with one link before EITHER write, so a refused or
    // unopenable task file leaves .agenc unchanged.
    expect(command).toContain("target.Root = folder.DangerousGetHandle()");
    const openFile = command.indexOf("$file = [AgencCronRepair]::OpenChild($dir, 'scheduled_tasks.json', $task)");
    const refuseFile = command.indexOf("if (($info.Attributes -band ($link -bor $folder)) -ne 0 -or $info.Links -ne 1) { throw ");
    const protectDir = command.indexOf("[AgencCronRepair]::Protect($dir, (& $descriptor $true), $root)");
    const protectFile = command.indexOf("[AgencCronRepair]::Protect($file, (& $descriptor $false), $task)");
    expect(openFile).toBeGreaterThan(refuse);
    expect(refuseFile).toBeGreaterThan(openFile);
    expect(protectDir).toBeGreaterThan(refuseFile);
    expect(protectFile).toBeGreaterThan(protectDir);
    expect(command).toContain("is a link, a hard-linked file or not a regular file, and nothing was changed.");
    // The task file handle requests no data access (READ_CONTROL | WRITE_DAC |
    // WRITE_OWNER | SYNCHRONIZE | FILE_READ_ATTRIBUTES), so share mode 0 would
    // lock nothing; a name added before the write is caught by the link count
    // read again after it.
    expect(command).toContain(
      "public static SafeFileHandle OpenChild(SafeFileHandle folder, string name, string path) { return OpenChild(folder, name, path, 0x1E0080); }",
    );
    expect(command).toContain("NtCreateFile(out handle, access, ref target, out result, IntPtr.Zero, 0, 7, 1, 0x200020, IntPtr.Zero, 0)");
    const recount = command.indexOf("if ($written.Links -ne 1) { throw ");
    expect(recount).toBeGreaterThan(protectFile);
    expect(command).toContain("$root and that file are already private; remove the other name, then run this again.");
    // .agenc must still be the same object at the end.
    const recheck = command.indexOf("$again = [AgencCronRepair]::OpenFolder($root)");
    expect(recheck).toBeGreaterThan(recount);
    expect(command).toContain("if ($now.Volume -ne $id.Volume -or $now.IndexHigh -ne $id.IndexHigh -or $now.IndexLow -ne $id.IndexLow) { throw ");
    expect(command.indexOf("\"Repaired $root")).toBeGreaterThan(recheck);
    // Failures throw, with the Windows reason.
    expect(command).toContain("throw Fail(Marshal.GetLastWin32Error(), path)");
    // The descriptor workflow-private-path.ts writes.
    expect(command).toContain("$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false)");
    expect(command).toContain("$inherit = 'ContainerInherit, ObjectInherit'");
    expect(command).toContain("$inherit = 'None'");
    expect(command).toContain("FileSystemAccessRule($sid, 'FullControl', $inherit, 'None', 'Allow')");
    // The C# source sits in one single-quoted PowerShell literal.
    expect(addTypeSource(command)).not.toContain("'");
    expect(command.indexOf("'; $descriptor = { param($isFolder)")).toBeGreaterThan(0);
  });

  test("checks the volume first, then catches a task file renamed and replaced during the repair", () => {
    const command = windowsCronRepairCommand("C:\\p\\.agenc");
    const protectDir = command.indexOf("[AgencCronRepair]::Protect($dir, (& $descriptor $true), $root)");
    const protectFile = command.indexOf("[AgencCronRepair]::Protect($file, (& $descriptor $false), $task)");
    // Without Full Language Mode the script stops before Add-Type, and says why.
    const guard = command.indexOf("if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw \"Not repaired: ");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(command.indexOf("Add-Type -TypeDefinition"));
    expect(command).toContain("mode and the repair needs Add-Type (Full Language Mode). Nothing was changed.");
    // A session that ran this before keeps the static prefix: reset it after Add-Type.
    expect(command.indexOf("[AgencCronRepair]::Prefix = 'Not repaired: '")).toBeGreaterThan(command.indexOf("Add-Type -TypeDefinition"));
    // NTFS is read from the directory handle before the task file is opened and before either write.
    const system = command.indexOf("$system = [AgencCronRepair]::FileSystem($dir, $root)");
    const refuseSystem = command.indexOf("if ($system -ne 'NTFS') { throw \"Not repaired: $root is on $system, not NTFS. Nothing was changed.\" }");
    expect(system).toBeGreaterThan(command.indexOf("$id = [AgencCronRepair]::Describe($dir, $root)"));
    expect(refuseSystem).toBeGreaterThan(system);
    expect(refuseSystem).toBeLessThan(command.indexOf("$file = [AgencCronRepair]::OpenChild("));
    // After the file's write: same link count, then the NAME is opened again relative to the
    // directory handle (attributes only, share 7) and must be the written file with one link.
    const written = command.indexOf("$written = [AgencCronRepair]::Describe($file, $task)");
    const reopen = command.indexOf("$same = [AgencCronRepair]::OpenChild($dir, 'scheduled_tasks.json', $task, 0x100080)");
    const missing = command.indexOf("throw \"Stopped: scheduled_tasks.json disappeared during the repair.");
    const compare = command.indexOf("throw \"Stopped: scheduled_tasks.json was replaced during the repair.");
    const linked = command.indexOf(
      "if ($seen.Links -ne 1) { throw \"Stopped: another name for $task was added during the repair. $root and that file are already private;",
    );
    expect(written).toBeGreaterThan(protectFile);
    expect(reopen).toBeGreaterThan(written);
    expect(command).toContain("if ($same) { try { $seen = [AgencCronRepair]::Describe($same, $task) } finally { $same.Dispose() } }");
    expect(missing).toBeGreaterThan(reopen);
    expect(compare).toBeGreaterThan(missing);
    expect(linked).toBeGreaterThan(compare);
    expect(command.slice(linked, command.indexOf("}", linked))).not.toMatch(/was not changed|left unchanged/u);
    expect(command).toContain("$root and the original task file are private now; the file now at $task was not changed.");
    expect(command).toContain("nothing is at that name.");
    // No task file at the start: one that appears during the repair also stops it.
    expect(command).toContain(
      "else { $late = [AgencCronRepair]::OpenChild($dir, 'scheduled_tasks.json', $task, 0x100080); " +
      "if ($late) { $late.Dispose(); throw \"Stopped: scheduled_tasks.json appeared during the repair. ",
    );
    expect(command.indexOf("$again = [AgencCronRepair]::OpenFolder($root)")).toBeGreaterThan(linked);
    expect(command.indexOf("\"Repaired $root")).toBeGreaterThan(compare);
    // Every message after the first write says "Stopped" and what is already private; "Not repaired" means unchanged.
    expect(command.indexOf("[AgencCronRepair]::Prefix = \"Stopped ($root is already private): \"")).toBeGreaterThan(protectDir);
    expect(command.indexOf("[AgencCronRepair]::Prefix = \"Stopped ($root is already private): \"")).toBeLessThan(protectFile);
    const throws = [...command.matchAll(/throw "([A-Z][a-z]+)/gu)];
    expect(throws.length).toBeGreaterThan(6);
    for (const match of throws) {
      expect([match.index! < protectDir ? "before" : "after", match[1]]).toEqual(
        [match.index! < protectDir ? "before" : "after", match.index! < protectDir ? "Not" : "Stopped"],
      );
    }
    expect(command).toContain("throw \"Stopped: $root was replaced during the repair. The directory opened there is private now; ");
    expect(command).not.toContain("Not repaired: $root was replaced during the repair");
  });

  test("names Add-Type and Constrained Language Mode when a created .agenc cannot load the helper", async () => {
    const directory = metadataDirectory();
    const echo = (detail: string) => `throw "Add-Type is unavailable ($($ExecutionContext.SessionState.LanguageMode))"_x000D__x000A_</S>` +
      `<S S="Error">Add-Type is unavailable (${detail})`;
    const tail = "Constrained Language Mode, and AppLocker or WDAC (Windows Defender Application Control) policies, block it. " +
      "No ACL was written, and the directory was left unchanged. Allow Add-Type for this account, or remove that directory " +
      "and schedule the task with durable:false.";
    for (const [reason, why] of [
      [echo("ConstrainedLanguage"), " (PowerShell runs in ConstrainedLanguage mode)"],
      ["Add-Type is unavailable (FileLoadException)", " (Add-Type failed with FileLoadException)"],
      [`throw "Add-Type is unavailable ($($_.Exception.GetType().Name))"`, ""],
    ]) {
      acl.runWindowsSecurityScript.mockImplementation((path: string) => {
        throw verifierFailure(path, reason);
      });
      const error = await writeRecord().catch((caught: unknown) => caught) as Error;
      expect(error).toMatchObject({ code: "CRON_STORAGE_UNSAFE_ACL" });
      expect(error.message).toBe(
        `Durable cron storage on Windows could not make ${directory} private: that step loads a small C# helper ` +
        `with PowerShell Add-Type, and Add-Type is not available here${why}. ${tail}`,
      );
      expect(error.message).not.toMatch(/Command:|repair it/u);
      expect(await readdir(directory)).toEqual([]);
      expect(pathBasedDirectoryInits()).toHaveLength(0);
      await rm(directory, { recursive: true });
    }
  });

  test("checks the language mode and Add-Type before any handle, with no path-based fallback", async () => {
    await writeRecord();
    const script = decodedInitScript();
    const mode = script.indexOf(
      "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') " +
      "{ throw \"Add-Type is unavailable ($($ExecutionContext.SessionState.LanguageMode))\" }",
    );
    const load = script.indexOf("try { Add-Type -TypeDefinition '");
    expect(mode).toBeGreaterThan(0);
    expect(load).toBeGreaterThan(mode);
    expect(script).toContain("' } catch { throw \"Add-Type is unavailable ($($_.Exception.GetType().Name))\" }");
    expect(script.indexOf("$probe = [AgencCronRepair]::Probe($target)")).toBeGreaterThan(load);
    expect(script).not.toMatch(/SetAccessControl|Set-Acl|icacls/u);
  });

  test("leaves an unsafe task file in place on update, and the docs say the repair keeps its bytes", async () => {
    const directory = metadataDirectory();
    await mkdir(directory, { mode: 0o700 });
    privatePaths.add(`directory\0${directory}`);
    const record = join(directory, "scheduled_tasks.json");
    writeFileSync(record, body);
    // A regular, single-link task file that is not private. Every task update
    // (mutateCronFile, the only storage.write caller) reads first, under the
    // cron lock, which this Linux run cannot take; the same read-then-write
    // sequence stops at the read and never reaches the atomic replacement.
    let wrote = false;
    const error = await withCronStorage(workspace, true, async (storage) => {
      await storage.read();
      wrote = true;
      await storage.write(body.replace("survive restart", "rewritten"));
    }).catch((caught: unknown) => caught) as Error;
    expect(wrote).toBe(false);
    expect(error).toMatchObject({ code: "CRON_STORAGE_UNSAFE_ACL" });
    expect(error.message).toContain("The task file was left unchanged.");
    expect(await readFile(record, "utf8")).toBe(body);
    expect(aclMutations()).toHaveLength(0);
    const docs = await readFile(resolve(__dirname, "../../../docs/durable-cron-storage.md"), "utf8");
    expect(docs).not.toContain("an unsafe task file is replaced atomically");
    expect(docs).toContain("rejected on read and on update and left\nunchanged; durable cron does not rewrite it.");
    expect(docs).toContain("**Task contents are kept.** The repair changes ACLs only. It keeps the bytes");
    expect(docs).toContain("inspect it, or delete it, before you run the repair.");
    expect(docs).toContain("Loading that helper needs PowerShell Full Language Mode.");
  });

  test("makes a created .agenc private through a handle bound to its lstat, never by path", async () => {
    const directory = metadataDirectory();
    let created: import("node:fs").Stats | undefined;
    acl.beforeHandleInit = (path) => {
      created = lstatSync(path);
    };
    await writeRecord();
    expect(directoryInitCalls()).toHaveLength(1);
    expect(publicationCalls()).toHaveLength(1);
    const [path, , variables, temporary] = directoryInitCalls()[0]!;
    expect(path).toBe(directory);
    const identity = lstatSync(directory, { bigint: true });
    expect(variables).toEqual({
      AGENC_CRON_DIRECTORY: directory,
      AGENC_CRON_VOLUME: identity.dev.toString(),
      AGENC_CRON_FILE_ID: identity.ino.toString(),
    });
    expect(created?.isDirectory()).toBe(true);
    // Windows PowerShell 5.1 Add-Type compiles in TEMP; System32 is not writable.
    expect(temporary).toBe(tmpdir());
    // No path-based ACL write of .agenc (SetAccessControl re-resolves the path and propagates).
    expect(pathBasedDirectoryInits()).toHaveLength(0);

    const script = decodedInitScript();
    expect(script).not.toMatch(/SetAccessControl|Set-Acl|SetNamedSecurityInfo|SetSecurityInfo|SetFileSecurity|icacls/u);
    // One implementation: the same C# helper as the repair command.
    expect(addTypeSource(script)).toBe(addTypeSource(windowsCronRepairCommand(directory)));
    expect(script).toContain("$target = $env:AGENC_CRON_DIRECTORY");
    // Type, reparse state, file system and identity come from the handle; a
    // mismatch with the lstat fails closed before the write, which goes
    // through the same handle.
    const probe = script.indexOf("$probe = [AgencCronRepair]::Probe($target)");
    const probeCheck = script.indexOf("try { & $check $probe }");
    const write = script.indexOf("$dir = [AgencCronRepair]::OpenFolder($target)");
    const writeCheck = script.indexOf("try { & $check $dir; [AgencCronRepair]::Protect($dir, (& $descriptor $true), $target) }");
    expect(probe).toBeGreaterThan(0);
    expect(probeCheck).toBeGreaterThan(probe);
    expect(write).toBeGreaterThan(probeCheck);
    expect(writeCheck).toBeGreaterThan(write);
    expect(script.match(/::Protect\(/gu)).toHaveLength(1);
    expect(script).toContain("if (($info.Attributes -band 0x400) -ne 0) { throw 'reparse points are unsupported' }");
    expect(script).toContain("if (($info.Attributes -band 0x10) -eq 0) { throw 'path role does not match its type' }");
    expect(script).toContain("$system = [AgencCronRepair]::FileSystem($handle, $target)");
    expect(script).toContain("if ($system -ne 'NTFS') { throw \"NTFS is required ($system)\" }");
    expect(script).toContain(
      "if ([string]$info.Volume -ne $env:AGENC_CRON_VOLUME -or [string]$info.Index -ne $env:AGENC_CRON_FILE_ID) " +
      "{ throw 'directory identity changed before its ACL was set' }",
    );
    expect(script.indexOf("FileSystem($handle")).toBeLessThan(script.indexOf("[string]$info.Volume"));
    expect(script).toContain("GetVolumeInformationByHandleW(handle, null, 0, out serial, out length, out flags, system, 261)");
    expect(script.endsWith("[Console]::Out.Write('OK')")).toBe(true);
    // The command line stays well under the 32767-character CreateProcess limit.
    expect(String(directoryInitCalls()[0]![1]).length).toBeLessThan(30_000);
    expect(String(publicationCalls()[0]![1]).length).toBeLessThan(8_000);
    expect(String((publicationCalls()[0]![2] as { AGENC_CRON_PUBLISH_BODY: string }).AGENC_CRON_PUBLISH_BODY).length).toBeLessThan(32_767);
    expect(await readFile(join(directory, "scheduled_tasks.json"), "utf8")).toBe(body);
  });

  test("publishes the task file through the verified directory handle", async () => {
    await writeRecord();
    const call = publicationCalls()[0]!;
    const script = Buffer.from(String((call[2] as { AGENC_CRON_PUBLISH_BODY: string }).AGENC_CRON_PUBLISH_BODY), "base64").toString("utf8");
    const bootstrap = Buffer.from(String(call[1]), "base64").toString("utf16le");
    expect(bootstrap).toContain("Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AGENC_CRON_PUBLISH_BODY)))");
    expect(bootstrap.indexOf("LanguageMode")).toBeLessThan(bootstrap.indexOf("Invoke-Expression"));
    expect(bootstrap).not.toMatch(/SetAccessControl|Set-Acl/u);
    const variables = call[2] as Record<string, string>;
    expect(variables.AGENC_CRON_PUBLISH_DIRECTORY).toBe(metadataDirectory());
    expect(variables.AGENC_CRON_PUBLISH_FAULT).toBe("");
    expect(variables.AGENC_CRON_PUBLISH_HOOK).toBe("");
    expect(variables.AGENC_CRON_TEMPORARY).toMatch(/^scheduled_tasks\.json\.[0-9a-f-]{36}\.tmp$/u);
    expect(call[4]).toEqual(Buffer.from(body, "utf8"));
    expect(script).not.toMatch(/SetAccessControl|Set-Acl|SetNamedSecurityInfo|SetSecurityInfo|SetFileSecurity|icacls|Remove-Item/u);
    const order = [
      "Invoke-PublishFault 'before-temp-create'",
      "CreateNewChild($dir, $temp)",
      "Invoke-PublishFault 'before-temp-security'",
      "[AgencCronRepair]::Protect($created,",
      "WriteAll($created, $payload)",
      "Invoke-PublishFault 'before-rename'",
      "RenameWithin($created, $dir, $name, $false)",
      "RenameWithin($created, $dir, $name, $true)",
      "FlushFolder($dir)",
      "Invoke-PublishFault 'before-published-check'",
      "OpenChild($dir, $name, $full, 0x100080)",
      "DeleteWhenClosed($created)",
    ];
    let cursor = 0;
    for (const needle of order) {
      const at = script.indexOf(needle, cursor);
      expect(at).toBeGreaterThan(cursor - 1);
      cursor = at + needle.length;
    }
    expect(script.indexOf("CreateNewChild")).toBeGreaterThan(script.indexOf("OpenPublishFolder"));
    expect(script.indexOf("[AgencCronRepair]::Protect($created,")).toBeLessThan(script.indexOf("Invoke-PublishFault 'before-rename'"));
    expect(script.slice(script.indexOf("Invoke-PublishFault 'before-published-check'"))).not.toContain("::Protect(");
    expect(script).toContain("if ($env:AGENC_CRON_PUBLISH_FAULT -ne $stage) { return }");
    expect(script).toContain("target.Root = folder.DangerousGetHandle()");
    expect(script).toContain("NtCreateFile(out handle, 0x1F0187, ref target, out result, IntPtr.Zero, 0x80, 7, 2, 0x200060,");
    expect(String(call[1]).length).toBeLessThan(8_000);
    expect(String((call[2] as { AGENC_CRON_PUBLISH_BODY: string }).AGENC_CRON_PUBLISH_BODY).length).toBeLessThan(32_767);
  });

  test("names a failed publication rename with its status instead of an ACL failure", async () => {
    acl.runWindowsSecurityScript.mockImplementation((path: string, _encoded?: string, variables?: Record<string, string>) => {
      if (variables?.AGENC_CRON_PUBLISH_DIRECTORY !== undefined) {
        throw verifierFailure(
          path,
          "Exception calling \"RenameWithin\" with \"4\" argument(s): \"publication rename failed (NTSTATUS 0xC000000D, Win32 error 87)\"",
        );
      }
      privatePaths.add(`directory\0${path}`);
    });
    const directory = metadataDirectory();
    const error = await writeRecord().catch((caught: unknown) => caught) as Error;
    expect(error).toMatchObject({ code: "CRON_STORAGE_UNSAFE_ACL" });
    expect(error.message).toBe(
      `Durable cron storage did not publish the task file in ${directory}: publication rename failed ` +
      "(NTSTATUS 0xC000000D, Win32 error 87). Nothing outside the verified directory was written, and the previous " +
      "task file was left in place when publication could not be acknowledged.",
    );
  });

  test("names a refused publication without offering the repair", async () => {
    acl.runWindowsSecurityScript.mockImplementation((path: string, _encoded?: string, variables?: Record<string, string>) => {
      if (variables?.AGENC_CRON_PUBLISH_DIRECTORY !== undefined) {
        throw verifierFailure(path, "publication directory changed before acknowledgement");
      }
      privatePaths.add(`directory\0${path}`);
    });
    const directory = metadataDirectory();
    const error = await writeRecord().catch((caught: unknown) => caught) as Error;
    expect(error).toMatchObject({ code: "CRON_STORAGE_UNSAFE_ACL" });
    expect(error.message).toBe(
      `Durable cron storage did not publish the task file in ${directory}: publication directory changed before acknowledgement. ` +
      "Nothing outside the verified directory was written, and the previous task file was left in place " +
      "when publication could not be acknowledged.",
    );
    expect(error.message).not.toMatch(/Command:|Repaired/u);
    expect(await readdir(directory)).toEqual([]);
  });

  test("fails closed when the created .agenc was replaced before its ACL was set", async () => {
    acl.runWindowsSecurityScript.mockImplementation((path: string) => {
      throw verifierFailure(path, "directory identity changed before its ACL was set");
    });
    const directory = metadataDirectory();
    const error = await writeRecord().catch((caught: unknown) => caught) as Error;
    expect(error).toMatchObject({ code: "CRON_STORAGE_UNSAFE_ACL" });
    expect(error.message).toBe(
      `${PERMISSIONS_ERROR}: ${directory} was replaced after it was created and before its ACL was set, ` +
      "and no ACL was written. Check what is at that path, then retry.",
    );
    expect(error.message).not.toMatch(/PowerShell|Command:/u);
    expect(await readdir(directory)).not.toContain("scheduled_tasks.json");
    expect(pathBasedDirectoryInits()).toHaveLength(0);
  });

  test("does not follow a hard link planted in the new .agenc before its ACL is set", async () => {
    const planted = join(outside, "planted.json");
    writeFileSync(planted, "outside");
    acl.beforeHandleInit = (path) => {
      linkSync(planted, join(path, "scheduled_tasks.json"));
      linkSync(planted, join(path, "other.json"));
    };
    await writeRecord();
    // Only the handle write touched .agenc; publication replaced the planted
    // name instead of writing through it.
    expect(pathBasedDirectoryInits()).toHaveLength(0);
    expect(await readFile(planted, "utf8")).toBe("outside");
    expect(await readFile(join(metadataDirectory(), "scheduled_tasks.json"), "utf8")).toBe(body);
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
      expect(error.message).toContain(repairAdvice(directory, " (elevated if access is denied)"));
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
      repairAdvice(directory),
    );
    expect(error.message).not.toContain("empty");
    expect(await readdir(directory)).toEqual([]);
    expect(aclMutations()).toHaveLength(1);
    // The next call sees an existing directory: it validates only and still names the repair.
    await expect(writeRecord()).rejects.toThrow(repairAdvice(directory));
    expect(aclMutations()).toHaveLength(1);
  });

  test("rechecks the metadata directory identity immediately before initializing it", async () => {
    const directory = metadataDirectory();
    fsHooks.lstat = (path, calls) => path === directory && calls === 3 ? "swap" : undefined;
    await expect(writeRecord()).rejects.toThrow(PERMISSIONS_ERROR);
    expect(aclMutations()).toHaveLength(0);
  });

  test("explains an unsupported volume as a platform limit without a repair", async () => {
    const directory = metadataDirectory();
    await mkdir(directory, { mode: 0o700 });
    // PowerShell echoes the throwing source line before the message; that echo never names a file system.
    const echoed = (format: string) => `throw "NTFS is required ($($drive.DriveFormat))"_x000D__x000A_</S>` +
      `<S S="Error">NTFS is required (${format})`;
    for (const [reason, where] of [
      [echoed("ReFS"), `${directory} is on a volume formatted as ReFS`],
      ["NTFS is required (FAT32)", `${directory} is on a volume formatted as FAT32`],
      ["NTFS is required (exFAT)", `${directory} is on a volume formatted as exFAT`],
      ["NTFS is required", `${directory} is on a volume that is not NTFS`],
      ["NTFS is required ()", `${directory} is on a volume that is not NTFS`],
      ["network and device paths are unsupported", `${directory} is a network or device path`],
    ]) {
      acl.assertWindowsPrivatePathSecurity.mockImplementation((path: string) => {
        throw verifierFailure(path, reason);
      });
      const error = await readCronTasks(workspace).catch((caught: unknown) => caught) as Error;
      expect(error).toMatchObject({ code: "CRON_STORAGE_UNSAFE_ACL" });
      expect(error.message).toBe(
        `Durable cron storage on Windows requires a local NTFS volume, and ${where}. ` +
        "This is a platform limitation that no permission change can fix; its permissions were left unchanged. " +
        "Move the project to a local NTFS volume, or schedule the task with durable:false.",
      );
      expect(error.message).not.toMatch(/PowerShell|Command:/u);
    }
    expect(aclMutations()).toHaveLength(0);
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
