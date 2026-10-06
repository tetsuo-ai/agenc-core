import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalSkillsSnapshot } from "./local-loader.js";

function tmpRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `agenc-${label}-`));
}

function writeSkill(root: string, rel: string): string {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, `---\ndescription: ${rel} description\n---\nBody\n`);
  return file;
}

function fixture() {
  const agencHome = tmpRoot("scan-home");
  return {
    root: join(agencHome, "skills"),
    load: () =>
      loadLocalSkillsSnapshot({
        agencHome,
        pluginStorageRoot: join(agencHome, "plugins"),
        workspaceRoot: tmpRoot("scan-workspace"),
        env: {},
      }),
  };
}

const localNames = (snapshot: Awaited<ReturnType<ReturnType<typeof fixture>["load"]>>) =>
  snapshot.skills.filter((skill) => skill.loadedFrom !== "bundled").map((skill) => skill.name).sort();

const previousCap = process.env.AGENC_MAX_SKILL_FILES_PER_ROOT;
afterEach(() => {
  if (previousCap === undefined) delete process.env.AGENC_MAX_SKILL_FILES_PER_ROOT;
  else process.env.AGENC_MAX_SKILL_FILES_PER_ROOT = previousCap;
});

describe("skill root walk", () => {
  it("terminates on a symlink loop and loads each skill once", async () => {
    const f = fixture();
    writeSkill(f.root, "alpha");
    writeSkill(f.root, "team/beta");
    symlinkSync(f.root, join(f.root, "team", "loop"));
    symlinkSync(join(f.root, "team"), join(f.root, "0-team-again"));
    expect(localNames(await f.load())).toEqual(["alpha", "team:beta"]);
  });

  it("follows a symlinked skill directory but never a symlinked SKILL.md file", async () => {
    const f = fixture();
    const elsewhere = tmpRoot("scan-elsewhere");
    writeSkill(elsewhere, "linked");
    mkdirSync(f.root, { recursive: true });
    symlinkSync(join(elsewhere, "linked"), join(f.root, "linked"));
    // A SKILL.md that is itself a link could point at any file on disk and
    // put its first line in the listing, so it stays unloaded.
    const secret = join(elsewhere, "not-a-skill.txt");
    writeFileSync(secret, "first line of some private file\n");
    mkdirSync(join(f.root, "file-link"), { recursive: true });
    symlinkSync(secret, join(f.root, "file-link", "SKILL.md"));
    expect(localNames(await f.load())).toEqual(["linked"]);
  });

  it("walks twelve levels below the root and no further", async () => {
    const f = fixture();
    const twelve = Array.from({ length: 12 }, (_, i) => `d${i + 1}`).join("/");
    const thirteen = `${twelve}/d13`;
    writeSkill(f.root, twelve);
    writeSkill(f.root, thirteen);
    expect(localNames(await f.load())).toEqual([twelve.split("/").join(":")]);
  });

  it("skips dependency and build directories", async () => {
    const f = fixture();
    writeSkill(f.root, "kept");
    writeSkill(f.root, "kept/node_modules/dep");
    writeSkill(f.root, "kept/.git/hooks");
    writeSkill(f.root, "dist/built");
    expect(localNames(await f.load())).toEqual(["kept"]);
  });

  it("applies the per-root cap shallow skills first, the same way every scan", async () => {
    const f = fixture();
    for (const name of ["delta", "alpha", "charlie", "bravo"]) writeSkill(f.root, name);
    writeSkill(f.root, "aaa-namespace/nested");
    process.env.AGENC_MAX_SKILL_FILES_PER_ROOT = "3";
    const first = await f.load();
    const second = await f.load();
    expect(localNames(first)).toEqual(["alpha", "bravo", "charlie"]);
    expect(localNames(second)).toEqual(localNames(first));
    expect(first.truncatedRoots).toEqual([
      { root: f.root, loadedCount: 3, droppedCount: 2 },
    ]);
  });

  it("counts symlinked skills in shallowest-first order before applying the cap", async () => {
    const f = fixture();
    const elsewhere = tmpRoot("scan-linked-cap");
    writeSkill(elsewhere, "linked");
    writeSkill(f.root, "ordinary/deep");
    symlinkSync(join(elsewhere, "linked"), join(f.root, "linked"));
    process.env.AGENC_MAX_SKILL_FILES_PER_ROOT = "1";

    const snapshot = await f.load();
    expect(localNames(snapshot)).toEqual(["linked"]);
    expect(snapshot.truncatedRoots).toEqual([
      { root: f.root, loadedCount: 1, droppedCount: 1 },
    ]);
  });

  it("sorts ordinary and symlinked skills alphabetically at the same depth", async () => {
    const f = fixture();
    const elsewhere = tmpRoot("scan-linked-tie");
    writeSkill(elsewhere, "alpha");
    writeSkill(f.root, "zulu");
    symlinkSync(join(elsewhere, "alpha"), join(f.root, "alpha"));
    process.env.AGENC_MAX_SKILL_FILES_PER_ROOT = "1";

    expect(localNames(await f.load())).toEqual(["alpha"]);
  });

  it("reaches a skill through a shallower symlink discovered in a later pass", async () => {
    const f = fixture();
    const elsewhere = tmpRoot("scan-link-depth");
    const deepEntry = join(elsewhere, "deep-entry");
    const shallowEntry = join(elsewhere, "shallow-entry");
    const intermediate = join(elsewhere, "intermediate");
    const target = join(elsewhere, "target");
    const tail = Array.from({ length: 8 }, (_, i) => `n${i + 1}`).join("/");
    writeSkill(target, tail);
    mkdirSync(join(deepEntry, "d1", "d2", "d3"), { recursive: true });
    mkdirSync(shallowEntry, { recursive: true });
    mkdirSync(intermediate, { recursive: true });
    symlinkSync(target, join(deepEntry, "d1", "d2", "d3", "deep"));
    symlinkSync(intermediate, join(shallowEntry, "via-c"));
    symlinkSync(target, join(intermediate, "short"));
    mkdirSync(f.root, { recursive: true });
    symlinkSync(deepEntry, join(f.root, "a-deep"));
    symlinkSync(shallowEntry, join(f.root, "b-shallow"));

    expect(localNames(await f.load())).toContain(
      `b-shallow:via-c:short:${tail.replaceAll("/", ":")}`,
    );
  });
});
