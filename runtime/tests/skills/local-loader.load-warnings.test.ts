import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadLocalSkillsSnapshot } from "./local-loader.js";

function tmpRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `agenc-${label}-`));
}

function writeFile(path: string, body: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function fixture() {
  const agencHome = tmpRoot("warn-home");
  const root = join(agencHome, "skills");
  mkdirSync(root, { recursive: true });
  return {
    agencHome,
    root,
    load: (config?: { plugins?: unknown }) =>
      loadLocalSkillsSnapshot({
        agencHome,
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot: tmpRoot("warn-workspace"),
        env: {},
        ...(config !== undefined ? { config: config as never } : {}),
      }),
  };
}

describe("skills the loader could not use are reported", () => {
  it("names a directory that holds no SKILL.md, and the markdown file it does hold", async () => {
    const f = fixture();
    writeFile(join(f.root, "good", "SKILL.md"), "---\ndescription: Good\n---\nBody\n");
    writeFile(join(f.root, "ns", "inner", "SKILL.md"), "---\ndescription: Inner\n---\nBody\n");
    writeFile(join(f.root, "misnamed", "CLAUDE.md"), "# Not a skill file name\n");
    mkdirSync(join(f.root, "empty-ns", "sub"), { recursive: true });
    mkdirSync(join(f.root, ".hidden", "cache"), { recursive: true });

    const snapshot = await f.load();
    const dirWarnings = snapshot.warnings.filter((warning) =>
      warning.reason.startsWith("no SKILL.md"),
    );
    expect(dirWarnings).toEqual([
      {
        path: join(f.root, "empty-ns"),
        reason: "no SKILL.md in this directory or below it, so nothing here was loaded as a skill",
      },
      {
        path: join(f.root, "misnamed"),
        reason: "no SKILL.md in this directory or below it, so nothing here was loaded as a skill (it holds CLAUDE.md; a skill is read from a file named SKILL.md)",
      },
    ]);
    expect(snapshot.skills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining(["good", "ns:inner"]),
    );
  });

  it("reports a missing description without exposing the fallback body line", async () => {
    const f = fixture();
    const bare = writeFile(join(f.root, "bare", "SKILL.md"), "# Tech Debt Analysis\n\nFind debt.\n");
    writeFile(join(f.root, "described", "SKILL.md"), "---\ndescription: Has one\n---\nBody\n");
    const snapshot = await f.load();
    expect(snapshot.warnings).toEqual([
      {
        path: bare,
        reason: "no description in frontmatter",
      },
    ]);
  });

  it("trims indentation before limiting the fallback description", async () => {
    const f = fixture();
    writeFile(join(f.root, "indented", "SKILL.md"), `${" ".repeat(600)}Useful description\n`);
    const snapshot = await f.load();
    expect(snapshot.skills.find((skill) => skill.name === "indented")?.description).toBe("Useful description");
  });

  it("does not report the helper directories of a plugin skill", async () => {
    const f = fixture();
    const pluginRoot = join(f.agencHome, "plugins", "flash");
    writeFile(
      join(pluginRoot, ".agenc-plugin", "plugin.json"),
      JSON.stringify({ name: basename(pluginRoot), version: "1.0.0", skills: ["./skills/flash-board"] }),
    );
    writeFile(join(pluginRoot, "skills", "flash-board", "SKILL.md"), "---\ndescription: Flash\n---\nBody\n");
    mkdirSync(join(pluginRoot, "skills", "flash-board", "scripts"), { recursive: true });
    writeFile(join(pluginRoot, "skills", "flash-board", "scripts", "run.sh"), "echo\n");
    const snapshot = await f.load({ plugins: { enabled: true } });
    expect(snapshot.skills.map((skill) => skill.name)).toContain("flash-board");
    expect(snapshot.warnings).toEqual([]);
  });
});
