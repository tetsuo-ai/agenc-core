import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildSkillListingWithinBudget,
  createLocalSkillsServices,
  loadLocalSkillsSnapshot,
} from "./local-loader.js";

/**
 * Temp dirs named so that plain path order disagrees with the precedence
 * rule: the workspace sorts before the home directory, and the workspace
 * root sorts before its nested package. Under the old "first by path" pick
 * each of these cases resolved to the other skill.
 */
function tmpRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `agenc-${label}-`));
}

function writeSkill(root: string, name: string, description: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, `---\ndescription: ${description}\n---\nBody of ${description}\n`);
  return file;
}

function writePluginSkill(pluginRoot: string, name: string, description: string): string {
  mkdirSync(join(pluginRoot, ".agenc-plugin"), { recursive: true });
  writeFileSync(
    join(pluginRoot, ".agenc-plugin", "plugin.json"),
    JSON.stringify({ name: basename(pluginRoot), version: "1.0.0" }),
  );
  return writeSkill(join(pluginRoot, "skills"), name, description);
}

function fixture() {
  const home = tmpRoot("zz-home");
  const agencHome = join(home, ".agenc");
  const workspaceRoot = tmpRoot("aa-workspace");
  return {
    home,
    agencHome,
    workspaceRoot,
    options: {
      agencHome,
      pluginStorageRoot: join(agencHome, "plugins"),
      workspaceRoot,
      env: { HOME: home },
    },
  };
}

describe("one skill per name", () => {
  it("lists and loads one skill for a name defined in two roots, and says which lost", async () => {
    const f = fixture();
    const agencFile = writeSkill(join(f.agencHome, "skills"), "dup", "from the AgenC home");
    const sharedFile = writeSkill(join(f.home, ".agents", "skills"), "dup", "from the shared catalog");
    const snapshot = await loadLocalSkillsSnapshot(f.options);

    const dups = snapshot.skills.filter((skill) => skill.name === "dup");
    expect(dups).toHaveLength(1);
    expect(dups[0]?.path).toBe(agencFile);
    const { listing } = buildSkillListingWithinBudget(snapshot.skills);
    expect(listing.match(/^- dup: /gmu)).toHaveLength(1);
    expect(snapshot.warnings).toContainEqual({
      path: sharedFile,
      reason: `not loaded: ${agencFile} defines a skill with the same name ("dup") and takes precedence`,
    });
  });

  it("prefers the user's skill over a repository's skill of the same name", async () => {
    const f = fixture();
    const userFile = writeSkill(join(f.home, ".agents", "skills"), "deploy", "the user's deploy");
    const projectFile = writeSkill(join(f.workspaceRoot, ".agents", "skills"), "deploy", "the repository's deploy");
    const services = createLocalSkillsServices(f.options);

    await expect(services.skillsManager.resolveSkill?.("deploy"))
      .resolves.toMatchObject({ path: userFile, scope: "user" });
    await expect(services.skillsManager.renderSkill?.({ name: "deploy" }))
      .resolves.toMatchObject({ content: expect.stringContaining("the user's deploy") });
    const outcome = await services.skillsManager.skillsForConfig({}, null);
    expect(outcome.availableSkills?.filter((skill) => skill.name === "deploy")).toHaveLength(1);
    expect(outcome.skillLoadWarnings).toContainEqual({
      path: projectFile,
      reason: `not loaded: ${userFile} defines a skill with the same name ("deploy") and takes precedence`,
    });
  });

  it("prefers the user's skill over a plugin's skill of the same name", async () => {
    const f = fixture();
    const userFile = writeSkill(join(f.agencHome, "skills"), "chart", "the user's chart");
    const pluginFile = writePluginSkill(join(f.agencHome, "plugins", "charts"), "chart", "the plugin's chart");
    const snapshot = await loadLocalSkillsSnapshot({
      ...f.options,
      config: { plugins: { enabled: true } },
    });
    expect(snapshot.skills.filter((skill) => skill.name === "chart")).toEqual([
      expect.objectContaining({ path: userFile }),
    ]);
    expect(snapshot.warnings).toContainEqual({
      path: pluginFile,
      reason: `not loaded: ${userFile} defines a skill with the same name ("chart") and takes precedence`,
    });
  });

  it("lets the project root nearest the touched files win inside a repository", async () => {
    const f = fixture();
    writeSkill(join(f.workspaceRoot, ".agenc", "skills"), "ui-helper", "workspace UI helper");
    const nestedRoot = join(f.workspaceRoot, "packages", "ui", ".agenc", "skills");
    const nestedFile = writeSkill(nestedRoot, "ui-helper", "package UI helper");
    const services = createLocalSkillsServices(f.options);

    await services.skillsManager.discoverSkillDirsForPaths?.([
      join(f.workspaceRoot, "packages", "ui", "src", "Button.tsx"),
    ]);
    await expect(services.skillsManager.resolveSkill?.("ui-helper"))
      .resolves.toMatchObject({ path: nestedFile, description: "package UI helper" });
    const outcome = await services.skillsManager.skillsForConfig({}, null);
    expect(outcome.availableSkills?.filter((skill) => skill.name === "ui-helper")).toHaveLength(1);
  });

  it("keeps a local skill ahead of the built-in of the same name, and says so", async () => {
    const f = fixture();
    const localFile = writeSkill(join(f.agencHome, "skills"), "verify", "my own verify");
    const snapshot = await loadLocalSkillsSnapshot(f.options);
    expect(snapshot.skills.filter((skill) => skill.name === "verify")).toEqual([
      expect.objectContaining({ path: localFile, loadedFrom: "skills" }),
    ]);
    expect(snapshot.warnings).toContainEqual({
      path: localFile,
      reason: 'replaces the built-in skill "verify"; the built-in one is not listed or loadable',
    });
  });

  it("resolves an exact name before another skill's alias", async () => {
    const f = fixture();
    const localFile = writeSkill(join(f.agencHome, "skills"), "keybindings-help", "my keybinding notes");
    const services = createLocalSkillsServices(f.options);
    await expect(services.skillsManager.resolveSkill?.("keybindings-help"))
      .resolves.toMatchObject({ path: localFile });
    // The built-in stays reachable under its own name.
    await expect(services.skillsManager.resolveSkill?.("keybindings"))
      .resolves.toMatchObject({ loadedFrom: "bundled" });
  });

  it("reports a path-gated skill that can never load because its name is taken", async () => {
    const f = fixture();
    const userFile = writeSkill(join(f.agencHome, "skills"), "docs", "the user's docs");
    const gatedDir = join(f.workspaceRoot, ".agenc", "skills", "docs");
    mkdirSync(gatedDir, { recursive: true });
    const gatedFile = join(gatedDir, "SKILL.md");
    writeFileSync(gatedFile, "---\ndescription: gated docs\npaths: docs/**\n---\nBody\n");
    const snapshot = await loadLocalSkillsSnapshot(f.options);
    expect(snapshot.conditionalSkills.map((skill) => skill.name)).not.toContain("docs");
    expect(snapshot.warnings).toContainEqual({
      path: gatedFile,
      reason: `not loaded: ${userFile} defines a skill with the same name ("docs") and takes precedence`,
    });
  });
});
