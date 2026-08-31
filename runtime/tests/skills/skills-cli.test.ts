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
});
