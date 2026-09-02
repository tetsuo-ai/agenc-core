import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSkillsInventory, parseAgenCSkillsCliArgs } from "../../src/skills/skills-cli.js";

async function writeSkill(root: string, name: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} description\n---\n# ${name}\n`,
  );
}

describe("agenc skills CLI", () => {
  it("parses only its own invocations", () => {
    expect(parseAgenCSkillsCliArgs(["skills", "list", "--json"])).toEqual({
      kind: "list",
      json: true,
    });
    expect(parseAgenCSkillsCliArgs(["skills", "list"])).toEqual({
      kind: "list",
      json: false,
    });
    expect(parseAgenCSkillsCliArgs(["skills"])).toBeNull();
    expect(parseAgenCSkillsCliArgs(["skills", "install", "x"])).toBeNull();
    expect(parseAgenCSkillsCliArgs(["plugin", "list"])).toBeNull();
  });

  it("inventories built-in, personal, project, and plugin skills by origin", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-skills-cli-home-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agenc-skills-cli-ws-"));
    await writeSkill(join(agencHome, "skills"), "my-notes");
    await writeSkill(join(workspaceRoot, ".agenc", "skills"), "repo-docs");
    const pluginRoot = join(agencHome, "plugins", "demo");
    await mkdir(join(pluginRoot, ".agenc-plugin"), { recursive: true });
    await writeFile(
      join(pluginRoot, ".agenc-plugin", "plugin.json"),
      `${JSON.stringify({ name: "demo", description: "demo plugin" })}\n`,
    );
    await writeSkill(join(pluginRoot, "skills"), "demo-skill");
    await writeFile(
      join(agencHome, "config.toml"),
      'config_version = 2\n\n[plugins]\nenabled = true\n',
    );

    const inventory = await buildSkillsInventory({
      agencHome,
      pluginStorageRoot: join(agencHome, "plugins"),
      workspaceRoot,
      env: { AGENC_HOME: agencHome },
    });

    expect(inventory.kind).toBe("agenc.skills.inventory");
    const byOrigin = new Map(
      inventory.skills.map((skill) => [`${skill.origin}:${skill.name}`, skill]),
    );
    expect(byOrigin.has("personal:my-notes")).toBe(true);
    expect(byOrigin.has("project:repo-docs")).toBe(true);
    expect(byOrigin.has("plugin:demo-skill")).toBe(true);
    expect(byOrigin.get("plugin:demo-skill")?.pluginRoot).toBeDefined();
    expect(byOrigin.has("built-in:verify")).toBe(true);
    expect(byOrigin.get("built-in:batch")?.whenToUse).toMatch(/migrations/iu);
    expect(byOrigin.has("built-in:ledger-wallet-cli")).toBe(true);
    const names = inventory.skills.map((skill) => skill.name);
    expect(names).not.toContain("iot-builder");
  });

  it("reports SKILL.md files whose frontmatter was ignored", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-skills-cli-warn-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agenc-skills-cli-warn-ws-"));
    const brokenDir = join(workspaceRoot, ".agenc", "skills", "broken");
    await mkdir(brokenDir, { recursive: true });
    await writeFile(
      join(brokenDir, "SKILL.md"),
      "---\nname: [unclosed\n---\n# Broken\n",
    );

    const inventory = await buildSkillsInventory({
      agencHome,
      pluginStorageRoot: join(agencHome, "plugins"),
      workspaceRoot,
      env: { AGENC_HOME: agencHome },
    });

    expect(inventory.skills.map((skill) => skill.name)).toContain("broken");
    expect(inventory.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^.*[\\/]broken[\\/]SKILL\.md: frontmatter is not valid YAML \(.+\); its fields were ignored$/u,
        ),
      ]),
    );
  });

  it("reports roots holding more skills than the per-root cap", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-skills-cli-cap-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agenc-skills-cli-cap-ws-"));
    const userRoot = join(agencHome, "skills");
    // The cap is configurable so a real catalog loads whole; set it low here
    // rather than writing thousands of files to reach the default.
    const previousCap = process.env.AGENC_MAX_SKILL_FILES_PER_ROOT;
    process.env.AGENC_MAX_SKILL_FILES_PER_ROOT = "10";
    try {
      for (let i = 0; i < 15; i++) {
        await writeSkill(userRoot, `cap-${String(i).padStart(3, "0")}`);
      }

      const inventory = await buildSkillsInventory({
        agencHome,
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        env: { AGENC_HOME: agencHome },
      });

      expect(
        inventory.skills.filter((skill) => skill.name.startsWith("cap-")),
      ).toHaveLength(10);
      expect(inventory.errors).toContain(
        `5 SKILL.md files under ${userRoot} were not loaded: the per-root cap was reached after 10`,
      );
    } finally {
      if (previousCap === undefined) delete process.env.AGENC_MAX_SKILL_FILES_PER_ROOT;
      else process.env.AGENC_MAX_SKILL_FILES_PER_ROOT = previousCap;
    }
  });
});
