import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AtomicArtifactOperationUnsupportedError,
  cleanupOrphanedArtifactTemps,
  cleanupOrphanedArtifactTempsSync,
  commitArtifactAtomically,
} from "../../src/durability/atomic-artifact.js";

if (process.platform !== "win32") {
  throw new Error("the native atomic-artifact integration tests require Windows");
}

describe("atomic artifact commit on Windows", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function target(): { directory: string; path: string } {
    const directory = mkdtempSync(join(tmpdir(), "agenc-artifact-"));
    directories.push(directory);
    return { directory, path: join(directory, "artifact.txt") };
  }

  it(
    "fails closed when publication has no descriptor-relative child operations",
    async () => {
      const artifact = target();

      await expect(
        commitArtifactAtomically(artifact.path, "must not publish", {
          trustedRoot: artifact.directory,
        }),
      ).rejects.toBeInstanceOf(AtomicArtifactOperationUnsupportedError);
      expect(existsSync(artifact.path)).toBe(false);
    },
  );

  it(
    "fails closed when cleanup has no descriptor-relative child operations",
    async () => {
      const artifact = target();
      writeFileSync(`${artifact.path}.101.orphan.tmp`, "must stay");

      await expect(
        cleanupOrphanedArtifactTemps(artifact.path, {
          trustedRoot: artifact.directory,
        }),
      ).rejects.toBeInstanceOf(AtomicArtifactOperationUnsupportedError);
      expect(() =>
        cleanupOrphanedArtifactTempsSync(artifact.path, {
          trustedRoot: artifact.directory,
        }),
      ).toThrow(AtomicArtifactOperationUnsupportedError);
      expect(readFileSync(`${artifact.path}.101.orphan.tmp`, "utf8")).toBe(
        "must stay",
      );
    },
  );
});
