import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  __setAtomicArtifactOperationForTesting,
  AtomicArtifactUnsafePathError,
  cleanupOrphanedArtifactTemps,
  commitArtifactAtomically,
} from "../../src/durability/atomic-artifact.js";

// macOS has no traversable descriptor path for a directory, so the helper runs
// in its witnessed-path mode there: children are addressed through the
// canonical path, and every directory mutation must be witnessed by the pinned
// directory descriptor. These tests pin that mode's contract. They are darwin
// only because the descriptor mode on Linux makes the injected swaps inert.
describe.runIf(process.platform === "darwin")(
  "atomic artifact commit on macOS (witnessed-path mode)",
  () => {
    const directories: string[] = [];

    afterEach(() => {
      __setAtomicArtifactOperationForTesting(undefined);
      for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    function swapFixture(): {
      trustedRoot: string;
      movedRoot: string;
      outsideRoot: string;
      targetPath: string;
    } {
      const container = mkdtempSync(join(tmpdir(), "agenc-artifact-darwin-"));
      directories.push(container);
      const trustedRoot = join(container, "tool-results");
      const movedRoot = join(container, "tool-results-original");
      const outsideRoot = join(container, "outside");
      mkdirSync(trustedRoot);
      mkdirSync(outsideRoot);
      return {
        trustedRoot,
        movedRoot,
        outsideRoot,
        targetPath: join(trustedRoot, "result.txt"),
      };
    }

    it("publishes complete bytes through the witnessed path and replays idempotently", async () => {
      const directory = mkdtempSync(join(tmpdir(), "agenc-artifact-darwin-"));
      directories.push(directory);
      const path = join(directory, "artifact.txt");

      await expect(
        commitArtifactAtomically(path, "complete bytes", {
          trustedRoot: directory,
        }),
      ).resolves.toBe("committed");
      await expect(
        commitArtifactAtomically(path, "complete bytes", {
          trustedRoot: directory,
        }),
      ).resolves.toBe("already_committed");

      expect(readFileSync(path, "utf8")).toBe("complete bytes");
      expect(readdirSync(directory)).toEqual(["artifact.txt"]);
    });

    it("refuses to publish when the root is swapped between the temp write and the link", async () => {
      const fixture = swapFixture();
      __setAtomicArtifactOperationForTesting(({ operation }) => {
        if (operation !== "commit_before_link") return;
        // The temp already exists inside the real root. Swap the lexical path
        // to a directory that does not contain it.
        renameSync(fixture.trustedRoot, fixture.movedRoot);
        symlinkSync(fixture.outsideRoot, fixture.trustedRoot, "dir");
      });

      await expect(
        commitArtifactAtomically(fixture.targetPath, "must stay contained", {
          trustedRoot: fixture.trustedRoot,
        }),
      ).rejects.toBeInstanceOf(AtomicArtifactUnsafePathError);

      expect(existsSync(join(fixture.outsideRoot, "result.txt"))).toBe(false);
      expect(existsSync(join(fixture.movedRoot, "result.txt"))).toBe(false);
      // The temp written before the swap is an orphan in the real root now,
      // and the ordinary orphan sweep removes it.
      const orphans = readdirSync(fixture.movedRoot);
      expect(orphans.every((name) => name.endsWith(".tmp"))).toBe(true);
      await expect(
        cleanupOrphanedArtifactTemps(join(fixture.movedRoot, "result.txt"), {
          trustedRoot: fixture.movedRoot,
        }),
      ).resolves.toEqual({ removedCount: orphans.length, truncated: false });
      expect(readdirSync(fixture.movedRoot)).toEqual([]);
    });

    it("retracts a publication the pinned directory did not witness", async () => {
      const fixture = swapFixture();
      __setAtomicArtifactOperationForTesting(({ operation }) => {
        if (operation !== "commit_before_link") return;
        // Mirror the fresh temp into the outside directory by hard link, so the
        // link() by pathname SUCCEEDS there after the swap. The pinned root
        // sees no mutation, and the retraction must remove exactly that inode.
        for (const name of readdirSync(fixture.trustedRoot)) {
          linkSync(
            join(fixture.trustedRoot, name),
            join(fixture.outsideRoot, name),
          );
        }
        renameSync(fixture.trustedRoot, fixture.movedRoot);
        symlinkSync(fixture.outsideRoot, fixture.trustedRoot, "dir");
      });

      await expect(
        commitArtifactAtomically(fixture.targetPath, "must stay contained", {
          trustedRoot: fixture.trustedRoot,
        }),
      ).rejects.toBeInstanceOf(AtomicArtifactUnsafePathError);

      expect(existsSync(join(fixture.outsideRoot, "result.txt"))).toBe(false);
      expect(existsSync(join(fixture.movedRoot, "result.txt"))).toBe(false);
      // Only temps remain anywhere; nothing was acknowledged as published.
      expect(
        [...readdirSync(fixture.outsideRoot), ...readdirSync(fixture.movedRoot)]
          .every((name) => name.endsWith(".tmp")),
      ).toBe(true);
    });

    it("refuses to sweep orphans through a swapped path", async () => {
      const fixture = swapFixture();
      const tempName = "result.txt.101.orphan.tmp";
      const outsideTemp = join(fixture.outsideRoot, tempName);
      mkdirSync(fixture.movedRoot);
      rmSync(fixture.movedRoot, { recursive: true });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(fixture.trustedRoot, tempName), "owned orphan");
      writeFileSync(outsideTemp, "must stay");
      __setAtomicArtifactOperationForTesting(({ operation }) => {
        if (operation !== "cleanup") return;
        renameSync(fixture.trustedRoot, fixture.movedRoot);
        symlinkSync(fixture.outsideRoot, fixture.trustedRoot, "dir");
      });

      await expect(
        cleanupOrphanedArtifactTemps(fixture.targetPath, {
          trustedRoot: fixture.trustedRoot,
        }),
      ).rejects.toBeInstanceOf(AtomicArtifactUnsafePathError);

      expect(readFileSync(outsideTemp, "utf8")).toBe("must stay");
      expect(readFileSync(join(fixture.movedRoot, tempName), "utf8")).toBe(
        "owned orphan",
      );
    });
  },
);
