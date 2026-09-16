import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { linkDirectory, writeUtf8 } from "../helpers/directory-link.js";
import { loadLocalSkillsSnapshot } from "../../src/skills/local-loader.js";

const roots: string[] = [];
const SECRET = "OUTSIDE_SKILL_SECRET_BYTES";
const INSIDE = "INSIDE_SKILL_BODY";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local-skill root containment", () => {
  it("loads a regular SKILL.md below the project skill root", async () => {
    const { agencHome, pluginStorageRoot, workspaceRoot } = await workspace();
    await writeSkill(join(workspaceRoot, ".agents", "skills", "ok-skill"), "ok-skill", INSIDE);

    const snapshot = await loadLocalSkillsSnapshot({
      agencHome,
      pluginStorageRoot,
      workspaceRoot,
      env: {},
    });

    expect(snapshot.skills.map((skill) => skill.name)).toContain("ok-skill");
    expect(JSON.stringify(snapshot.warnings)).not.toContain(SECRET);
  });

  it("rejects an outbound skill directory link before the outside SKILL.md is read", async () => {
    const { agencHome, pluginStorageRoot, workspaceRoot, root } = await workspace();
    const skillRoot = join(workspaceRoot, ".agents", "skills");
    await writeSkill(join(skillRoot, "ok-skill"), "ok-skill", INSIDE);
    const outsideSkill = join(root, "outside-skill");
    await writeSkill(outsideSkill, "leaked-skill", SECRET);
    await linkDirectory(outsideSkill, join(skillRoot, "leaked-skill"));

    const snapshot = await loadLocalSkillsSnapshot({
      agencHome,
      pluginStorageRoot,
      workspaceRoot,
      env: {},
    });

    expect(snapshot.skills.map((skill) => skill.name)).toContain("ok-skill");
    expect(snapshot.skills.map((skill) => skill.name)).not.toContain("leaked-skill");
    expect(snapshot.warnings.some((warning) => warning.path.includes("leaked-skill"))).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
  });
});

async function workspace(): Promise<{
  readonly root: string;
  readonly agencHome: string;
  readonly pluginStorageRoot: string;
  readonly workspaceRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agenc-skill-root-containment-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const agencHome = join(root, "home");
  const pluginStorageRoot = join(agencHome, "plugins");
  await mkdir(pluginStorageRoot, { recursive: true });
  return { root, agencHome, pluginStorageRoot, workspaceRoot };
}

async function writeSkill(dir: string, name: string, body: string): Promise<void> {
  await writeUtf8(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} description\n---\n# ${name}\n${body}\n`,
  );
}
