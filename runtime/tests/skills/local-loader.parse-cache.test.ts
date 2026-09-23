import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildSkillListingWithinBudget,
  createLocalSkillsServices,
  loadLocalSkillsSnapshot,
  skillFileParseCountForTest,
} from "./local-loader.js";

function tmpRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `agenc-${label}-`));
}

function writeSkill(root: string, name: string, description: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, `---\ndescription: ${description}\n---\n# ${name}\nBody\n`);
  return file;
}

function fixture(count: number) {
  const agencHome = tmpRoot("cache-home");
  const root = join(agencHome, "skills");
  const files = Array.from({ length: count }, (_, i) =>
    writeSkill(root, `skill-${i}`, `does job ${i}`),
  );
  const options = {
    agencHome,
    pluginStorageRoot: join(agencHome, "plugins"),
    workspaceRoot: tmpRoot("cache-workspace"),
    env: {},
  };
  const description = async (name: string) =>
    (await loadLocalSkillsSnapshot(options)).skills.find((skill) => skill.name === name)
      ?.description;
  return { root, files, options, description };
}

describe("parsed SKILL.md reuse", () => {
  it("parses each file once across sessions and forced rescans", async () => {
    const f = fixture(20);
    const before = skillFileParseCountForTest();
    const first = createLocalSkillsServices({ ...f.options, sessionId: "a" });
    await first.skillsManager.skillsForConfig({}, null);
    expect(skillFileParseCountForTest() - before).toBe(20);

    const second = createLocalSkillsServices({ ...f.options, sessionId: "b" });
    const outcome = await second.skillsManager.skillsForConfig({}, null);
    first.skillsManager.clearSkillCaches?.();
    await first.skillsManager.skillsForConfig({}, null);
    expect(skillFileParseCountForTest() - before).toBe(20);
    expect(outcome.availableSkills?.find((skill) => skill.name === "skill-7")).toMatchObject({
      description: "does job 7",
      contentLength: "# skill-7\nBody\n".length,
    });
  });

  it("re-reads exactly the file that changed", async () => {
    const f = fixture(10);
    await f.description("skill-3");
    const before = skillFileParseCountForTest();
    writeFileSync(f.files[3]!, "---\ndescription: a new job\n---\nBody\n");
    expect(await f.description("skill-3")).toBe("a new job");
    expect(skillFileParseCountForTest() - before).toBe(1);
  });

  it("sees an edit that keeps the size and restores the modification time", async () => {
    const f = fixture(1);
    const file = f.files[0]!;
    expect(await f.description("skill-0")).toBe("does job 0");
    const { atime, mtime, size } = statSync(file);
    writeFileSync(file, "---\ndescription: does jib 0\n---\n# skill-0\nBody\n");
    utimesSync(file, atime, mtime);
    expect(statSync(file).size).toBe(size);
    expect(statSync(file).mtimeMs).toBe(mtime.getTime());
    expect(await f.description("skill-0")).toBe("does jib 0");
  });

  it("drops a deleted skill and takes a new one", async () => {
    const f = fixture(2);
    await f.description("skill-0");
    rmSync(join(f.root, "skill-0"), { recursive: true });
    writeSkill(f.root, "skill-9", "arrived later");
    const names = (await loadLocalSkillsSnapshot(f.options)).skills.map((skill) => skill.name);
    expect(names).not.toContain("skill-0");
    expect(names).toEqual(expect.arrayContaining(["skill-1", "skill-9"]));
  });

  it("keeps the description fallback and frontmatter warnings on cached reads", async () => {
    const f = fixture(0);
    const bare = join(f.root, "bare");
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, "SKILL.md"), "\n\n  # A heading far down  \nBody\n");
    const broken = join(f.root, "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "SKILL.md"), '---\nname: "unclosed\n---\nBody\n');
    const first = await loadLocalSkillsSnapshot(f.options);
    const second = await loadLocalSkillsSnapshot(f.options);
    for (const snapshot of [first, second]) {
      expect(snapshot.skills.find((skill) => skill.name === "bare")?.description).toBe(
        "A heading far down",
      );
      expect(snapshot.warnings.map((warning) => warning.path)).toEqual([
        join(bare, "SKILL.md"),
        join(broken, "SKILL.md"),
      ]);
    }
  });
});

describe("listing bytes across snapshot rebuilds", () => {
  it("renders the same listing from a fresh and a cached snapshot", async () => {
    // The listing is sent once per session and kept in the cached prompt
    // prefix; two sessions asking the same thing should send the same bytes.
    const f = fixture(300);
    writeSkill(f.root, "zz-orbit-planner", "Plans satellite orbits");
    const request = "plan a satellite orbit";
    const cold = await loadLocalSkillsSnapshot(f.options);
    const warm = await loadLocalSkillsSnapshot(f.options);
    const other = await createLocalSkillsServices({ ...f.options, sessionId: "other" })
      .skillsManager.skillsForConfig({}, null);
    const listings = [cold.skills, warm.skills, other.availableSkills ?? []].map(
      (skills) => buildSkillListingWithinBudget(skills, 100_000, request).listing,
    );
    expect(listings[0]).toContain("- zz-orbit-planner: Plans satellite orbits");
    expect(new Set(listings).size).toBe(1);
  });
});
