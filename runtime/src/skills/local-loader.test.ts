import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clearInvokedSkills,
  createLocalSkillsServices,
  discoverDynamicSkillDirsForPaths,
  discoverSkillRoots,
  formatSkillListingWithinBudget,
  loadLocalSkillsSnapshot,
} from "./local-loader.js";
import { substituteArguments } from "../tui/slash/argument-substitution.js";

function tmpRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `agenc-${label}-`));
}

function writeSkill(root: string, rel: string, body?: string): string {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(
    file,
    body ??
      `---\nname: ${rel}\ndescription: ${rel} description\n---\n# ${rel}\nUse ${rel}.\n`,
  );
  return file;
}

function writeCommand(root: string, rel: string, body?: string): string {
  const file = join(root, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    body ??
      `---\ndescription: ${rel} description\n---\n# ${rel}\nUse command.\n`,
  );
  return file;
}

describe("local skills loader", () => {
  it("discovers AgenC, agent, user, and plugin skill roots", async () => {
    const agencHome = tmpRoot("skills-home");
    const home = tmpRoot("skills-user");
    const defaultAgencHome = join(home, ".agenc");
    const workspaceRoot = tmpRoot("skills-workspace");

    writeSkill(join(workspaceRoot, ".agents", "skills"), "project-skill");
    writeSkill(join(workspaceRoot, ".agenc", "skills"), "agenc-project-skill");
    writeSkill(join(agencHome, "skills"), "home-skill");
    writeSkill(join(defaultAgencHome, "skills"), "default-home-skill");
    writeSkill(join(agencHome, "plugins", "demo", "skills"), "plugin-skill");

    const snapshot = await loadLocalSkillsSnapshot({
      agencHome,
      workspaceRoot,
      env: { HOME: home },
    });

    expect(snapshot.skills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining([
        "agenc-project-skill",
        "default-home-skill",
        "home-skill",
        "plugin-skill",
        "project-skill",
        "simplify",
        "loop",
      ]),
    );
    expect(snapshot.pluginSkillRoots).toEqual([
      join(agencHome, "plugins", "demo", "skills"),
    ]);
  });

  it("uses nested directory names and ignores root-level skills/SKILL.md", async () => {
    const agencHome = tmpRoot("skills-home");
    const workspaceRoot = tmpRoot("skills-workspace");
    const rootSkills = join(workspaceRoot, ".agenc", "skills");
    mkdirSync(rootSkills, { recursive: true });
    writeFileSync(join(rootSkills, "SKILL.md"), "---\nname: ignored\n---\nignored\n");
    writeSkill(rootSkills, "frontend/react/form", "---\ndescription: Form skill\n---\nBody\n");

    const snapshot = await loadLocalSkillsSnapshot({
      agencHome,
      workspaceRoot,
      env: {},
    });

    expect(snapshot.skills.map((skill) => skill.name)).toContain(
      "frontend:react:form",
    );
    expect(snapshot.skills.map((skill) => skill.name)).not.toContain("ignored");
  });

  it("parses AgenC frontmatter fields and keeps name as display name", async () => {
    const agencHome = tmpRoot("skills-home");
    const workspaceRoot = tmpRoot("skills-workspace");
    writeSkill(
      join(workspaceRoot, ".agenc", "skills"),
      "repo-docs",
      `---
name: Repository Docs
description: Use repository docs
allowed-tools: Read, Grep
argument-hint: "<topic>"
arguments: topic, focus
when_to_use: when docs are needed
version: "1.2.3"
model: inherit
disable-model-invocation: false
user-invocable: true
context: fork
agent: explorer
effort: high
shell: bash
paths: ["docs/**"]
---
Read $topic and $focus.
`,
    );

    const snapshot = await loadLocalSkillsSnapshot({
      agencHome,
      workspaceRoot,
      env: {},
    });
    const hidden = snapshot.conditionalSkills.find(
      (skill) => skill.name === "repo-docs",
    );
    expect(hidden).toMatchObject({
      name: "repo-docs",
      displayName: "Repository Docs",
      description: "Use repository docs",
      allowedTools: ["Read", "Grep"],
      argumentHint: "<topic>",
      argNames: ["topic", "focus"],
      whenToUse: "when docs are needed",
      version: "1.2.3",
      userInvocable: true,
      context: "fork",
      agent: "explorer",
      effort: "high",
      shell: "bash",
      paths: ["docs"],
    });
    expect(hidden?.model).toBeUndefined();
  });

  it("activates conditional path skills when matching paths are provided", async () => {
    const agencHome = tmpRoot("skills-home");
    const workspaceRoot = tmpRoot("skills-workspace");
    writeSkill(
      join(workspaceRoot, ".agenc", "skills"),
      "docs-helper",
      "---\ndescription: Docs helper\npaths: docs/**\n---\nBody\n",
    );

    const inactive = await loadLocalSkillsSnapshot({
      agencHome,
      workspaceRoot,
      env: {},
    });
    expect(inactive.skills.map((skill) => skill.name)).not.toContain("docs-helper");
    expect(inactive.conditionalSkills.map((skill) => skill.name)).toContain(
      "docs-helper",
    );

    const active = await loadLocalSkillsSnapshot(
      { agencHome, workspaceRoot, env: {} },
      [join(workspaceRoot, "docs", "intro.md")],
    );
    expect(active.skills.map((skill) => skill.name)).toContain("docs-helper");
  });

  it("loads legacy commands as user-invocable skills", async () => {
    const agencHome = tmpRoot("skills-home");
    const workspaceRoot = tmpRoot("skills-workspace");
    writeCommand(join(workspaceRoot, ".agenc", "commands"), "review.md");
    writeSkill(join(workspaceRoot, ".agenc", "commands"), "deploy");

    const snapshot = await loadLocalSkillsSnapshot({
      agencHome,
      workspaceRoot,
      env: {},
    });

    expect(snapshot.skills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining(["review", "deploy"]),
    );
    expect(snapshot.skills.find((skill) => skill.name === "review")?.loadedFrom)
      .toBe("commands_DEPRECATED");
  });

  it("renders custom command markdown arguments through the loader path", async () => {
    const agencHome = tmpRoot("skills-home");
    const workspaceRoot = tmpRoot("skills-workspace");
    writeCommand(
      join(workspaceRoot, ".agenc", "commands"),
      "explain.md",
      `---
description: Explain a topic
arguments: topic target
---
Topic=$topic
First=$0
Second=$1
All=$ARGUMENTS
`,
    );
    const services = createLocalSkillsServices({
      agencHome,
      workspaceRoot,
      env: {},
    });

    const rendered = await services.skillsManager.renderSkill?.({
      name: "explain",
      args: '"rendering hooks" docs',
      sessionId: "session-2",
    });

    expect(rendered?.content).toContain("Topic=rendering hooks");
    expect(rendered?.content).toContain("First=rendering hooks");
    expect(rendered?.content).toContain("Second=docs");
    expect(rendered?.content).toContain('All="rendering hooks" docs');
  });

  it("renders skills with base directory, arguments, and AgenC placeholders", async () => {
    const agencHome = tmpRoot("skills-home");
    const workspaceRoot = tmpRoot("skills-workspace");
    writeSkill(
      join(workspaceRoot, ".agenc", "skills"),
      "repo-docs",
      "---\ndescription: Docs\narguments: topic\n---\nRead $topic in ${AGENC_SKILL_DIR} for ${AGENC_SESSION_ID}.\n",
    );
    const services = createLocalSkillsServices({
      agencHome,
      workspaceRoot,
      env: {},
    });

    const rendered = await services.skillsManager.renderSkill?.({
      name: "repo-docs",
      args: "architecture",
      sessionId: "session-1",
    });

    expect(rendered?.content).toContain("Base directory for this skill:");
    expect(rendered?.content).toContain("Read architecture");
    expect(rendered?.content).toContain("session-1");
    expect(rendered?.content).not.toContain("${AGENC_SKILL_DIR}");
  });

  it("binds session services and tracks invoked skills separately from available skills", async () => {
    clearInvokedSkills();
    const agencHome = tmpRoot("skills-home");
    const workspaceRoot = tmpRoot("skills-workspace");
    writeSkill(join(workspaceRoot, ".agenc", "skills"), "repo-docs");
    writeSkill(join(agencHome, "plugins", "tools", "skills"), "plugin-docs");

    const services = createLocalSkillsServices({
      agencHome,
      workspaceRoot,
      env: {},
    });
    services.skillsManager.recordInvokedSkill?.({
      skillName: "repo-docs",
      skillPath: "/tmp/repo-docs/SKILL.md",
      content: "body",
      invokedAt: 1,
    });

    const outcome = await services.skillsManager.skillsForConfig({}, null);
    const pluginView = await services.pluginsManager.pluginsForConfig({});

    expect(outcome.invokedSkills).toEqual(["repo-docs"]);
    expect(outcome.availableSkills?.map((skill) => skill.name)).toEqual(
      expect.arrayContaining(["plugin-docs", "repo-docs"]),
    );
    expect(pluginView.effectiveSkillRoots()).toEqual([
      join(agencHome, "plugins", "tools", "skills"),
    ]);
  });

  it("supports listing budgets and argument substitution", () => {
    expect(substituteArguments("Do $0 for $name via $ARGUMENTS", "one two", true, [
      "name",
    ])).toBe("Do one for one via one two");

    const listing = formatSkillListingWithinBudget(
      [
        {
          name: "long",
          description: "x".repeat(400),
          loadedFrom: "skills",
        },
      ],
      10,
    );
    expect(listing).toContain("- long");
  });

  it("skips missing roots and discovers nested dynamic skill dirs", async () => {
    const workspaceRoot = tmpRoot("skills-workspace");
    const nested = join(workspaceRoot, "packages", "ui");
    writeSkill(join(nested, ".agenc", "skills"), "ui-helper");

    const roots = await discoverSkillRoots({
      agencHome: join(tmpRoot("missing-home"), "nope"),
      workspaceRoot: join(tmpRoot("missing-workspace"), "nope"),
      env: { HOME: tmpRoot("missing-user") },
    });
    expect(roots).toEqual([]);

    await expect(
      discoverDynamicSkillDirsForPaths([join(nested, "Button.tsx")], workspaceRoot),
    ).resolves.toEqual([join(nested, ".agenc", "skills")]);
  });
});
