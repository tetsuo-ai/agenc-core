import { beforeEach, describe, expect, test, vi } from "vitest";

import type { Platform } from "../../src/utils/platform.js";

const platform = vi.hoisted(() => ({ value: "linux" as Platform }));

vi.mock("../../src/utils/platform.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/utils/platform.js")>(),
  getPlatform: () => platform.value,
}));

import {
  checkProtectedPathSafety,
  hasSuspiciousWindowsPathPattern,
  isDangerousFilePathToAutoEdit,
} from "../../src/permissions/protected-paths.js";

beforeEach(() => {
  platform.value = "linux";
});

describe("isDangerousFilePathToAutoEdit", () => {
  test("protects the original roots and the later classifier directories", () => {
    expect(isDangerousFilePathToAutoEdit("/tmp/project/.git/config")).toBe(true);
    expect(isDangerousFilePathToAutoEdit("/tmp/project/.agenc/config.toml")).toBe(true);
    expect(isDangerousFilePathToAutoEdit("/tmp/project/.agents/skills/review/SKILL.md")).toBe(true);
    expect(isDangerousFilePathToAutoEdit("/tmp/project/.vscode/settings.json")).toBe(true);
    expect(isDangerousFilePathToAutoEdit("/tmp/project/.idea/workspace.xml")).toBe(true);
  });

  test("mixed-case segments still match", () => {
    expect(isDangerousFilePathToAutoEdit("/tmp/project/.GiT/config")).toBe(true);
    expect(isDangerousFilePathToAutoEdit("/tmp/project/.AGENTs/skills/x.md")).toBe(true);
    expect(isDangerousFilePathToAutoEdit("/tmp/home/.Zshrc")).toBe(true);
  });

  test("the documented .agenc children stay ordinary", () => {
    expect(isDangerousFilePathToAutoEdit("/tmp/project/.agenc/commands/review.md")).toBe(false);
    expect(isDangerousFilePathToAutoEdit("/tmp/project/.agenc/worktrees/x/file.ts")).toBe(false);
    expect(isDangerousFilePathToAutoEdit("/tmp/project/.agenc/Commands/review.md")).toBe(false);
    expect(isDangerousFilePathToAutoEdit("/tmp/project/.agenc/config.toml")).toBe(true);
    expect(isDangerousFilePathToAutoEdit("/tmp/project/.agenc")).toBe(true);
  });

  test("shell and git config filenames are dangerous even outside a protected directory", () => {
    expect(isDangerousFilePathToAutoEdit("/tmp/home/.bashrc")).toBe(true);
    expect(isDangerousFilePathToAutoEdit("/tmp/home/.gitconfig")).toBe(true);
    expect(isDangerousFilePathToAutoEdit("/tmp/home/.ripgreprc")).toBe(true);
    expect(isDangerousFilePathToAutoEdit("/tmp/project/src/app.ts")).toBe(false);
  });

  test("UNC spellings are always treated as dangerous", () => {
    expect(isDangerousFilePathToAutoEdit("\\\\server\\share\\file")).toBe(true);
    expect(isDangerousFilePathToAutoEdit("//server/share/file")).toBe(true);
  });
});

describe("hasSuspiciousWindowsPathPattern", () => {
  test("8.3, trailing junk, device names, and NT prefixes are suspicious on every host", () => {
    expect(hasSuspiciousWindowsPathPattern("/tmp/GIT~1/config")).toBe(true);
    expect(hasSuspiciousWindowsPathPattern("/tmp/settings.json.")).toBe(true);
    expect(hasSuspiciousWindowsPathPattern("/tmp/settings.json ")).toBe(true);
    expect(hasSuspiciousWindowsPathPattern("/tmp/settings.json.CON")).toBe(true);
    expect(hasSuspiciousWindowsPathPattern("/tmp/notes.NUL")).toBe(true);
    expect(hasSuspiciousWindowsPathPattern("\\\\?\\C:\\Users\\x")).toBe(true);
    expect(hasSuspiciousWindowsPathPattern("//./C:/Windows")).toBe(true);
    expect(hasSuspiciousWindowsPathPattern("/tmp/foo/.../bar")).toBe(true);
    expect(hasSuspiciousWindowsPathPattern("/tmp/src/app.ts")).toBe(false);
  });

  test("ADS colon syntax is Windows/WSL-only", () => {
    expect(hasSuspiciousWindowsPathPattern("C:\\tmp\\file:stream")).toBe(false);
    platform.value = "windows";
    expect(hasSuspiciousWindowsPathPattern("C:\\tmp\\file:stream")).toBe(true);
    platform.value = "wsl";
    expect(hasSuspiciousWindowsPathPattern("C:\\tmp\\file:stream")).toBe(true);
    expect(hasSuspiciousWindowsPathPattern("C:\\tmp\\plain.txt")).toBe(false);
  });
});

describe("checkProtectedPathSafety", () => {
  test("an ordinary path is safe", () => {
    expect(checkProtectedPathSafety("/tmp/src/app.ts", ["/tmp/src/app.ts"])).toEqual({
      safe: true,
    });
  });

  test(".vscode stays classifier-approvable until a stronger root is also present", () => {
    expect(checkProtectedPathSafety(
      "/tmp/project/.vscode/settings.json",
      ["/tmp/project/.vscode/settings.json"],
    )).toMatchObject({ safe: false, classifierApprovable: true });

    expect(checkProtectedPathSafety(
      "/tmp/project/.vscode/settings.json",
      [
        "/tmp/project/.vscode/settings.json",
        "/tmp/project/.git/config",
      ],
    )).toMatchObject({ safe: false, classifierApprovable: false });
  });

  test("the original roots stay explicit-user-only", () => {
    for (const path of [
      "/tmp/project/.git/config",
      "/tmp/project/.agenc/config.toml",
      "/tmp/project/.agents/skills/review/SKILL.md",
    ]) {
      expect(checkProtectedPathSafety(path, [path]), path).toMatchObject({
        safe: false,
        classifierApprovable: false,
      });
    }
  });

  test("a suspicious spelling wins even when the alias is only classifier-eligible", () => {
    expect(checkProtectedPathSafety(
      "/tmp/project/.vscode/settings.json",
      ["/tmp/project/.vscode/settings.json", "/tmp/GIT~1/config"],
    )).toMatchObject({ safe: false, classifierApprovable: false });
  });

  test(".agenc commands and worktrees are not classified as dangerous", () => {
    expect(checkProtectedPathSafety(
      "/tmp/project/.agenc/commands/review.md",
      ["/tmp/project/.agenc/commands/review.md"],
    )).toEqual({ safe: true });
  });
});
