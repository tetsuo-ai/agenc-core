import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createLocalSkillsServices,
  discoverSkillRoots,
  loadLocalSkillsSnapshot,
} from "./local-loader.js";

function tmpRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `agenc-${label}-`));
}

function writeSkill(root: string, name: string, body?: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    body ??
      `---\nname: ${name}\ndescription: ${name} description\n---\n# ${name}\nUse ${name}.\n`,
  );
}

describe("local skills loader", () => {
  it("discovers project, user, codex-home, and plugin skill roots", async () => {
    const agencHome = tmpRoot("skills-home");
    const workspaceRoot = tmpRoot("skills-workspace");
    const codexHome = tmpRoot("skills-codex");

    writeSkill(join(workspaceRoot, ".agents", "skills"), "project-skill");
    writeSkill(join(agencHome, "skills"), "home-skill");
    writeSkill(join(codexHome, "skills"), "codex-skill");
    writeSkill(join(agencHome, "plugins", "demo", "skills"), "plugin-skill");

    const snapshot = await loadLocalSkillsSnapshot({
      agencHome,
      workspaceRoot,
      env: { CODEX_HOME: codexHome },
    });

    expect(snapshot.skills.map((skill) => skill.name)).toEqual([
      "codex-skill",
      "home-skill",
      "plugin-skill",
      "project-skill",
    ]);
    expect(snapshot.pluginSkillRoots).toEqual([
      join(agencHome, "plugins", "demo", "skills"),
    ]);
  });

  it("supports a root-level SKILL.md in a plugin skills directory", async () => {
    const agencHome = tmpRoot("skills-home");
    const workspaceRoot = tmpRoot("skills-workspace");
    const pluginSkills = join(agencHome, "plugins", "rooted", "skills");
    mkdirSync(pluginSkills, { recursive: true });
    writeFileSync(
      join(pluginSkills, "SKILL.md"),
      "---\nname: rooted-plugin\ndescription: Root plugin skill\n---\nbody\n",
    );

    const snapshot = await loadLocalSkillsSnapshot({
      agencHome,
      workspaceRoot,
      env: {},
    });

    expect(snapshot.skills.map((skill) => skill.name)).toEqual([
      "rooted-plugin",
    ]);
    expect(snapshot.skills[0]?.description).toBe("Root plugin skill");
  });

  it("binds session services without changing the /skills command contract", async () => {
    const agencHome = tmpRoot("skills-home");
    const workspaceRoot = tmpRoot("skills-workspace");
    writeSkill(join(workspaceRoot, ".codex", "skills"), "repo-docs");
    writeSkill(join(agencHome, "plugins", "tools", "skills"), "plugin-docs");

    const services = createLocalSkillsServices({
      agencHome,
      workspaceRoot,
      env: {},
    });

    const outcome = await services.skillsManager.skillsForConfig({}, null);
    const pluginView = await services.pluginsManager.pluginsForConfig({});

    expect(outcome.invokedSkills).toEqual(["plugin-docs", "repo-docs"]);
    expect(outcome.availableSkills?.map((skill) => skill.scope)).toEqual([
      "plugin",
      "project",
    ]);
    expect(pluginView.effectiveSkillRoots()).toEqual([
      join(agencHome, "plugins", "tools", "skills"),
    ]);
  });

  it("skips missing roots", async () => {
    const roots = await discoverSkillRoots({
      agencHome: join(tmpRoot("missing-home"), "nope"),
      workspaceRoot: join(tmpRoot("missing-workspace"), "nope"),
      env: {},
    });
    expect(roots).toEqual([]);
  });
});
