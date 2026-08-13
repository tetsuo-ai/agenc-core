import { describe, expect, it } from "vitest";

import {
  clearBuiltinPlugins,
  getBuiltinPlugins,
} from "../../src/plugins/builtinPlugins.js";
import {
  getBuiltinPluginSkillCommands,
  initBuiltinPlugins,
  resetBuiltinPluginInit,
} from "../../src/plugins/builtin/index.js";
import {
  readSkillReferenceFiles,
  resolveShippedPluginDir,
} from "../../src/plugins/builtin/repositoryPluginSkill.js";

/**
 * zeroday-hunter ships in the repo but never loaded: `plugins.enabled` gates
 * auto-discovery and defaults to false, and the built-in registry — the path
 * that bypasses that gate — had no caller at all.
 *
 * The gate stays off. These plugins are enabled because they ship inside the
 * runtime package, which a third-party repository cannot forge.
 */
describe("plugins shipped in the runtime package", () => {
  it("resolves zeroday-hunter from the package, not the workspace", () => {
    const dir = resolveShippedPluginDir("zeroday-hunter");
    expect(dir).not.toBeNull();
    expect(dir).toMatch(/plugins[/\\]zeroday-hunter$/u);
  });

  it("registers it and offers its skill", () => {
    clearBuiltinPlugins();
    resetBuiltinPluginInit();

    const commands = getBuiltinPluginSkillCommands();
    const skill = commands.find((c) => c.name === "zeroday-hunter");

    expect(skill).toBeDefined();
    expect(skill?.userInvocable).toBe(true);
    // 'bundled', not 'builtin': 'builtin' means a hardcoded slash command and
    // would drop the skill from the Skill tool's listing.
    expect(skill?.source).toBe("bundled");
    expect(skill?.whenToUse).toMatch(/vulnerabilit|0-day/iu);
  });

  it("is enabled by default, with no [plugins] config present", () => {
    clearBuiltinPlugins();
    resetBuiltinPluginInit();
    initBuiltinPlugins();

    const { enabled, disabled } = getBuiltinPlugins();
    expect(enabled.map((p) => p.name)).toContain("zeroday-hunter");
    expect(disabled.map((p) => p.name)).not.toContain("zeroday-hunter");
    expect(enabled.find((p) => p.name === "zeroday-hunter")?.isBuiltin).toBe(
      true,
    );
  });

  it("registering twice does not duplicate the skill", () => {
    clearBuiltinPlugins();
    resetBuiltinPluginInit();

    initBuiltinPlugins();
    initBuiltinPlugins();

    const names = getBuiltinPluginSkillCommands().map((c) => c.name);
    expect(names.filter((n) => n === "zeroday-hunter")).toHaveLength(1);
  });

  it("carries the skill's reference files for on-demand reading", () => {
    const dir = resolveShippedPluginDir("zeroday-hunter")!;
    const files = readSkillReferenceFiles(`${dir}/skills/zeroday-hunter`);
    const keys = Object.keys(files);

    expect(keys.length).toBeGreaterThan(0);
    // Relative, forward-slashed, no traversal — the bundled-skill file
    // contract, since these are extracted to disk on first invocation.
    for (const key of keys) {
      expect(key).toMatch(/^references\//u);
      expect(key).not.toContain("..");
      expect(key).not.toContain("\\");
      expect(files[key]!.length).toBeGreaterThan(0);
    }
  });
});
