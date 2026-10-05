import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getProjectRoot, setProjectRoot } from "../../src/bootstrap/state.js";
import { ConfigStore } from "../../src/config/store.js";
import { getAutoMemPath, getGlobalMemoryPath } from "../../src/memory/paths.js";
import { isDurableMemoryWritePath } from "../../src/permissions/path-validation.js";
import {
  resolveAgentRuntimeOptions,
  runWithAgentRuntimeOptions,
} from "../../src/session/runtime-options.js";
import {
  enterCanonicalSettingsAuthority,
  resetCanonicalSettingsAuthorityForTesting,
} from "../../src/utils/settings/canonicalAuthority.js";

/**
 * Permission admission and the workspace_write sandbox both consult this
 * predicate. A mismatch is what made durable memory unusable under the
 * default sandbox while a shell redirect still wrote there.
 */
let root: string;
let cwd: string;
let home: string;
let previousAgencHome: string | undefined;
let previousOverride: string | undefined;
let previousProjectRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "agenc-durable-memory-path-"));
  cwd = join(root, "project");
  home = join(root, "home");
  mkdirSync(cwd);
  mkdirSync(home);
  previousAgencHome = process.env.AGENC_HOME;
  previousOverride = process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE;
  process.env.AGENC_HOME = home;
  delete process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE;
  previousProjectRoot = getProjectRoot();
  setProjectRoot(cwd);
  enterCanonicalSettingsAuthority(
    new ConfigStore({
      home,
      env: { AGENC_HOME: home },
      cwd,
    }),
  );
});

afterEach(() => {
  setProjectRoot(previousProjectRoot);
  if (previousAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = previousAgencHome;
  if (previousOverride === undefined) {
    delete process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE;
  } else {
    process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE = previousOverride;
  }
  resetCanonicalSettingsAuthorityForTesting();
  rmSync(root, { recursive: true, force: true });
});

describe("isDurableMemoryWritePath", () => {
  it("admits only the two durable memory roots while auto-memory is on", () => {
    expect(
      isDurableMemoryWritePath(join(getGlobalMemoryPath(), "indentation.md")),
    ).toBe(true);
    expect(
      isDurableMemoryWritePath(join(getAutoMemPath(), "project-note.md")),
    ).toBe(true);
    expect(isDurableMemoryWritePath(join(home, "config.toml"))).toBe(false);
    expect(isDurableMemoryWritePath(join(cwd, "README.md"))).toBe(false);
  });

  it("fails closed when auto-memory is off, an SDK override is set, or a symlink leaves the root", async () => {
    const disabled = new ConfigStore({
      home,
      cwd,
      cliOverrides: { autoMemoryEnabled: false },
    });
    await disabled.reload();
    enterCanonicalSettingsAuthority(disabled);
    expect(
      isDurableMemoryWritePath(join(getGlobalMemoryPath(), "indentation.md")),
    ).toBe(false);

    enterCanonicalSettingsAuthority(
      new ConfigStore({
        home,
        env: { AGENC_HOME: home },
        cwd,
      }),
    );
    const override = join(root, "override", "memory") + sep;
    process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE = override;
    runWithAgentRuntimeOptions(resolveAgentRuntimeOptions(process.env), () => {
      expect(
        isDurableMemoryWritePath(join(getGlobalMemoryPath(), "indentation.md")),
      ).toBe(false);
    });
    delete process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE;

    const memoryDir = getGlobalMemoryPath();
    mkdirSync(memoryDir, { recursive: true });
    const escape = join(memoryDir, "escape");
    symlinkSync(cwd, escape);
    expect(isDurableMemoryWritePath(join(escape, "other.md"))).toBe(false);
  });
});
