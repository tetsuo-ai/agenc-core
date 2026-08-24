import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getProjectRoot,
  setProjectRoot,
} from "../bootstrap/state.js";
import { ConfigStore } from "../config/store.js";
import {
  enterCanonicalSettingsAuthority,
  resetCanonicalSettingsAuthorityForTesting,
} from "../utils/settings/canonicalAuthority.js";
import {
  resolveAgentRuntimeOptions,
  runWithAgentRuntimeOptions,
} from "../session/runtime-options.js";
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
let oldAgencHome: string | undefined;
let oldRemoteMemoryDir: string | undefined;
let oldPathOverride: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "agenc-memory-paths-"));
  oldProjectRoot = getProjectRoot();
  oldAgencHome = process.env.AGENC_HOME;
  oldRemoteMemoryDir = process.env.AGENC_REMOTE_MEMORY_DIR;
  oldPathOverride = process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE;
  process.env.AGENC_HOME = join(tempRoot, "home");
  delete process.env.AGENC_REMOTE_MEMORY_DIR;
  delete process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE;
  setProjectRoot(join(tempRoot, "repo"));
  enterCanonicalSettingsAuthority(new ConfigStore({
    home: join(tempRoot, "home"),
    env: { ...process.env },
    cwd: join(tempRoot, "repo"),
  }));
  clearPathCaches();
});

afterEach(() => {
  setProjectRoot(oldProjectRoot);
  if (oldAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = oldAgencHome;
  if (oldRemoteMemoryDir === undefined) delete process.env.AGENC_REMOTE_MEMORY_DIR;
  else process.env.AGENC_REMOTE_MEMORY_DIR = oldRemoteMemoryDir;
  if (oldPathOverride === undefined) delete process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE;
  else process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE = oldPathOverride;
  resetCanonicalSettingsAuthorityForTesting();
  clearPathCaches();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("memory paths", () => {
  it("resolves D-13 global and project memory layers", () => {
    installMemoryAuthority();
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
    installMemoryAuthority();
    process.env.AGENC_REMOTE_MEMORY_DIR = join(tempRoot, "remote-memory");
    clearPathCaches();
    runWithAgentRuntimeOptions(resolveAgentRuntimeOptions(process.env), () => {
      expect(getMemoryBaseDir()).toBe(join(tempRoot, "remote-memory"));
      expect(getProjectMemoryPath()).toContain(
        `${join(tempRoot, "remote-memory", "projects")}${sep}`,
      );
      expect(getProjectMemoryPath()).toBe(getAutoMemPath());
    });
  });

  it("honors full-path env overrides and rejects unsafe roots", () => {
    installMemoryAuthority();
    const override = join(tempRoot, "override", "memory") + sep;
    process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE = override;
    clearPathCaches();
    runWithAgentRuntimeOptions(resolveAgentRuntimeOptions(process.env), () => {
      expect(hasAutoMemPathOverride()).toBe(true);
      expect(getProjectMemoryPath()).toBe(override);
    });

    process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE = "/";
    clearPathCaches();
    runWithAgentRuntimeOptions(resolveAgentRuntimeOptions(process.env), () => {
      expect(hasAutoMemPathOverride()).toBe(false);
      expect(getProjectMemoryPath()).not.toBe("/");
    });
  });

  it("honors canonical flag config directory overrides", async () => {
    installMemoryAuthority();
    const override = join(tempRoot, "settings-memory");
    const flagConfigPath = join(tempRoot, "flag.toml");
    mkdirSync(join(tempRoot, "home"), { recursive: true });
    writeFileSync(
      flagConfigPath,
      `config_version = 2\nautoMemoryDirectory = ${JSON.stringify(override)}\n`,
    );
    const configStore = new ConfigStore({
      home: join(tempRoot, "home"),
      cwd: join(tempRoot, "repo"),
      projectRoot: join(tempRoot, "repo"),
      projectTrusted: true,
      flagConfigPath,
      managedConfigPath: join(tempRoot, "missing-managed.toml"),
      managedDropInDir: join(tempRoot, "missing-managed.d"),
      env: { ...process.env, AGENC_HOME: join(tempRoot, "home") },
    });
    await configStore.reload();
    clearPathCaches();
    expect(getProjectMemoryPath()).toBe(override + sep);
  });
});

function installMemoryAuthority(): void {
  enterCanonicalSettingsAuthority(new ConfigStore({
    home: join(tempRoot, "home"),
    env: { ...process.env, AGENC_HOME: join(tempRoot, "home") },
    cwd: join(tempRoot, "repo"),
  }));
}

function clearPathCaches(): void {
  getProjectMemoryPath.cache?.clear?.();
  getAutoMemPath.cache?.clear?.();
}
