import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getFlagSettingsInline,
  getProjectRoot,
  setFlagSettingsInline,
  setProjectRoot,
} from "../bootstrap/state.js";
import { resetSettingsCache } from "../utils/settings/settingsCache.js";
import {
  getAutoMemEntrypoint,
  getAutoMemPath,
  getGlobalMemoryEntrypoint,
  getGlobalMemoryPath,
  getMemoryBaseDir,
  getProjectInstructionPath,
  getProjectMemoryEntrypoint,
  getProjectMemoryPath,
  hasAutoMemPathOverride,
  isDurableMemoryPath,
  isGlobalMemoryPath,
  isProjectMemoryPath,
} from "./paths.js";

let tempRoot = "";
let oldProjectRoot = "";
let oldConfigDir: string | undefined;
let oldRemoteMemoryDir: string | undefined;
let oldPathOverride: string | undefined;
let oldFlagSettings: Record<string, unknown> | null;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "agenc-memory-paths-"));
  oldProjectRoot = getProjectRoot();
  oldConfigDir = process.env.AGENC_CONFIG_DIR;
  oldRemoteMemoryDir = process.env.AGENC_REMOTE_MEMORY_DIR;
  oldPathOverride = process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE;
  oldFlagSettings = getFlagSettingsInline();
  process.env.AGENC_CONFIG_DIR = join(tempRoot, "home");
  delete process.env.AGENC_REMOTE_MEMORY_DIR;
  delete process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE;
  setFlagSettingsInline(null);
  setProjectRoot(join(tempRoot, "repo"));
  clearPathCaches();
});

afterEach(() => {
  setProjectRoot(oldProjectRoot);
  if (oldConfigDir === undefined) delete process.env.AGENC_CONFIG_DIR;
  else process.env.AGENC_CONFIG_DIR = oldConfigDir;
  if (oldRemoteMemoryDir === undefined) delete process.env.AGENC_REMOTE_MEMORY_DIR;
  else process.env.AGENC_REMOTE_MEMORY_DIR = oldRemoteMemoryDir;
  if (oldPathOverride === undefined) delete process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE;
  else process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE = oldPathOverride;
  setFlagSettingsInline(oldFlagSettings);
  resetSettingsCache();
  clearPathCaches();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("memory paths", () => {
  it("resolves D-13 global and project memory layers", () => {
    expect(getMemoryBaseDir()).toBe(join(tempRoot, "home"));
    expect(getGlobalMemoryPath()).toBe(join(tempRoot, "home", "memory") + sep);
    expect(getGlobalMemoryEntrypoint()).toBe(
      join(tempRoot, "home", "memory", "MEMORY.md"),
    );
    expect(getProjectMemoryPath()).toBe(
      join(tempRoot, "repo", ".agenc", "memory") + sep,
    );
    expect(getProjectMemoryEntrypoint()).toBe(
      join(tempRoot, "repo", ".agenc", "memory", "MEMORY.md"),
    );
    expect(getProjectInstructionPath()).toBe(join(tempRoot, "repo", "AGENC.md"));
    expect(getAutoMemPath()).toBe(getProjectMemoryPath());
    expect(getAutoMemEntrypoint()).toBe(getProjectMemoryEntrypoint());
    expect(isGlobalMemoryPath(join(tempRoot, "home", "memory", "note.md"))).toBe(true);
    expect(isProjectMemoryPath(join(tempRoot, "repo", ".agenc", "memory", "note.md"))).toBe(true);
    expect(isDurableMemoryPath(join(tempRoot, "home", "memory", "note.md"))).toBe(true);
    expect(isDurableMemoryPath(join(tempRoot, "repo", ".agenc", "memory", "note.md"))).toBe(true);
  });

  it("uses the remote memory base for project compatibility paths", () => {
    process.env.AGENC_REMOTE_MEMORY_DIR = join(tempRoot, "remote-memory");
    clearPathCaches();
    expect(getMemoryBaseDir()).toBe(join(tempRoot, "remote-memory"));
    expect(getProjectMemoryPath()).toContain(
      `${join(tempRoot, "remote-memory", "projects")}${sep}`,
    );
    expect(getProjectMemoryPath()).toBe(getAutoMemPath());
  });

  it("honors full-path env overrides and rejects unsafe roots", () => {
    const override = join(tempRoot, "override", "memory") + sep;
    process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE = override;
    clearPathCaches();
    expect(hasAutoMemPathOverride()).toBe(true);
    expect(getProjectMemoryPath()).toBe(override);

    process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE = "/";
    clearPathCaches();
    expect(hasAutoMemPathOverride()).toBe(false);
    expect(getProjectMemoryPath()).not.toBe("/");
  });

  it("honors trusted flag setting directory overrides", () => {
    const override = join(tempRoot, "settings-memory");
    setFlagSettingsInline({ autoMemoryDirectory: override });
    resetSettingsCache();
    clearPathCaches();
    expect(getProjectMemoryPath()).toBe(override + sep);
  });
});

function clearPathCaches(): void {
  getProjectMemoryPath.cache?.clear?.();
  getAutoMemPath.cache?.clear?.();
}
