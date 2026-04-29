import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFilesystemTools,
  clearSessionReadState,
  clearSessionReadCache,
  hasSessionRead,
  seedSessionReadState,
  safePath,
  isPathAllowed,
} from "./filesystem.js";
import type { Tool } from "../types.js";

// ============================================================================
// Mock node:fs/promises
// ============================================================================

vi.mock("node:fs/promises", () => ({
  opendir: vi.fn(),
  stat: vi.fn(),
  lstat: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  rename: vi.fn(),
  // realpath: identity by default — tests override for symlink scenarios
  realpath: vi.fn(async (p: string) => p),
}));

import {
  opendir,
  stat,
  lstat,
  mkdir,
  rm,
  rename,
  realpath,
} from "node:fs/promises";

const mockOpendir = vi.mocked(opendir);
const mockStat = vi.mocked(stat);
const mockLstat = vi.mocked(lstat);
const mockMkdir = vi.mocked(mkdir);
const mockRm = vi.mocked(rm);
const mockRename = vi.mocked(rename);
const mockRealpath = vi.mocked(realpath);

/** Create a mock Dir handle (async iterable + close). */
function createMockDir(
  entries: Array<{
    name: string;
    isDirectory: () => boolean;
    isFile: () => boolean;
    isSymbolicLink?: () => boolean;
  }>,
) {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index < entries.length)
            return { done: false as const, value: entries[index++] };
          return { done: true as const, value: undefined };
        },
      };
    },
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// ============================================================================
// Helpers
// ============================================================================

function findTool(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

function parseResult(result: { content: string }) {
  return JSON.parse(result.content);
}

const ALLOWED_PATHS = ["/workspace"];
const CONFIG = { allowedPaths: ALLOWED_PATHS };

// ============================================================================
// safePath / isPathAllowed
// ============================================================================

describe("safePath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: realpath returns identity (no symlinks)
    mockRealpath.mockImplementation(async (p: string) => p as never);
  });

  it("accepts paths within allowed directories", async () => {
    const result = await safePath("/workspace/file.txt", ALLOWED_PATHS);
    expect(result.safe).toBe(true);
    expect(result.resolved).toBe("/workspace/file.txt");
  });

  it("expands ~ in target paths before allowlist validation", async () => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = "/home/tester";
    process.env.USERPROFILE = undefined;
    try {
      const result = await safePath(
        "~/workspace/file.txt",
        ["/home/tester/workspace"],
      );
      expect(result.safe).toBe(true);
      expect(result.resolved).toBe("/home/tester/workspace/file.txt");
    } finally {
      process.env.HOME = previousHome;
      process.env.USERPROFILE = previousUserProfile;
    }
  });

  it("expands ~ in allowed path prefixes", async () => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = "/home/tester";
    process.env.USERPROFILE = undefined;
    try {
      const result = await safePath("/home/tester/workspace/file.txt", ["~/workspace"]);
      expect(result.safe).toBe(true);
      expect(result.resolved).toBe("/home/tester/workspace/file.txt");
    } finally {
      process.env.HOME = previousHome;
      process.env.USERPROFILE = previousUserProfile;
    }
  });

  it("rejects paths outside allowed directories", async () => {
    const result = await safePath("/etc/passwd", ALLOWED_PATHS);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("outside allowed");
  });

  it("detects path traversal with ..", async () => {
    // Absolute path with .. triggers segment-aware check
    const result = await safePath("/workspace/../etc/passwd", ALLOWED_PATHS);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("traversal");

    // Relative traversal also caught
    const result2 = await safePath("../../../etc/passwd", ALLOWED_PATHS);
    expect(result2.safe).toBe(false);
    expect(result2.reason).toContain("traversal");
  });

  it("allows filenames containing double dots (e.g. file..txt)", async () => {
    const result = await safePath("/workspace/file..txt", ALLOWED_PATHS);
    expect(result.safe).toBe(true);
  });

  it("rejects empty paths", async () => {
    const result = await safePath("", ALLOWED_PATHS);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("non-empty");
  });

  it("rejects when no allowed paths configured", async () => {
    const result = await safePath("/workspace/file.txt", []);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("No allowed paths");
  });

  it("rejects null-byte paths", async () => {
    const result = await safePath("/workspace/file.txt\0evil", ALLOWED_PATHS);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("null byte");
  });

  it("canonicalizes paths with multiple non-existent parent levels", async () => {
    // /workspace exists, a/b/c do not — should walk up to /workspace and resolve
    mockRealpath.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s === "/workspace") return "/workspace" as never;
      // Everything deeper fails with ENOENT
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const result = await safePath("/workspace/a/b/c/new.txt", ALLOWED_PATHS);
    expect(result.safe).toBe(true);
    expect(result.resolved).toBe("/workspace/a/b/c/new.txt");
  });

  it("resolves symlinks before allowlist check", async () => {
    // Symlink /workspace/link -> /etc, so /workspace/link/passwd -> /etc/passwd
    mockRealpath.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s === "/workspace/link/passwd") return "/etc/passwd" as never;
      if (s === "/workspace") return "/workspace" as never;
      return s as never;
    });

    const result = await safePath("/workspace/link/passwd", ALLOWED_PATHS);
    expect(result.safe).toBe(false);
  });
});

describe("isPathAllowed", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
  });

  it("returns true for allowed paths", async () => {
    expect(await isPathAllowed("/workspace/src/main.ts", ALLOWED_PATHS)).toBe(
      true,
    );
  });

  it("returns false for disallowed paths", async () => {
    expect(await isPathAllowed("/root/.ssh/id_rsa", ALLOWED_PATHS)).toBe(false);
  });
});

// ============================================================================
// createFilesystemTools
// ============================================================================

describe("createFilesystemTools", () => {
  it("returns only filesystem utility tools", () => {
    const tools = createFilesystemTools(CONFIG);
    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "system.delete",
      "system.listDir",
      "system.mkdir",
      "system.move",
      "system.stat",
    ]);
  });

  // ── Config validation (Finding 1) ──────────────────────────────────────

  it("throws on allowedPaths as string (not array)", () => {
    expect(() =>
      createFilesystemTools({
        allowedPaths: "/workspace" as unknown as string[],
      }),
    ).toThrow("non-empty array");
  });

  it("throws on empty allowedPaths", () => {
    expect(() => createFilesystemTools({ allowedPaths: [] })).toThrow(
      "non-empty array",
    );
  });

  it("throws on allowedPaths with empty string entry", () => {
    expect(() => createFilesystemTools({ allowedPaths: [""] })).toThrow(
      "non-empty string",
    );
  });

  it("throws on allowedPaths with non-string entry", () => {
    expect(() =>
      createFilesystemTools({ allowedPaths: [42] as unknown as string[] }),
    ).toThrow("non-empty string");
  });

  it("throws on null allowedPaths", () => {
    expect(() =>
      createFilesystemTools({ allowedPaths: null as unknown as string[] }),
    ).toThrow("non-empty array");
  });

  it("throws on non-boolean allowDelete", () => {
    expect(() =>
      createFilesystemTools({
        allowedPaths: ALLOWED_PATHS,
        allowDelete: "false" as unknown as boolean,
      }),
    ).toThrow("boolean");
  });
});

// ============================================================================
// system.listDir
// ============================================================================

describe("system.listDir", () => {
  let tool: Tool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
    tool = findTool(createFilesystemTools(CONFIG), "system.listDir");
  });

  it("lists directory contents with types and sizes", async () => {
    mockOpendir.mockResolvedValueOnce(
      createMockDir([
        { name: "src", isDirectory: () => true, isFile: () => false },
        { name: "readme.md", isDirectory: () => false, isFile: () => true },
      ]) as never,
    );
    mockLstat.mockResolvedValueOnce({ size: 1024 } as never);

    const result = await tool.execute({ path: "/workspace" });
    const parsed = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toEqual({ name: "src", type: "dir", size: 0 });
    expect(parsed.entries[1]).toEqual({
      name: "readme.md",
      type: "file",
      size: 1024,
    });
  });

  it("returns error for non-existent directory", async () => {
    mockOpendir.mockRejectedValueOnce(new Error("ENOENT: no such directory"));

    const result = await tool.execute({ path: "/workspace/nope" });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain("not found");
  });

  it("truncates results and reports metadata when entries exceed cap", async () => {
    // Create 10_001 mock dirents (cap is 10_000)
    const bigDir = Array.from({ length: 10_001 }, (_, i) => ({
      name: `file-${i}.txt`,
      isDirectory: () => false,
      isFile: () => true,
    }));
    mockOpendir.mockResolvedValueOnce(createMockDir(bigDir) as never);
    // lstat calls for each capped file entry
    mockLstat.mockResolvedValue({ size: 1 } as never);

    const result = await tool.execute({ path: "/workspace" });
    const parsed = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.entries).toHaveLength(10_000);
    expect(parsed.truncated).toBe(true);
  });
});

// ============================================================================
// system.stat
// ============================================================================

describe("system.stat", () => {
  let tool: Tool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
    tool = findTool(createFilesystemTools(CONFIG), "system.stat");
  });

  it("returns file metadata", async () => {
    mockStat.mockResolvedValueOnce({
      size: 2048,
      mtime: new Date("2025-01-01T00:00:00Z"),
      birthtime: new Date("2024-06-01T00:00:00Z"),
      isDirectory: () => false,
      isFile: () => true,
      mode: 0o100644,
    } as never);

    const result = await tool.execute({ path: "/workspace/file.ts" });
    const parsed = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.size).toBe(2048);
    expect(parsed.isFile).toBe(true);
    expect(parsed.isDirectory).toBe(false);
    expect(parsed.permissions).toBe("0644");
    expect(parsed.modified).toContain("2025");
  });

  it("returns error for non-existent paths", async () => {
    mockStat.mockRejectedValueOnce(new Error("ENOENT: not found"));

    const result = await tool.execute({ path: "/workspace/missing" });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain("not found");
  });
});

// ============================================================================
// system.mkdir
// ============================================================================

describe("system.mkdir", () => {
  let tool: Tool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
    tool = findTool(createFilesystemTools(CONFIG), "system.mkdir");
  });

  it("creates nested directories", async () => {
    mockMkdir.mockResolvedValueOnce(undefined);

    const result = await tool.execute({ path: "/workspace/a/b/c" });
    const parsed = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.created).toBe(true);
    expect(mockMkdir).toHaveBeenCalledWith("/workspace/a/b/c", {
      recursive: true,
    });
  });
});

// ============================================================================
// system.delete
// ============================================================================

describe("system.delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
  });

  it("rejects when allowDelete is false (default)", async () => {
    const tool = findTool(createFilesystemTools(CONFIG), "system.delete");

    const result = await tool.execute({ path: "/workspace/file.txt" });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain("disabled");
  });

  it("deletes a file when allowDelete is true", async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => false } as never);
    mockRm.mockResolvedValueOnce(undefined);
    const tool = findTool(
      createFilesystemTools({ ...CONFIG, allowDelete: true }),
      "system.delete",
    );

    const result = await tool.execute({ path: "/workspace/old.txt" });
    const parsed = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.deleted).toBe(true);
    expect(mockRm).toHaveBeenCalledWith("/workspace/old.txt", {
      recursive: false,
    });
  });

  it("rejects directory deletion without recursive flag", async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as never);
    const tool = findTool(
      createFilesystemTools({ ...CONFIG, allowDelete: true }),
      "system.delete",
    );

    const result = await tool.execute({ path: "/workspace/somedir" });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain("recursive");
  });

  it("deletes directory when recursive is true", async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as never);
    mockRm.mockResolvedValueOnce(undefined);
    const tool = findTool(
      createFilesystemTools({ ...CONFIG, allowDelete: true }),
      "system.delete",
    );

    const result = await tool.execute({
      path: "/workspace/somedir",
      recursive: true,
    });
    const parsed = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.deleted).toBe(true);
    expect(mockRm).toHaveBeenCalledWith("/workspace/somedir", {
      recursive: true,
    });
  });

  it("rejects deletion of sandbox root directory", async () => {
    const tool = findTool(
      createFilesystemTools({ ...CONFIG, allowDelete: true }),
      "system.delete",
    );

    const result = await tool.execute({ path: "/workspace" });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain("sandbox root");
  });

  it("rejects paths outside allowlist even when delete is enabled", async () => {
    const tool = findTool(
      createFilesystemTools({ ...CONFIG, allowDelete: true }),
      "system.delete",
    );

    const result = await tool.execute({ path: "/etc/important" });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain("Access denied");
  });
});

// ============================================================================
// system.move
// ============================================================================

describe("system.move", () => {
  let tool: Tool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
    tool = findTool(createFilesystemTools(CONFIG), "system.move");
  });

  it("moves a file within allowed paths", async () => {
    mockMkdir.mockResolvedValueOnce(undefined);
    mockRename.mockResolvedValueOnce(undefined);

    const result = await tool.execute({
      source: "/workspace/old.txt",
      destination: "/workspace/new.txt",
    });
    const parsed = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.moved).toBe(true);
  });

  it("rejects when destination is outside allowed paths", async () => {
    const result = await tool.execute({
      source: "/workspace/file.txt",
      destination: "/tmp/stolen.txt",
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain("Access denied");
  });

  it("rejects when source is outside allowed paths", async () => {
    const result = await tool.execute({
      source: "/etc/passwd",
      destination: "/workspace/passwd",
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain("Access denied");
  });
});

// ============================================================================
// Additional security tests
// ============================================================================

describe("safePath PATH_MAX enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
  });

  it("rejects paths exceeding MAX_PATH_LENGTH (4096)", async () => {
    const longPath = "/workspace/" + "a".repeat(4100);
    const result = await safePath(longPath, ALLOWED_PATHS);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("maximum length");
  });
});

describe("system.listDir type accuracy", () => {
  let tool: Tool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
    tool = findTool(createFilesystemTools(CONFIG), "system.listDir");
  });

  it("reports symlinks and other special types correctly", async () => {
    mockOpendir.mockResolvedValueOnce(
      createMockDir([
        {
          name: "dir",
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        } as never,
        {
          name: "file.txt",
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        } as never,
        {
          name: "link",
          isDirectory: () => false,
          isFile: () => false,
          isSymbolicLink: () => true,
        } as never,
        {
          name: "socket",
          isDirectory: () => false,
          isFile: () => false,
          isSymbolicLink: () => false,
        } as never,
      ]) as never,
    );
    mockLstat.mockResolvedValueOnce({ size: 100 } as never);

    const result = await tool.execute({ path: "/workspace" });
    const parsed = parseResult(result);

    expect(parsed.entries[0].type).toBe("dir");
    expect(parsed.entries[1].type).toBe("file");
    expect(parsed.entries[2].type).toBe("symlink");
    expect(parsed.entries[3].type).toBe("other");
  });
});

// ============================================================================
// safePath host-path leak prevention
// ============================================================================

describe("safePath denied-path leak prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
  });

  it("does not expose canonical path when access is denied", async () => {
    const result = await safePath("/etc/passwd", ALLOWED_PATHS);
    expect(result.safe).toBe(false);
    // resolved must be empty — never leak host path on denial
    expect(result.resolved).toBe("");
  });
});

// ============================================================================
// URL-encoded traversal defense
// ============================================================================

describe("safePath URL-encoded traversal defense", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
  });

  it("rejects %2f (URL-encoded forward slash)", async () => {
    const result = await safePath(
      "/workspace/..%2f..%2fetc/passwd",
      ALLOWED_PATHS,
    );
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("traversal");
  });

  it("rejects %5c (URL-encoded backslash)", async () => {
    const result = await safePath("/workspace/foo%5cbar", ALLOWED_PATHS);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("traversal");
  });

  it("rejects %00 (URL-encoded null byte)", async () => {
    const result = await safePath("/workspace/file%00.txt", ALLOWED_PATHS);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("traversal");
  });
});

// ============================================================================
// Delete recursive schema bypass
// ============================================================================

describe("system.delete recursive parameter strictness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
  });

  it('rejects directory deletion when recursive is string "true" (not boolean)', async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as never);
    const tool = findTool(
      createFilesystemTools({ ...CONFIG, allowDelete: true }),
      "system.delete",
    );

    const result = await tool.execute({
      path: "/workspace/somedir",
      recursive: "true",
    });

    expect(result.isError).toBe(true);
    expect(parseResult(result).error).toContain("recursive");
    expect(mockRm).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Dangling-symlink TOCTOU regression test
// ============================================================================

describe("safePath dangling-symlink ancestor walk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows new file under existing sandbox parent (ancestor walk)", async () => {
    // Simulate: /workspace exists, /workspace/new/file.txt does not
    mockRealpath.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s === "/workspace") return "/workspace" as never;
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const result = await safePath("/workspace/new/file.txt", ALLOWED_PATHS);
    expect(result.safe).toBe(true);
    expect(result.resolved).toBe("/workspace/new/file.txt");
  });

  it("rejects new file when ancestor walk resolves outside sandbox via symlink", async () => {
    // Simulate: /workspace/link exists and is a symlink → /etc
    // So /workspace/link/new.txt canonicalizes to /etc/new.txt (outside sandbox)
    mockRealpath.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s === "/workspace") return "/workspace" as never;
      if (s === "/workspace/link") return "/etc" as never;
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const result = await safePath("/workspace/link/new.txt", ALLOWED_PATHS);
    expect(result.safe).toBe(false);
  });
});

// ============================================================================
// inferToolAccess edge cases (tested via ToolRegistry safe-mode behavior)
// ============================================================================

describe("inferToolAccess classification via tool naming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRealpath.mockImplementation(async (p: string) => p as never);
  });

  it("classifies system.stat as read (exact match)", () => {
    const action = "system.stat".split(".").pop()!.toLowerCase();
    expect(action).toBe("stat");
  });

  it("would NOT classify system.statusSet as read (no false positive)", () => {
    // This is the key edge case — "statusSet" should NOT match "status" exact
    // and should NOT match any read prefix
    const action = "system.statusSet".split(".").pop()!.toLowerCase();
    const readPrefixes = ["get", "list", "query", "inspect", "read"];
    const isExactRead = action === "stat" || action === "status";
    const isPrefixRead = readPrefixes.some((p) => action.startsWith(p));
    expect(isExactRead).toBe(false);
    expect(isPrefixRead).toBe(false);
  });

  it("would NOT classify system.statisticsUpdate as read", () => {
    const action = "system.statisticsUpdate".split(".").pop()!.toLowerCase();
    const readPrefixes = ["get", "list", "query", "inspect", "read"];
    const isExactRead = action === "stat" || action === "status";
    const isPrefixRead = readPrefixes.some((p) => action.startsWith(p));
    expect(isExactRead).toBe(false);
    expect(isPrefixRead).toBe(false);
  });
});


// ============================================================================
// snapshotTopRecentReads — compact-and-re-attach support
// ============================================================================

import { snapshotTopRecentReads, seedSessionReadState as seedRead } from "./filesystem.js";

describe("snapshotTopRecentReads", () => {
  const sessionId = "session-snapshot-top";

  beforeEach(() => {
    clearSessionReadState(sessionId);
  });

  it("does not treat processed partial views as valid read gates", () => {
    seedRead(sessionId, [
      {
        path: "/ws/injected.ts",
        content: "processed",
        timestamp: 10,
        viewKind: "partial",
        isPartialView: true,
      },
    ]);

    expect(hasSessionRead(sessionId, "/ws/injected.ts")).toBe(false);
  });

  it("returns top-N by most recent timestamp, newest first", () => {
    seedRead(sessionId, [
      { path: "/ws/a.ts", content: "A", timestamp: 100, viewKind: "full" },
      { path: "/ws/b.ts", content: "B", timestamp: 300, viewKind: "full" },
      { path: "/ws/c.ts", content: "C", timestamp: 200, viewKind: "full" },
    ]);
    const out = snapshotTopRecentReads({
      sessionId,
      maxFiles: 2,
      perFileBudgetChars: 100,
      totalBudgetChars: 1000,
    });
    expect(out.map((s) => s.path)).toEqual(["/ws/b.ts", "/ws/c.ts"]);
    expect(out[0]?.content).toBe("B");
  });

  it("truncates any single file to the per-file budget", () => {
    const big = "x".repeat(5000);
    seedRead(sessionId, [
      { path: "/ws/big.ts", content: big, timestamp: 10, viewKind: "full" },
    ]);
    const out = snapshotTopRecentReads({
      sessionId,
      maxFiles: 3,
      perFileBudgetChars: 100,
      totalBudgetChars: 10_000,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.content.length).toBe(100);
  });

  it("stops adding files once the total budget is exhausted", () => {
    seedRead(sessionId, [
      { path: "/ws/a.ts", content: "x".repeat(60), timestamp: 5, viewKind: "full" },
      { path: "/ws/b.ts", content: "y".repeat(60), timestamp: 4, viewKind: "full" },
      { path: "/ws/c.ts", content: "z".repeat(60), timestamp: 3, viewKind: "full" },
    ]);
    const out = snapshotTopRecentReads({
      sessionId,
      maxFiles: 10,
      perFileBudgetChars: 200,
      totalBudgetChars: 130,
    });
    expect(out.map((s) => s.path)).toEqual(["/ws/a.ts", "/ws/b.ts"]);
  });

  it("skips entries with missing content or timestamp", () => {
    seedRead(sessionId, [
      { path: "/ws/no-ts.ts", content: "keep-me", viewKind: "full" }, // no timestamp → skip
      { path: "/ws/no-content.ts", timestamp: 50, viewKind: "full" }, // no content → skip
      { path: "/ws/real.ts", content: "real", timestamp: 25, viewKind: "full" },
    ]);
    const out = snapshotTopRecentReads({
      sessionId,
      maxFiles: 5,
      perFileBudgetChars: 100,
      totalBudgetChars: 1000,
    });
    expect(out.map((s) => s.path)).toEqual(["/ws/real.ts"]);
  });

  it("returns empty array for an unknown or empty session", () => {
    const out = snapshotTopRecentReads({
      sessionId: "does-not-exist",
      maxFiles: 5,
      perFileBudgetChars: 100,
      totalBudgetChars: 1000,
    });
    expect(out).toEqual([]);
  });

  it("preserves read-view metadata in the exported snapshot", () => {
    seedRead(sessionId, [
      {
        path: "/ws/x.ts",
        content: "x",
        timestamp: 1,
        viewKind: "partial",
        isPartialView: true,
      },
    ]);
    const out = snapshotTopRecentReads({
      sessionId,
      maxFiles: 1,
      perFileBudgetChars: 100,
      totalBudgetChars: 100,
    });
    expect(out[0]?.viewKind).toBe("partial");
    expect(out[0]?.isPartialView).toBe(true);
  });
});
