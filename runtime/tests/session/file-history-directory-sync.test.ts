import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { open, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FileHistory } from "../../src/session/file-history.js";

// Reload helpers imported by test setup so filesystem fault injection reaches them.
vi.hoisted(() => vi.resetModules());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});

const actualOpen = vi.mocked(open).getMockImplementation()!;
const actualRename = vi.mocked(rename).getMockImplementation()!;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const unsupportedCodes = ["EBADF", "EISDIR", "EINVAL", "ENOTSUP", "EPERM", "EACCES"];
const platforms = ["win32", "linux", "darwin"] as const;

let project: string;
let history: FileHistory;
let diagnostics: Array<{ cause: string; message: string }>;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "agenc-fh-dir-sync-"));
  diagnostics = [];
  history = new FileHistory({
    projectDir: project,
    sessionId: "directory-sync",
    onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
  });
});

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  history.stop();
  vi.restoreAllMocks();
  vi.mocked(open).mockReset().mockImplementation(actualOpen);
  vi.mocked(rename).mockReset().mockImplementation(actualRename);
  rmSync(project, { recursive: true, force: true });
});

function failDirectory(code: string, phase: "open" | "sync") {
  const error = Object.assign(new Error(`directory ${phase}: ${code}`), { code });
  const close = vi.fn(async () => {});
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    if (flags !== "r") return actualOpen(path, flags, mode);
    if (phase === "open") throw error;
    return { sync: async () => { throw error; }, close } as unknown as Awaited<ReturnType<typeof open>>;
  });
  return { error, close };
}

describe.each(platforms)("file-history directory sync on %s", (platform) => {
  test.each(unsupportedCodes)("preserves the platform policy for unsupported %s", async (code) => {
    Object.defineProperty(process, "platform", { value: platform });
    const { error, close } = failDirectory(code, "sync");
    await history.makeSnapshot("first");
    await history.flush();
    expect(close).toHaveBeenCalledOnce();
    if (platform === "win32" || code === "EINVAL" || code === "ENOTSUP") {
      expect(diagnostics).toEqual([]);
      await expect(history["persistState"]()).resolves.toBeUndefined();
    } else {
      expect(diagnostics).toEqual([{ cause: "file_history_save_failed", message: String(error) }]);
      await expect(history["persistState"]()).rejects.toBe(error);
    }
    const index = join(history["historyDir"], "snapshots.json");
    expect(JSON.parse(readFileSync(index, "utf8")).snapshots[0].messageId).toBe("first");
    expect(readdirSync(history["historyDir"])).toEqual(["snapshots.json"]);
  });
});

test.each(unsupportedCodes)("tolerates unsupported directory open %s on Windows", async (code) => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const { close } = failDirectory(code, "open");
  await history.makeSnapshot("first");
  await history.flush();
  expect(diagnostics).toEqual([]);
  expect(close).not.toHaveBeenCalled();
});

describe.each(platforms)("file-history directory errors on %s", (platform) => {
  test.each(["EIO", "ENOSPC", "ENOENT"])("propagates directory %s", async (code) => {
    Object.defineProperty(process, "platform", { value: platform });
    const { error, close } = failDirectory(code, "sync");
    await expect(history["persistState"]()).rejects.toBe(error);
    expect(close).toHaveBeenCalledOnce();
    await history.makeSnapshot("first");
    expect(diagnostics).toEqual([{ cause: "file_history_save_failed", message: String(error) }]);
  });
});

test("flushes the index file before rename and never suppresses its EPERM on Windows", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const error = Object.assign(new Error("index fsync: EPERM"), { code: "EPERM" });
  const order: string[] = [];
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    const handle = await actualOpen(path, flags, mode);
    vi.spyOn(handle, "sync").mockImplementation(async () => {
      order.push("file-sync");
      throw error;
    });
    return handle;
  });
  await expect(history["persistState"]()).rejects.toBe(error);
  expect(order).toEqual(["file-sync"]);
  expect(rename).not.toHaveBeenCalled();
  expect(readdirSync(history["historyDir"])).toEqual([]);
});

test("syncs and closes the index before rename, then syncs and closes the directory", async () => {
  const order: string[] = [];
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    const handle = await actualOpen(path, flags, mode);
    const kind = flags === "r" ? "directory" : "file";
    const sync = handle.sync.bind(handle);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "sync").mockImplementation(async () => { order.push(`${kind}-sync`); await sync(); });
    vi.spyOn(handle, "close").mockImplementation(async () => { order.push(`${kind}-close`); await close(); });
    return handle;
  });
  vi.mocked(rename).mockImplementation(async (from, to) => { order.push("rename"); await actualRename(from, to); });
  await history.makeSnapshot("first");
  expect(diagnostics).toEqual([]);
  expect(order).toEqual(["file-sync", "file-close", "rename", "directory-sync", "directory-close"]);
});
