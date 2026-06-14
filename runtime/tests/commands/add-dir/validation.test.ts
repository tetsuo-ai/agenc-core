import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// validation.ts → filesystem.ts → utils chain hits bun:bundle's feature()
// gate. Stub it before the dynamic import so the test-only path resolves.
vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
vi.mock("../../tools.js", () => ({
  getAllTools: () => [],
  getDefaultTools: () => [],
}));

const { addDirHelpMessage, validateDirectoryForWorkspace } = await import(
  "./validation.js"
);
import type { ToolPermissionContext } from "../../tools/Tool.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "agenc-add-dir-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const stubPermissionContext = (): ToolPermissionContext =>
  ({
    cwd: "/nonexistent-host-cwd-for-test",
    additionalWorkingDirectories: new Set<string>(),
  }) as never;

describe("validateDirectoryForWorkspace", () => {
  it("rejects an empty path", async () => {
    const result = await validateDirectoryForWorkspace("", stubPermissionContext());
    expect(result.resultType).toBe("emptyPath");
  });

  it("rejects a path that does not exist", async () => {
    const result = await validateDirectoryForWorkspace(
      path.join(tmpRoot, "does-not-exist"),
      stubPermissionContext(),
    );
    expect(result.resultType).toBe("pathNotFound");
  });

  it("rejects a path that is a file, not a directory", async () => {
    const filePath = path.join(tmpRoot, "a-file.txt");
    writeFileSync(filePath, "hi", "utf8");
    const result = await validateDirectoryForWorkspace(
      filePath,
      stubPermissionContext(),
    );
    expect(result.resultType).toBe("notADirectory");
  });

  it("accepts a real directory", async () => {
    const result = await validateDirectoryForWorkspace(
      tmpRoot,
      stubPermissionContext(),
    );
    expect(result.resultType).toBe("success");
    if (result.resultType === "success") {
      expect(path.resolve(result.absolutePath)).toBe(path.resolve(tmpRoot));
    }
  });

  it("strips the trailing slash on the absolutePath", async () => {
    const trailing = `${tmpRoot}/`;
    const result = await validateDirectoryForWorkspace(
      trailing,
      stubPermissionContext(),
    );
    expect(result.resultType).toBe("success");
    if (result.resultType === "success") {
      expect(result.absolutePath.endsWith("/")).toBe(false);
    }
  });
});

describe("addDirHelpMessage", () => {
  it("formats the empty-path case", () => {
    expect(addDirHelpMessage({ resultType: "emptyPath" })).toContain(
      "directory path",
    );
  });

  it("formats the not-found case with the absolute path", () => {
    expect(
      addDirHelpMessage({
        resultType: "pathNotFound",
        directoryPath: "/missing",
        absolutePath: "/missing",
      }),
    ).toContain("/missing");
  });

  it("formats the not-a-directory case with a parent-dir hint", () => {
    expect(
      addDirHelpMessage({
        resultType: "notADirectory",
        directoryPath: "/etc/hosts",
        absolutePath: "/etc/hosts",
      }),
    ).toContain("parent directory");
  });

  it("formats the already-in-workspace case", () => {
    expect(
      addDirHelpMessage({
        resultType: "alreadyInWorkingDirectory",
        directoryPath: "/foo/sub",
        workingDir: "/foo",
      }),
    ).toContain("already accessible");
  });

  it("formats the success case with 'Added'", () => {
    expect(
      addDirHelpMessage({
        resultType: "success",
        absolutePath: "/usr/local/proj",
      }),
    ).toMatch(/^Added/);
  });
});
