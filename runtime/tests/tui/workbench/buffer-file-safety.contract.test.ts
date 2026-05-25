import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkbenchBufferStore } from "../../../src/tui/workbench/buffer/BufferStore.js";
import { createNeovimRenderSnapshot } from "../../../src/tui/workbench/buffer/neovim/NeovimGrid.js";
import {
  BufferBinaryFileError,
  BufferFileTooLargeError,
  BufferSaveConflictError,
  BufferUnsafePathError,
  readBufferFileSnapshot,
  resolveBufferFilePath,
  saveBufferFileSnapshot,
} from "../../../src/tui/workbench/buffer/fileSnapshot.js";
import { NeovimBufferProvider } from "../../../src/tui/workbench/buffer/providers/neovim/NeovimBufferProvider.js";
import type { StartEmbeddedNeovimOptions } from "../../../src/tui/workbench/buffer/neovim/NeovimLifecycle.js";
import { runWithCwdOverride } from "../../../src/utils/cwd.js";

let dir: string;

const usableDiscovery = {
  usable: true,
  executable: "/usr/bin/nvim",
  version: { major: 0, minor: 12, patch: 0, raw: "NVIM v0.12.0" },
  args: ["--embed", "--clean", "-n"],
  useUserInit: false,
} as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agenc-buffer-safety-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("BUFFER file safety", () => {
  it("rejects a relative path that escapes the workspace", async () => {
    await runWithCwdOverride(dir, async () => {
      expect(() => resolveBufferFilePath("../outside.txt")).toThrow(BufferUnsafePathError);
      expect(resolveBufferFilePath(join(dir, "inside.txt"))).toBe(join(dir, "inside.txt"));
      expect(() => resolveBufferFilePath(join(tmpdir(), "outside-buffer.txt"))).toThrow(BufferUnsafePathError);
    });
  });

  it("resolves paths against a missing base without escaping the requested base", () => {
    const missingBase = join(dir, "missing-base");

    expect(resolveBufferFilePath("child.txt", missingBase)).toBe(join(missingBase, "child.txt"));
    expect(() => resolveBufferFilePath("../outside.txt", missingBase)).toThrow(BufferUnsafePathError);
  });

  it("rethrows path resolution errors that are not missing files", async () => {
    await writeFile(join(dir, "plain-file"), "alpha\n", "utf8");

    await runWithCwdOverride(dir, async () => {
      expect(() => resolveBufferFilePath(join("plain-file", "child.txt"))).toThrow();
    });
  });

  it("rejects a workspace symlink that resolves outside the workspace", async () => {
    const outside = join(tmpdir(), `agenc-outside-${Date.now()}.txt`);
    await writeFile(outside, "outside\n", "utf8");
    await symlink(outside, join(dir, "outside-link.txt"));

    try {
      await runWithCwdOverride(dir, async () => {
        expect(() => resolveBufferFilePath("outside-link.txt")).toThrow(BufferUnsafePathError);
        await expect(readBufferFileSnapshot("outside-link.txt")).rejects.toThrow(BufferUnsafePathError);
      });
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("rejects binary and over-size files with user-facing details before editing", async () => {
    await writeFile(join(dir, "binary.bin"), Buffer.from([65, 0, 66]));
    await writeFile(join(dir, "large.txt"), "abcdef", "utf8");

    await runWithCwdOverride(dir, async () => {
      await expect(readBufferFileSnapshot("binary.bin")).rejects.toThrow(BufferBinaryFileError);
      await expect(readBufferFileSnapshot("binary.bin")).rejects.toThrow("appears to be binary");
      await expect(readBufferFileSnapshot("large.txt", { maxBytes: 5 })).rejects.toThrow(BufferFileTooLargeError);
      await expect(readBufferFileSnapshot("large.txt", { maxBytes: 5 })).rejects.toThrow("exceeds the editable buffer limit of 5 bytes");
    });
  });

  it("rejects directories before any provider opens them", async () => {
    await mkdir(join(dir, "folder"), { recursive: true });

    await runWithCwdOverride(dir, async () => {
      await expect(readBufferFileSnapshot("folder")).rejects.toThrow("regular file");
    });
  });

  it("preserves CRLF line endings across save", async () => {
    const file = join(dir, "crlf.txt");
    await writeFile(file, "alpha\r\nbeta\r\n", "utf8");
    const snapshot = await runWithCwdOverride(dir, () => readBufferFileSnapshot("crlf.txt"));

    await saveBufferFileSnapshot(snapshot, snapshot.content, { force: true });
    expect(await readFile(file, "utf8")).toBe("alpha\r\nbeta\r\n");

    const nextSnapshot = await runWithCwdOverride(dir, () => readBufferFileSnapshot("crlf.txt"));
    await saveBufferFileSnapshot(snapshot, "alpha\nbeta\ngamma\n", { force: true });

    expect(await readFile(file, "utf8")).toBe("alpha\r\nbeta\r\ngamma\r\n");
    expect(nextSnapshot.lineEndings).toBe("CRLF");
  });

  it("preserves UTF-16LE content and BOM across save", async () => {
    const file = join(dir, "utf16.txt");
    await writeFile(file, Buffer.from("\ufeffalpha\nbeta\n", "utf16le"));
    const snapshot = await runWithCwdOverride(dir, () => readBufferFileSnapshot("utf16.txt"));

    expect(snapshot.encoding).toBe("utf16le");
    expect(snapshot.content).toBe("alpha\nbeta\n");
    await saveBufferFileSnapshot(snapshot, "alpha\ngamma\n", { force: true });

    const saved = await readFile(file);
    expect(saved[0]).toBe(0xff);
    expect(saved[1]).toBe(0xfe);
    expect(saved.toString("utf16le")).toBe("\ufeffalpha\ngamma\n");
  });

  it("blocks non-force save when disk mtime changed after open", async () => {
    const file = join(dir, "conflict.txt");
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(file, "alpha\n", "utf8");
    const snapshot = await runWithCwdOverride(dir, () => readBufferFileSnapshot("conflict.txt"));
    const changed = new Date(snapshot.mtimeMs + 10_000);
    await utimes(file, changed, changed);

    await expect(saveBufferFileSnapshot(snapshot, "gamma\n")).rejects.toBeInstanceOf(BufferSaveConflictError);
  });

  it("blocks non-force save when disk content changed without an mtime delta", async () => {
    const file = join(dir, "content-conflict.txt");
    const openedAt = new Date("2025-01-01T00:00:00.000Z");
    await writeFile(file, "alpha\n", "utf8");
    await utimes(file, openedAt, openedAt);
    const snapshot = await runWithCwdOverride(dir, () => readBufferFileSnapshot("content-conflict.txt"));
    await writeFile(file, "beta\n", "utf8");
    await utimes(file, openedAt, openedAt);

    await expect(saveBufferFileSnapshot(snapshot, "gamma\n")).rejects.toBeInstanceOf(BufferSaveConflictError);
  });

  it("blocks in-flight agent saves through the inline store", async () => {
    const file = join(dir, "agent-conflict.txt");
    await writeFile(file, "alpha\n", "utf8");
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, async () => {
      await store.open("agent-conflict.txt");
      store.insert("beta ");

      await expect(store.save({ hasInFlightAgent: true })).resolves.toBe(false);
      expect(store.getSnapshot()).toMatchObject({
        status: "conflict",
        conflictKind: "agent",
        error: expect.stringContaining("agent"),
      });
    });
  });

  it("blocks in-flight agent saves through the embedded Neovim provider", async () => {
    const session = createSession();
    const provider = new NeovimBufferProvider({
      discovery: usableDiscovery,
      readFileSnapshot: vi.fn(async (filePath: string) => ({
        filePath,
        absolutePath: join(dir, "agent-conflict.txt"),
        content: "alpha\n",
        mtimeMs: 1,
        size: 6,
        encoding: "utf8",
        lineEndings: "LF",
      })),
      startSession: vi.fn(async (options: StartEmbeddedNeovimOptions) => {
        options.onSnapshot(createNeovimRenderSnapshot(options.size.rows, options.size.columns));
        return session as never;
      }),
    });

    await provider.open({ filePath: "agent-conflict.txt" });

    await expect(provider.save({ hasInFlightAgent: true })).resolves.toBe(false);
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "conflict",
      conflictKind: "agent",
      error: expect.stringContaining("agent"),
    });
    expect(session.save).not.toHaveBeenCalled();
  });

  it("rejects unsafe files before embedded Neovim starts", async () => {
    const file = join(dir, "binary.bin");
    await writeFile(file, Buffer.from([65, 0, 66]));
    const startSession = vi.fn();
    const provider = new NeovimBufferProvider({
      discovery: {
        usable: true,
        executable: "/usr/bin/nvim",
        version: { major: 0, minor: 12, patch: 0, raw: "NVIM v0.12.0" },
        args: ["--embed", "--clean", "-n"],
        useUserInit: false,
      },
      startSession,
    });

    await runWithCwdOverride(dir, async () => {
      await provider.open({ filePath: "binary.bin" });
    });

    expect(startSession).not.toHaveBeenCalled();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: expect.stringContaining("binary"),
    });
  });

  it("rejects escaping provider paths before inline or embedded providers open them", async () => {
    const startSession = vi.fn();
    const provider = new NeovimBufferProvider({
      discovery: usableDiscovery,
      startSession,
    });
    const store = new WorkbenchBufferStore();

    await runWithCwdOverride(dir, async () => {
      await provider.open({ filePath: "../outside.txt" });
      await store.open("../outside.txt");
    });

    expect(startSession).not.toHaveBeenCalled();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: expect.stringContaining("outside"),
    });
    expect(store.getSnapshot()).toMatchObject({
      status: "error",
      error: expect.stringContaining("outside"),
    });
  });

  it("rejects oversized files before embedded Neovim starts", async () => {
    const startSession = vi.fn();
    const provider = new NeovimBufferProvider({
      discovery: usableDiscovery,
      readFileSnapshot: vi.fn(async () => {
        throw new BufferFileTooLargeError("large.txt", 6, 5);
      }),
      startSession,
    });

    await provider.open({ filePath: "large.txt" });

    expect(startSession).not.toHaveBeenCalled();
    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "error",
      error: expect.stringContaining("exceeds the editable buffer limit"),
    });
  });

  it("reports embedded Neovim disk conflicts before non-force save", async () => {
    let mtimeMs = 1;
    let content = "alpha\n";
    const session = createSession();
    const provider = new NeovimBufferProvider({
      discovery: usableDiscovery,
      readFileSnapshot: vi.fn(async (filePath: string) => ({
        filePath,
        absolutePath: join(dir, "conflict.txt"),
        content,
        mtimeMs,
        size: 6,
        encoding: "utf8",
        lineEndings: "LF",
      })),
      startSession: vi.fn(async (options: StartEmbeddedNeovimOptions) => {
        options.onSnapshot(createNeovimRenderSnapshot(options.size.rows, options.size.columns));
        return session as never;
      }),
    });

    await provider.open({ filePath: "conflict.txt" });
    mtimeMs = 2;

    await expect(provider.save()).resolves.toBe(false);

    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "conflict",
      conflictKind: "disk",
      error: expect.stringContaining("changed on disk"),
    });
    expect(session.save).not.toHaveBeenCalled();

    mtimeMs = 1;
    content = "alpha\n";
    const contentSession = createSession();
    const contentProvider = new NeovimBufferProvider({
      discovery: usableDiscovery,
      readFileSnapshot: vi.fn(async (filePath: string) => ({
        filePath,
        absolutePath: join(dir, "content-conflict.txt"),
        content,
        mtimeMs,
        size: content.length,
        encoding: "utf8",
        lineEndings: "LF",
      })),
      startSession: vi.fn(async (options: StartEmbeddedNeovimOptions) => {
        options.onSnapshot(createNeovimRenderSnapshot(options.size.rows, options.size.columns));
        return contentSession as never;
      }),
    });

    await contentProvider.open({ filePath: "content-conflict.txt" });
    content = "beta\n";

    await expect(contentProvider.save()).resolves.toBe(false);
    expect(contentProvider.getSnapshot()).toMatchObject({
      providerStatus: "conflict",
      conflictKind: "disk",
      error: expect.stringContaining("changed on disk"),
    });
    expect(contentSession.save).not.toHaveBeenCalled();
  });

  it("keeps embedded active file, cursor, and metadata synchronized after provider updates", async () => {
    let onSnapshot: ((snapshot: ReturnType<typeof createNeovimRenderSnapshot>) => void) | null = null;
    const session = createSession();
    const provider = new NeovimBufferProvider({
      discovery: usableDiscovery,
      readFileSnapshot: vi.fn(async (filePath: string) => ({
        filePath,
        absolutePath: join(dir, "cursor.txt"),
        content: "alpha\r\n",
        mtimeMs: 1,
        size: 7,
        encoding: "utf8",
        lineEndings: "CRLF",
      })),
      startSession: vi.fn(async (options: StartEmbeddedNeovimOptions) => {
        onSnapshot = options.onSnapshot;
        return session as never;
      }),
    });

    await provider.open({ filePath: "cursor.txt" });
    const terminal = createNeovimRenderSnapshot(4, 20);
    onSnapshot?.({
      ...terminal,
      cursor: { grid: 1, row: 3, column: 7 },
      lines: ["alpha", "", "", ""],
    });

    expect(provider.getSnapshot()).toMatchObject({
      filePath: "cursor.txt",
      absolutePath: join(dir, "cursor.txt"),
      position: { line: 4, column: 7, offset: 0 },
      encoding: "utf8",
      lineEndings: "CRLF",
    });
  });

  it("refreshes embedded file metadata after successful Neovim writes", async () => {
    let mtimeMs = 1;
    const session = createSession();
    session.save.mockImplementation(async () => {
      mtimeMs += 1;
      return true;
    });
    const provider = new NeovimBufferProvider({
      discovery: usableDiscovery,
      readFileSnapshot: vi.fn(async (filePath: string) => ({
        filePath,
        absolutePath: join(dir, "saved.txt"),
        content: mtimeMs > 1 ? "alpha\r\nsaved\r\n" : "alpha\n",
        mtimeMs,
        size: mtimeMs > 1 ? 14 : 6,
        encoding: mtimeMs > 1 ? "utf16le" : "utf8",
        lineEndings: mtimeMs > 1 ? "CRLF" : "LF",
      })),
      startSession: vi.fn(async (options: StartEmbeddedNeovimOptions) => {
        options.onSnapshot(createNeovimRenderSnapshot(options.size.rows, options.size.columns));
        return session as never;
      }),
    });

    await provider.open({ filePath: "saved.txt" });
    await expect(provider.save()).resolves.toBe(true);

    expect(provider.getSnapshot()).toMatchObject({
      providerStatus: "ready",
      absolutePath: join(dir, "saved.txt"),
      encoding: "utf16le",
      lineEndings: "CRLF",
    });
    await expect(provider.save()).resolves.toBe(true);
    expect(session.save).toHaveBeenCalledTimes(2);
  });

  it("opens and saves zero-length editable files", async () => {
    const file = join(dir, "empty.txt");
    await writeFile(file, "", "utf8");

    await runWithCwdOverride(dir, async () => {
      const snapshot = await readBufferFileSnapshot("empty.txt");

      expect(snapshot).toMatchObject({
        content: "",
        size: 0,
        encoding: "utf8",
        lineEndings: "LF",
      });
      await expect(saveBufferFileSnapshot(snapshot, "", { force: true })).resolves.toMatchObject({
        content: "",
        size: 0,
      });
    });
    expect(await readFile(file, "utf8")).toBe("");
  });

  it("force save recreates a deleted file without reporting a disk conflict", async () => {
    const file = join(dir, "deleted.txt");
    await writeFile(file, "alpha\n", "utf8");
    const snapshot = await runWithCwdOverride(dir, () => readBufferFileSnapshot("deleted.txt"));
    await rm(file, { force: true });

    const saved = await saveBufferFileSnapshot(snapshot, "beta\n", { force: true });

    expect(saved.content).toBe("beta\n");
    expect(await readFile(file, "utf8")).toBe("beta\n");
  });

  it("non-force save refuses a deleted file", async () => {
    const file = join(dir, "deleted-non-force.txt");
    await writeFile(file, "alpha\n", "utf8");
    const snapshot = await runWithCwdOverride(dir, () => readBufferFileSnapshot("deleted-non-force.txt"));
    await rm(file, { force: true });

    await expect(saveBufferFileSnapshot(snapshot, "beta\n")).rejects.toBeInstanceOf(BufferSaveConflictError);
  });

  it("surfaces unexpected filesystem stat failures during save", async () => {
    const snapshot = {
      filePath: "bad-path",
      absolutePath: "\0bad-path",
      content: "alpha\n",
      mtimeMs: 0,
      size: 6,
      encoding: "utf8" as const,
      lineEndings: "LF" as const,
    };

    await expect(saveBufferFileSnapshot(snapshot, "beta\n")).rejects.toThrow();
  });
});

function createSession() {
  return {
    pid: 123,
    input: vi.fn(async () => {}),
    paste: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    focus: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    save: vi.fn(async () => true),
    isDirty: vi.fn(async () => false),
    quit: vi.fn(async () => ({ closed: true as const })),
    cleanup: vi.fn(async () => {}),
  };
}
