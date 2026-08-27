import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BundledSkillExtractionRegistry } from "../../src/skills/bundled-extraction-registry.js";

const temporaryRoots: string[] = [];

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `agenc-bundled-registry-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function registry(maxOwnerlessRoots = 2): BundledSkillExtractionRegistry {
  let nonce = 0;
  return new BundledSkillExtractionRegistry({
    maxOwnerlessRoots,
    createNonce: () => `test-${nonce++}`,
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("BundledSkillExtractionRegistry", () => {
  it("shares one root between same-authority owners and cleans it after the final release", async () => {
    const sessionTempRoot = temporaryRoot("shared");
    const extractions = registry();
    const first = extractions.retain(sessionTempRoot);
    const second = extractions.retain(sessionTempRoot);

    expect(second.root).toBe(first.root);
    await expect(
      extractions.extractFiles(first.root, "demo", {
        "references/guide.md": "shared guidance",
      }),
    ).resolves.toBe(join(first.root, "demo"));
    expect(existsSync(first.root)).toBe(true);

    await first.release();
    expect(existsSync(first.root)).toBe(true);
    expect(extractions.snapshot().roots).toEqual([
      expect.objectContaining({ root: first.root, ownerCount: 1 }),
    ]);

    await second.release();
    expect(existsSync(first.root)).toBe(false);
    expect(extractions.snapshot().roots).toEqual([]);
  });

  it("isolates distinct captured temp authorities", async () => {
    const tempRootA = temporaryRoot("distinct-a");
    const tempRootB = temporaryRoot("distinct-b");
    const extractions = registry();
    const ownerA = extractions.retain(tempRootA);
    const ownerB = extractions.retain(tempRootB);

    expect(ownerA.root.startsWith(`${tempRootA}${sep}`)).toBe(true);
    expect(ownerB.root.startsWith(`${tempRootB}${sep}`)).toBe(true);
    expect(ownerA.root).not.toBe(ownerB.root);
    await extractions.extractFiles(ownerA.root, "demo", { "a.txt": "a" });
    await extractions.extractFiles(ownerB.root, "demo", { "b.txt": "b" });

    await ownerA.release();
    expect(existsSync(ownerA.root)).toBe(false);
    expect(existsSync(ownerB.root)).toBe(true);

    await ownerB.release();
    expect(existsSync(ownerB.root)).toBe(false);
  });

  it("bounds ownerless roots and exposes a process-cleanup seam", async () => {
    const extractions = registry(2);
    const roots: string[] = [];
    for (const label of ["one", "two", "three"]) {
      const root = extractions.rootForSessionTempRoot(temporaryRoot(label));
      roots.push(root);
      await extractions.extractFiles(root, "demo", {
        "reference.txt": label,
      });
    }
    await extractions.waitForCleanup();

    expect(extractions.snapshot().ownerlessRootCount).toBe(2);
    expect(existsSync(roots[0]!)).toBe(false);
    expect(existsSync(roots[1]!)).toBe(true);
    expect(existsSync(roots[2]!)).toBe(true);

    await extractions.cleanupAll();
    expect(extractions.snapshot().roots).toEqual([]);
    expect(existsSync(roots[1]!)).toBe(false);
    expect(existsSync(roots[2]!)).toBe(false);
  });

  it("retries after a failed extraction instead of caching the rejection", async () => {
    const sessionTempRoot = temporaryRoot("retry");
    const extractions = registry();
    const owner = extractions.retain(sessionTempRoot);

    await expect(
      extractions.extractFiles(owner.root, "demo", {
        "../escape.txt": "blocked",
      }),
    ).resolves.toBeNull();

    const extracted = await extractions.extractFiles(owner.root, "demo", {
      "references/guide.md": "retry succeeded",
    });
    expect(extracted).toBe(join(owner.root, "demo"));
    expect(
      readFileSync(join(owner.root, "demo", "references", "guide.md"), "utf8"),
    ).toBe("retry succeeded");

    await owner.release();
  });

  it.skipIf(process.platform === "win32")(
    "rejects a preseeded symlink without touching its outside target",
    async () => {
      const sessionTempRoot = temporaryRoot("symlink-root");
      const outsideRoot = temporaryRoot("symlink-outside");
      const outsideFile = join(outsideRoot, "outside.txt");
      writeFileSync(outsideFile, "outside remains unchanged");
      const extractions = registry();
      const owner = extractions.retain(sessionTempRoot);
      const skillRoot = join(owner.root, "demo");
      mkdirSync(skillRoot, { recursive: true, mode: 0o700 });
      symlinkSync(outsideFile, join(skillRoot, "reference.txt"), "file");

      await expect(
        extractions.extractFiles(owner.root, "demo", {
          "reference.txt": "attacker-controlled overwrite",
        }),
      ).resolves.toBeNull();
      expect(readFileSync(outsideFile, "utf8")).toBe(
        "outside remains unchanged",
      );

      await owner.release();
    },
  );

  it("serializes concurrent extraction without a per-skill cache", async () => {
    const sessionTempRoot = temporaryRoot("concurrent");
    const extractions = registry();
    const owner = extractions.retain(sessionTempRoot);
    const files = { "references/guide.md": "same content" };

    const [first, second] = await Promise.all([
      extractions.extractFiles(owner.root, "demo", files),
      extractions.extractFiles(owner.root, "demo", files),
    ]);

    expect(first).toBe(join(owner.root, "demo"));
    expect(second).toBe(first);
    expect(extractions.snapshot().roots).toEqual([
      expect.objectContaining({ activeOperations: 0, ownerCount: 1 }),
    ]);

    await owner.release();
  });
});
