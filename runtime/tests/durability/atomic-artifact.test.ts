import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  __setAtomicArtifactOperationForTesting,
  AtomicArtifactConflictError,
  AtomicArtifactOperationUnsupportedError,
  AtomicArtifactUnsafePathError,
  cleanupOrphanedArtifactTemps,
  cleanupOrphanedArtifactTempsSync,
  commitArtifactAtomically,
  withAtomicArtifactObservationSync,
} from "../../src/durability/atomic-artifact.js";
import { M4DurabilityFailpointError } from "../../src/durability/failpoints.js";

const FAILPOINT_ENV = "AGENC_TEST_DURABILITY_FAILPOINT";
const TOKEN_ENV = "AGENC_TEST_DURABILITY_FAILPOINT_TOKEN";
const ACTION_ENV = "AGENC_TEST_DURABILITY_FAILPOINT_ACTION";
const HAS_DESCRIPTOR_CHILD_PATHS =
  process.platform === "linux" || process.platform === "darwin";

describe("atomic artifact commit", () => {
  const directories: string[] = [];

  afterEach(() => {
    __setAtomicArtifactOperationForTesting(undefined);
    delete process.env[FAILPOINT_ENV];
    delete process.env[TOKEN_ENV];
    delete process.env[ACTION_ENV];
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function target(name = "artifact.txt"): { directory: string; path: string } {
    const directory = mkdtempSync(join(tmpdir(), "agenc-artifact-"));
    directories.push(directory);
    return { directory, path: join(directory, name) };
  }

  it.runIf(HAS_DESCRIPTOR_CHILD_PATHS)(
    "publishes complete bytes and treats an identical replay as idempotent",
    async () => {
      const artifact = target();
      await expect(
        commitArtifactAtomically(artifact.path, "complete bytes", {
          trustedRoot: artifact.directory,
        }),
      ).resolves.toBe("committed");
      await expect(
        commitArtifactAtomically(artifact.path, "complete bytes", {
          trustedRoot: artifact.directory,
        }),
      ).resolves.toBe("already_committed");

      expect(readFileSync(artifact.path, "utf8")).toBe("complete bytes");
      expect(readdirSync(artifact.directory)).toEqual(["artifact.txt"]);
    },
  );

  it.runIf(HAS_DESCRIPTOR_CHILD_PATHS)(
    "never overwrites immutable evidence with conflicting replay bytes",
    async () => {
      const artifact = target();
      await commitArtifactAtomically(artifact.path, "first", {
        trustedRoot: artifact.directory,
      });

      await expect(
        commitArtifactAtomically(artifact.path, "second", {
          trustedRoot: artifact.directory,
        }),
      ).rejects.toBeInstanceOf(AtomicArtifactConflictError);
      expect(readFileSync(artifact.path, "utf8")).toBe("first");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a symlink even when its destination has identical bytes",
    async () => {
      const artifact = target();
      const external = join(artifact.directory, "external.txt");
      writeFileSync(external, "same bytes");
      symlinkSync(external, artifact.path);

      await expect(
        commitArtifactAtomically(artifact.path, "same bytes", {
          trustedRoot: artifact.directory,
        }),
      ).rejects.toBeInstanceOf(AtomicArtifactConflictError);
      expect(readFileSync(external, "utf8")).toBe("same bytes");
    },
  );

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "allows symlinked ancestors above the explicit trusted root",
    async () => {
      const physicalContainer = mkdtempSync(
        join(tmpdir(), "agenc-artifact-physical-"),
      );
      const aliasContainer = mkdtempSync(
        join(tmpdir(), "agenc-artifact-alias-"),
      );
      directories.push(physicalContainer, aliasContainer);
      const physicalRoot = join(physicalContainer, "tool-results");
      mkdirSync(physicalRoot);
      const aliasAncestor = join(aliasContainer, "workspace");
      symlinkSync(physicalContainer, aliasAncestor, "dir");
      const trustedRoot = join(aliasAncestor, "tool-results");
      const targetPath = join(trustedRoot, "result.txt");

      await expect(
        commitArtifactAtomically(targetPath, "complete bytes", { trustedRoot }),
      ).resolves.toBe("committed");
      writeFileSync(`${targetPath}.101.orphan.tmp`, "orphan");
      await expect(
        cleanupOrphanedArtifactTemps(targetPath, { trustedRoot }),
      ).resolves.toEqual({ removedCount: 1, truncated: false });
      writeFileSync(`${targetPath}.102.orphan.tmp`, "orphan");
      expect(
        cleanupOrphanedArtifactTempsSync(targetPath, { trustedRoot }),
      ).toEqual({ removedCount: 1, truncated: false });

      expect(readFileSync(join(physicalRoot, "result.txt"), "utf8")).toBe(
        "complete bytes",
      );
      expect(readdirSync(physicalRoot)).toEqual(["result.txt"]);
    },
  );

  it("rejects a target outside the explicit trusted root", async () => {
    const trusted = target("inside.txt");
    const outside = target("outside.txt");

    await expect(
      commitArtifactAtomically(outside.path, "must not publish", {
        trustedRoot: trusted.directory,
      }),
    ).rejects.toBeInstanceOf(AtomicArtifactUnsafePathError);
    await expect(
      cleanupOrphanedArtifactTemps(outside.path, {
        trustedRoot: trusted.directory,
      }),
    ).rejects.toBeInstanceOf(AtomicArtifactUnsafePathError);
    expect(existsSync(outside.path)).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "refuses to publish through a symlinked parent directory",
    async () => {
      const artifact = target();
      const external = join(artifact.directory, "external");
      const linkedParent = join(artifact.directory, "tool-results");
      mkdirSync(external);
      symlinkSync(external, linkedParent, "dir");

      await expect(
        commitArtifactAtomically(join(linkedParent, "result.txt"), "bytes", {
          trustedRoot: artifact.directory,
        }),
      ).rejects.toBeInstanceOf(AtomicArtifactUnsafePathError);
      expect(existsSync(join(external, "result.txt"))).toBe(false);
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses async orphan cleanup through a symlinked parent directory",
    async () => {
      const artifact = target();
      const external = join(artifact.directory, "external");
      const linkedParent = join(artifact.directory, "tool-results");
      mkdirSync(external);
      symlinkSync(external, linkedParent, "dir");
      const externalTemp = join(external, "result.txt.101.external.tmp");
      writeFileSync(externalTemp, "must stay");

      await expect(
        cleanupOrphanedArtifactTemps(join(linkedParent, "result.txt"), {
          trustedRoot: artifact.directory,
        }),
      ).rejects.toBeInstanceOf(AtomicArtifactUnsafePathError);
      expect(readFileSync(externalTemp, "utf8")).toBe("must stay");
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses synchronous orphan cleanup through a symlinked parent directory",
    () => {
      const artifact = target();
      const external = join(artifact.directory, "external");
      const linkedParent = join(artifact.directory, "tool-results");
      mkdirSync(external);
      symlinkSync(external, linkedParent, "dir");
      const externalTemp = join(external, "result.txt.102.external.tmp");
      writeFileSync(externalTemp, "must stay");

      expect(() =>
        cleanupOrphanedArtifactTempsSync(join(linkedParent, "result.txt"), {
          trustedRoot: artifact.directory,
        }),
      ).toThrow(AtomicArtifactUnsafePathError);
      expect(readFileSync(externalTemp, "utf8")).toBe("must stay");
    },
  );

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "does not publish outside when the pinned root is swapped after validation",
    async () => {
      const container = mkdtempSync(
        join(tmpdir(), "agenc-artifact-commit-swap-"),
      );
      directories.push(container);
      const trustedRoot = join(container, "tool-results");
      const movedRoot = join(container, "tool-results-original");
      const outsideRoot = join(container, "outside");
      mkdirSync(trustedRoot);
      mkdirSync(outsideRoot);
      const targetPath = join(trustedRoot, "result.txt");
      __setAtomicArtifactOperationForTesting(({ operation }) => {
        if (operation !== "commit") return;
        renameSync(trustedRoot, movedRoot);
        symlinkSync(outsideRoot, trustedRoot, "dir");
      });

      await expect(
        commitArtifactAtomically(targetPath, "must stay contained", {
          trustedRoot,
        }),
      ).rejects.toBeInstanceOf(AtomicArtifactUnsafePathError);

      expect(existsSync(join(outsideRoot, "result.txt"))).toBe(false);
      expect(readdirSync(movedRoot)).toEqual([]);
    },
  );

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "keeps cleanup inside the pinned root when its lexical path is swapped",
    async () => {
      const container = mkdtempSync(join(tmpdir(), "agenc-artifact-swap-"));
      directories.push(container);
      const trustedRoot = join(container, "tool-results");
      const movedRoot = join(container, "tool-results-original");
      const outsideRoot = join(container, "outside");
      mkdirSync(trustedRoot);
      mkdirSync(outsideRoot);
      const targetPath = join(trustedRoot, "result.txt");
      const tempName = "result.txt.101.orphan.tmp";
      writeFileSync(join(trustedRoot, tempName), "owned orphan");
      writeFileSync(join(outsideRoot, tempName), "must stay");
      __setAtomicArtifactOperationForTesting(({ operation }) => {
        if (operation !== "cleanup") return;
        renameSync(trustedRoot, movedRoot);
        symlinkSync(outsideRoot, trustedRoot, "dir");
      });

      await expect(
        cleanupOrphanedArtifactTemps(targetPath, { trustedRoot }),
      ).rejects.toBeInstanceOf(AtomicArtifactUnsafePathError);

      expect(existsSync(join(movedRoot, tempName))).toBe(false);
      expect(readFileSync(join(outsideRoot, tempName), "utf8")).toBe(
        "must stay",
      );
    },
  );

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "never consumes external matching bytes after an observation-root swap",
    () => {
      const container = mkdtempSync(
        join(tmpdir(), "agenc-artifact-observe-swap-"),
      );
      directories.push(container);
      const trustedRoot = join(container, "tool-results");
      const movedRoot = join(container, "tool-results-original");
      const outsideRoot = join(container, "outside");
      mkdirSync(trustedRoot);
      mkdirSync(outsideRoot);
      const targetPath = join(trustedRoot, "result.txt");
      const expected = "external matching bytes";
      writeFileSync(join(outsideRoot, "result.txt"), expected);
      __setAtomicArtifactOperationForTesting(({ operation }) => {
        if (operation !== "observe") return;
        renameSync(trustedRoot, movedRoot);
        symlinkSync(outsideRoot, trustedRoot, "dir");
      });
      let consumed = false;

      expect(() =>
        withAtomicArtifactObservationSync(
          targetPath,
          createHash("sha256").update(expected).digest("hex"),
          Buffer.byteLength(expected),
          { trustedRoot },
          () => {
            consumed = true;
          },
        ),
      ).toThrow(AtomicArtifactUnsafePathError);

      expect(consumed).toBe(false);
      expect(readFileSync(join(outsideRoot, "result.txt"), "utf8")).toBe(
        expected,
      );
    },
  );

  it.runIf(HAS_DESCRIPTOR_CHILD_PATHS)(
    "leaves no visible artifact when killed before publication",
    async () => {
      const artifact = target();
      process.env[FAILPOINT_ENV] = "before_artifact_commit";
      process.env[TOKEN_ENV] = "m4-durability-child";
      process.env[ACTION_ENV] = "throw";

      await expect(
        commitArtifactAtomically(artifact.path, "bytes", {
          trustedRoot: artifact.directory,
        }),
      ).rejects.toBeInstanceOf(M4DurabilityFailpointError);
      expect(existsSync(artifact.path)).toBe(false);
      expect(readdirSync(artifact.directory)).toEqual([]);
    },
  );

  it.runIf(HAS_DESCRIPTOR_CHILD_PATHS)(
    "leaves complete durable bytes when acknowledgement is lost after commit",
    async () => {
      const artifact = target();
      process.env[FAILPOINT_ENV] = "after_artifact_commit";
      process.env[TOKEN_ENV] = "m4-durability-child";
      process.env[ACTION_ENV] = "throw";

      await expect(
        commitArtifactAtomically(artifact.path, "bytes", {
          trustedRoot: artifact.directory,
        }),
      ).rejects.toBeInstanceOf(M4DurabilityFailpointError);
      expect(readFileSync(artifact.path, "utf8")).toBe("bytes");
      expect(readdirSync(artifact.directory)).toEqual(["artifact.txt"]);
    },
  );

  it.runIf(HAS_DESCRIPTOR_CHILD_PATHS)(
    "runs an identical replay through the durable commit boundary",
    async () => {
      const artifact = target();
      await commitArtifactAtomically(artifact.path, "bytes", {
        trustedRoot: artifact.directory,
      });
      process.env[FAILPOINT_ENV] = "after_artifact_commit";
      process.env[TOKEN_ENV] = "m4-durability-child";
      process.env[ACTION_ENV] = "throw";

      await expect(
        commitArtifactAtomically(artifact.path, "bytes", {
          trustedRoot: artifact.directory,
        }),
      ).rejects.toBeInstanceOf(M4DurabilityFailpointError);
      expect(readFileSync(artifact.path, "utf8")).toBe("bytes");
      expect(readdirSync(artifact.directory)).toEqual(["artifact.txt"]);
    },
  );

  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "cleans only bounded regular temp siblings for one exact target",
    async () => {
      const artifact = target();
      const firstTemp = `${artifact.path}.101.first.tmp`;
      const secondTemp = `${artifact.path}.102.second.tmp`;
      const siblingTemp = join(
        artifact.directory,
        "artifact.txt-other.103.tmp",
      );
      const matchingDirectory = `${artifact.path}.104.directory.tmp`;
      writeFileSync(firstTemp, "orphan one");
      writeFileSync(secondTemp, "orphan two");
      writeFileSync(siblingTemp, "must stay");
      mkdirSync(matchingDirectory);

      await expect(
        cleanupOrphanedArtifactTemps(artifact.path, {
          trustedRoot: artifact.directory,
          maxDeletes: 1,
        }),
      ).resolves.toEqual({ removedCount: 1, truncated: true });
      expect(
        cleanupOrphanedArtifactTempsSync(artifact.path, {
          trustedRoot: artifact.directory,
        }),
      ).toEqual({
        removedCount: 1,
        truncated: false,
      });

      expect(existsSync(firstTemp) || existsSync(secondTemp)).toBe(false);
      expect(readFileSync(siblingTemp, "utf8")).toBe("must stay");
      expect(existsSync(matchingDirectory)).toBe(true);
    },
  );

  it.runIf(process.platform === "win32")(
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

  it.runIf(process.platform === "win32")(
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
