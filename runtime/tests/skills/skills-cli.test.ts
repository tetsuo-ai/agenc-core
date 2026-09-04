import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeSkillCandidates } from "../../src/skills/skill-candidates.js";
import {
  buildSkillsInventory,
  formatAgenCSkillsCliHelpText,
  parseAgenCSkillsCliArgs,
  runAgenCSkillsCli,
  type SkillsCliOptions,
} from "../../src/skills/skills-cli.js";

vi.mock("bun:bundle", () => ({ feature: () => false }));

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

describe("agenc skills candidates CLI", () => {
  const draft = (name: string, evidence: string[] = ["one verified run"]) => ({
    name,
    description: `${name} description`,
    whenToUse: `when ${name} applies`,
    body: `# ${name}\n\n## Steps\n\n1. do it\n\n## Verification\n\ncheck it\n`,
    evidence,
  });

  async function seedHome(): Promise<{ agencHome: string; options: SkillsCliOptions }> {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-skills-cli-cand-"));
    const fakeUserHome = await mkdtemp(join(tmpdir(), "agenc-skills-cli-cand-user-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agenc-skills-cli-cand-ws-"));
    await writeSkill(join(agencHome, "skills"), "my-notes");
    await writeSkillCandidates({
      agencHome,
      candidates: [draft("fresh-draft"), draft("my-notes", ["a", "b"]), draft("doomed-draft")],
      installedSkillNames: [],
      provenance: { sessionId: "conv-1", createdAt: "2026-09-05T00:00:00.000Z" },
    });
    return {
      agencHome,
      options: {
        agencHome,
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot,
        env: { AGENC_HOME: agencHome, HOME: fakeUserHome },
      },
    };
  }

  function captureOutput(): { stdout: string[]; stderr: string[]; restore: () => void } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const outSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        stdout.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        stderr.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
    return {
      stdout,
      stderr,
      restore: () => {
        outSpy.mockRestore();
        errSpy.mockRestore();
      },
    };
  }

  it("parses the candidates commands and reports malformed ones as errors", () => {
    expect(parseAgenCSkillsCliArgs(["skills", "candidates", "list"])).toEqual({
      kind: "candidates-list",
      json: false,
    });
    expect(parseAgenCSkillsCliArgs(["skills", "candidates", "list", "--json"])).toEqual({
      kind: "candidates-list",
      json: true,
    });
    expect(parseAgenCSkillsCliArgs(["skills", "candidates", "show", "my-draft"])).toEqual({
      kind: "candidates-show",
      slug: "my-draft",
    });
    expect(parseAgenCSkillsCliArgs(["skills", "candidates", "accept", "my-draft"])).toEqual({
      kind: "candidates-accept",
      slug: "my-draft",
    });
    expect(parseAgenCSkillsCliArgs(["skills", "candidates", "reject", "my-draft"])).toEqual({
      kind: "candidates-reject",
      slug: "my-draft",
    });
    for (const argv of [
      ["skills", "candidates"],
      ["skills", "candidates", "accept"],
      ["skills", "candidates", "accept", "Bad Name"],
      ["skills", "candidates", "accept", "../skills"],
      ["skills", "candidates", "reject", "one", "two"],
      ["skills", "candidates", "list", "--verbose"],
      ["skills", "candidates", "frobnicate"],
    ]) {
      expect(parseAgenCSkillsCliArgs(argv), argv.join(" ")).toMatchObject({ kind: "error" });
    }
    // The original list contract is unchanged.
    expect(parseAgenCSkillsCliArgs(["skills", "list", "--verbose"])).toBeNull();
    expect(parseAgenCSkillsCliArgs(["skills", "install", "x"])).toBeNull();
    expect(formatAgenCSkillsCliHelpText()).toContain("candidates accept <name>");
  });

  it("lists and shows drafts", async () => {
    const { agencHome, options } = await seedHome();
    const output = captureOutput();
    try {
      expect(await runAgenCSkillsCli({ kind: "candidates-list", json: false }, options)).toBe(0);
      const text = output.stdout.join("");
      expect(text).toContain("fresh-draft  2026-09-05T00:00:00.000Z  fresh-draft description  (1 evidence)");
      expect(text).toContain("my-notes  2026-09-05T00:00:00.000Z  my-notes description  (2 evidence)");

      output.stdout.length = 0;
      expect(await runAgenCSkillsCli({ kind: "candidates-list", json: true }, options)).toBe(0);
      const document = JSON.parse(output.stdout.join("")) as {
        kind: string;
        root: string;
        candidates: Array<{ slug: string; evidenceCount: number }>;
        errors: string[];
      };
      expect(document.kind).toBe("agenc.skills.candidates");
      expect(document.root).toBe(join(agencHome, "skill-candidates"));
      expect(document.candidates.map((candidate) => candidate.slug)).toEqual([
        "doomed-draft",
        "fresh-draft",
        "my-notes",
      ]);
      expect(document.errors).toEqual([]);

      output.stdout.length = 0;
      expect(await runAgenCSkillsCli({ kind: "candidates-show", slug: "fresh-draft" }, options)).toBe(0);
      expect(output.stdout.join("")).toContain('name: "fresh-draft"');
      expect(output.stdout.join("")).toContain("## Verification");

      expect(await runAgenCSkillsCli({ kind: "candidates-show", slug: "no-such-draft" }, options)).toBe(1);
      expect(output.stderr.join("")).toContain("agenc: no skill candidate named no-such-draft");
      expect(await runAgenCSkillsCli({ kind: "error", message: "boom" }, options)).toBe(1);
      expect(output.stderr.join("")).toContain("agenc: boom");
    } finally {
      output.restore();
    }
  });

  it("accepts a draft into the user skills root, refuses a taken name, and rejects", async () => {
    const { agencHome, options } = await seedHome();
    const output = captureOutput();
    try {
      expect(await runAgenCSkillsCli({ kind: "candidates-accept", slug: "my-notes" }, options)).toBe(1);
      expect(output.stderr.join("")).toContain("a skill named my-notes is already installed");
      await expect(stat(join(agencHome, "skill-candidates", "my-notes", "SKILL.md"))).resolves.toBeDefined();

      expect(await runAgenCSkillsCli({ kind: "candidates-accept", slug: "fresh-draft" }, options)).toBe(0);
      expect(output.stdout.join("")).toContain(
        `accepted fresh-draft: ${join(agencHome, "skills", "fresh-draft")}`,
      );
      await expect(stat(join(agencHome, "skills", "fresh-draft", "SKILL.md"))).resolves.toBeDefined();
      await expect(stat(join(agencHome, "skills", "fresh-draft", "candidate.json"))).rejects.toThrow();
      await expect(stat(join(agencHome, "skill-candidates", "fresh-draft"))).rejects.toThrow();
      const inventory = await buildSkillsInventory(options);
      expect(inventory.skills.some((skill) => skill.origin === "personal" && skill.name === "fresh-draft")).toBe(true);

      expect(await runAgenCSkillsCli({ kind: "candidates-reject", slug: "doomed-draft" }, options)).toBe(0);
      expect(output.stdout.join("")).toContain("rejected doomed-draft");
      await expect(stat(join(agencHome, "skill-candidates", "doomed-draft"))).rejects.toThrow();
      expect(await runAgenCSkillsCli({ kind: "candidates-reject", slug: "doomed-draft" }, options)).toBe(1);

      const ledger = (await readFile(join(agencHome, "skill-candidates", "ledger.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { slug: string; action: string });
      expect(ledger.map((entry) => `${entry.slug}:${entry.action}`)).toEqual([
        "fresh-draft:proposed",
        "my-notes:proposed",
        "doomed-draft:proposed",
        "fresh-draft:accepted",
        "doomed-draft:rejected",
      ]);
    } finally {
      output.restore();
    }
  });
});
