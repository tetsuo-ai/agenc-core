// F1 regression probes for #2976 (external review of 1f5f10bf).
// They run the production Windows branch on Linux with process.platform
// forced to "win32", no traversable descriptor alias (as on Windows), a mocked
// ACL helper, and REAL file / directory / hard-link replacements.
//
// The namespace swap is triggered at the last moment before each mutation:
//   P1: just before the first ACL initialization of the temporary basename
//   P2: right after the temporary rename, before the published-name ACL step
//   P3: just before the temporary file is opened
// Safety properties (all must hold; the operation must also not acknowledge):
//   - no ACL mutation (path-based initialize, or handle script) resolves to
//     the outside fixture's inode;
//   - the outside fixture's bytes are unchanged;
//   - no task bytes ever appear outside the verified .agenc directory.
// When the production code changes its hook points (e.g. a handle-based
// helper replaces the path-based initializer), keep these scenario semantics
// and move the trigger to the equivalent last-moment point in the new code.
import "../helpers/cron-os-home.js";
import { linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { withCronStorage } from "../../src/utils/cron-storage.js";

const acl = vi.hoisted(() => ({
  assertWindowsPrivatePathSecurity: vi.fn(),
  runWindowsSecurityScript: vi.fn(),
}));
const hooks = vi.hoisted(() => ({
  beforeAclInit: undefined as ((path: string) => void) | undefined,
  afterRename: undefined as ((from: string, to: string) => void) | undefined,
  beforeOpen: undefined as ((path: string) => void) | undefined,
  mutationTargets: [] as { path: string; ino?: bigint; nlink?: bigint }[],
  // Task bytes seen outside .agenc at any point during the operation.
  observeOutside: undefined as (() => void) | undefined,
  leaked: [] as string[],
}));
const privatePaths = vi.hoisted(() => new Set<string>());

function recordTarget(path: string): void {
  try {
    const info = lstatSync(path, { bigint: true });
    hooks.mutationTargets.push({ path, ino: info.ino, nlink: info.nlink });
  } catch {
    hooks.mutationTargets.push({ path });
  }
}

vi.mock("../../src/agents/workflow-private-path.js", () => ({
  assertWindowsPrivatePathSecurity: acl.assertWindowsPrivatePathSecurity,
  runWindowsSecurityScript: acl.runWindowsSecurityScript,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    lstat: async (...args: Parameters<typeof original.lstat>) => {
      hooks.observeOutside?.();
      return original.lstat(...args);
    },
    rm: async (...args: Parameters<typeof original.rm>) => {
      hooks.observeOutside?.();
      return original.rm(...args);
    },
    realpath: async (...args: Parameters<typeof original.realpath>) => {
      hooks.observeOutside?.();
      const path = String(args[0]);
      if (/^\/(?:proc\/self\/fd|dev\/fd)\//u.test(path)) {
        throw Object.assign(new Error("No traversable descriptor alias"), { code: "ENOENT" });
      }
      return original.realpath(...args);
    },
    rename: async (...args: Parameters<typeof original.rename>) => {
      await original.rename(...args);
      hooks.afterRename?.(String(args[0]), String(args[1]));
    },
    open: async (...args: Parameters<typeof original.open>) => {
      hooks.beforeOpen?.(String(args[0]));
      return original.open(...args);
    },
  };
});

const body = `${JSON.stringify({ tasks: [{ id: "probe", cron: "* * * * *", prompt: "confined", createdAt: 1 }] }, null, 2)}\n`;
const OUTSIDE_BYTES = "outside fixture: must never change\n";
let root: string;
let workspace: string;
let outside: string;
let outsideFile: string;
let outsideIno: bigint;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

function agenc(): string { return join(realpathSync(workspace), ".agenc"); }

/** Rename .agenc aside and put a different real directory at its name. */
function replaceAgencWithRealDirectory(): void {
  renameSync(agenc(), `${agenc()}-aside`);
  mkdirSync(agenc(), { mode: 0o700 });
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function assertOutsideUntouched(): void {
  expect(readFileSync(outsideFile, "utf8")).toBe(OUTSIDE_BYTES);
  expect(hooks.mutationTargets.filter((target) => target.ino === outsideIno)).toEqual([]);
  hooks.observeOutside?.();
  expect(hooks.leaked).toEqual([]);
}

/** Record any outside file holding task bytes, while the operation runs. */
function scanOutside(): void {
  for (const file of filesUnder(outside)) {
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    if (text.includes("confined") && !hooks.leaked.includes(file)) hooks.leaked.push(file);
  }
}

beforeEach(async () => {
  privatePaths.clear();
  hooks.beforeAclInit = undefined;
  hooks.afterRename = undefined;
  hooks.beforeOpen = undefined;
  hooks.mutationTargets = [];
  hooks.observeOutside = undefined;
  hooks.leaked = [];
  acl.assertWindowsPrivatePathSecurity.mockReset();
  acl.assertWindowsPrivatePathSecurity.mockImplementation((path: string, role: string, initialize: boolean) => {
    const key = `${role}\0${path}`;
    if (initialize) {
      hooks.beforeAclInit?.(path);
      recordTarget(path);
      privatePaths.add(key);
      return;
    }
    if (!privatePaths.has(key)) throw new Error(`not private: ${path}`);
  });
  acl.runWindowsSecurityScript.mockReset();
  acl.runWindowsSecurityScript.mockImplementation((path: string) => {
    recordTarget(path);
    privatePaths.add(`directory\0${path}`);
  });
  root = await mkdtemp(join(tmpdir(), "agenc-2976-f1-"));
  workspace = join(root, "workspace");
  outside = join(root, "outside");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  outsideFile = join(outside, "victim.txt");
  writeFileSync(outsideFile, OUTSIDE_BYTES, { mode: 0o600 });
  outsideIno = lstatSync(outsideFile, { bigint: true }).ino;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  // Create and privatize .agenc with a first, unhooked publication.
  await withCronStorage(workspace, true, (storage) => storage.write("{\"tasks\":[]}\n"));
  hooks.mutationTargets = [];
  hooks.observeOutside = scanOutside;
});
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  await rm(root, { recursive: true, force: true });
});

async function publish(): Promise<unknown> {
  return withCronStorage(workspace, true, (storage) => storage.write(body));
}

describe("#2976 F1: Windows publication never mutates through a redirected pathname", () => {
  test("P1 temporary ACL substitution: no initializer targets the outside inode", async () => {
    let fired = false;
    hooks.beforeAclInit = (path) => {
      if (fired || !path.endsWith(".tmp")) return;
      fired = true;
      replaceAgencWithRealDirectory();
      linkSync(outsideFile, join(agenc(), basename(path)));
    };
    await expect(publish()).rejects.toThrow();
    assertOutsideUntouched();
  });

  test("P2 published-name ACL substitution: no initializer targets the outside inode", async () => {
    let fired = false;
    hooks.afterRename = (_from, to) => {
      if (fired || !to.endsWith(`${sep}scheduled_tasks.json`)) return;
      fired = true;
      replaceAgencWithRealDirectory();
      linkSync(outsideFile, join(agenc(), "scheduled_tasks.json"));
    };
    await expect(publish()).rejects.toThrow();
    assertOutsideUntouched();
  });

  test("P3 root replacement before the temporary open: task bytes never leave .agenc", async () => {
    let fired = false;
    hooks.beforeOpen = (path) => {
      if (fired || !path.endsWith(".tmp")) return;
      fired = true;
      renameSync(agenc(), `${agenc()}-aside`);
      symlinkSync(outside, agenc(), "dir");
    };
    await expect(publish()).rejects.toThrow();
    assertOutsideUntouched();
  });
});
