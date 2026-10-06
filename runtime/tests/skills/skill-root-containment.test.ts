import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { linkDirectory, writeUtf8 } from "../helpers/directory-link.js";
import { loadLocalSkillsSnapshot } from "../../src/skills/local-loader.js";

const roots: string[] = [];
const FOLLOWED = "FOLLOWED_SKILL_DIRECTORY_BODY";
const LINKED_ROOT = "LINKED_SKILL_ROOT_BODY";
const INSIDE = "INSIDE_SKILL_BODY";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local-skill root containment", () => {
  it("loads a regular SKILL.md below the project skill root", async () => {
    const { agencHome, pluginStorageRoot, workspaceRoot, fakeHome } = await workspace();
    await writeSkill(join(workspaceRoot, ".agents", "skills", "ok-skill"), "ok-skill", INSIDE);

    const snapshot = await loadLocalSkillsSnapshot({
      agencHome,
      pluginStorageRoot,
      workspaceRoot,
      env: { HOME: fakeHome },
    });

    const ok = snapshot.skills.find((skill) => skill.name === "ok-skill");
    expect(ok).toBeDefined();
    expect(ok?.contentLength).toBeGreaterThan(0);
  });

  it("loads a skill directory that is a symlink, matching main's follow policy", async () => {
    const { agencHome, pluginStorageRoot, workspaceRoot, root, fakeHome } = await workspace();
    const skillRoot = join(workspaceRoot, ".agents", "skills");
    await writeSkill(join(skillRoot, "ok-skill"), "ok-skill", INSIDE);
    const outsideSkill = join(root, "followed-skill");
    await writeSkill(outsideSkill, "followed-skill", FOLLOWED);
    await linkDirectory(outsideSkill, join(skillRoot, "followed-skill"));

    const snapshot = await loadLocalSkillsSnapshot({
      agencHome,
      pluginStorageRoot,
      workspaceRoot,
      env: { HOME: fakeHome },
    });

    const names = snapshot.skills.map((skill) => skill.name);
    expect(names).toContain("ok-skill");
    expect(names).toContain("followed-skill");
    const followed = snapshot.skills.find((skill) => skill.name === "followed-skill");
    expect(followed?.path).toContain("followed-skill");
    expect(followed?.contentLength).toBeGreaterThan(0);
  });

  it("loads skills when the user skill root itself is a symlink", async () => {
    const { agencHome, pluginStorageRoot, workspaceRoot, root, fakeHome } = await workspace();
    const realSkills = join(root, "real-user-skills");
    await writeSkill(join(realSkills, "linked-root-skill"), "linked-root-skill", LINKED_ROOT);
    await linkDirectory(realSkills, join(agencHome, "skills"));

    const snapshot = await loadLocalSkillsSnapshot({
      agencHome,
      pluginStorageRoot,
      workspaceRoot,
      env: { HOME: fakeHome },
    });

    const linked = snapshot.skills.find((skill) => skill.name === "linked-root-skill");
    expect(linked).toBeDefined();
    expect(linked?.root).toBe(join(agencHome, "skills"));
    expect(linked?.contentLength).toBeGreaterThan(0);
  });
});

async function workspace(): Promise<{
  readonly root: string;
  readonly agencHome: string;
  readonly pluginStorageRoot: string;
  readonly workspaceRoot: string;
  readonly fakeHome: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agenc-skill-root-containment-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const agencHome = join(root, "home");
  const fakeHome = join(root, "fake-home");
  const pluginStorageRoot = join(agencHome, "plugins");
  await mkdir(pluginStorageRoot, { recursive: true });
  await mkdir(fakeHome, { recursive: true });
  return { root, agencHome, pluginStorageRoot, workspaceRoot, fakeHome };
}

async function writeSkill(dir: string, name: string, body: string): Promise<void> {
  await writeUtf8(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} description\n---\n# ${name}\n${body}\n`,
  );
}
