import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { withPinnedOfflineRolloutLease } from "../../src/durability/offline-rollout.js";

const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function fixture(rootName: "sessions" | "archived_sessions" = "sessions") {
  const root = mkdtempSync(join(tmpdir(), "agenc-offline-rollout-"));
  created.push(root);
  const projectDir = join(root, "project");
  const sessionId = "session-1";
  const sessionDirectory = join(projectDir, rootName, sessionId);
  const sourcePath = join(
    sessionDirectory,
    "rollout-2026-07-18T00-00-00-000Z-session-1.jsonl",
  );
  mkdirSync(sessionDirectory, { recursive: true });
  writeFileSync(sourcePath, "committed\n", { mode: 0o600 });
  return { root, projectDir, sessionId, sessionDirectory, sourcePath };
}

describe.skipIf(process.platform === "win32")(
  "descriptor-pinned offline rollout mutation",
  () => {
    it.each(["sessions", "archived_sessions"] as const)(
      "accepts only an exact regular rollout below %s",
      (rootName) => {
        const target = fixture(rootName);
        withPinnedOfflineRolloutLease(target, (rollout) => {
          expect(rollout.readUtf8()).toBe("committed\n");
          rollout.appendAndSync("review\n");
        });
        expect(readFileSync(target.sourcePath, "utf8")).toBe(
          "committed\nreview\n",
        );
      },
    );

    it("rejects an external binding and a source symlink without touching the target", () => {
      const target = fixture();
      const external = join(
        target.root,
        "rollout-2026-07-18T00-00-00-000Z-external.jsonl",
      );
      writeFileSync(external, "external\n", { mode: 0o600 });

      expect(() =>
        withPinnedOfflineRolloutLease(
          { ...target, sourcePath: external },
          (rollout) => rollout.appendAndSync("must-not-append\n"),
        ),
      ).toThrow(/outside this project's sessions\/archived_sessions roots/);

      rmSync(target.sourcePath);
      symlinkSync(external, target.sourcePath);
      expect(() =>
        withPinnedOfflineRolloutLease(target, (rollout) =>
          rollout.appendAndSync("must-not-append\n"),
        ),
      ).toThrow(/source must be one regular, non-linked file/);
      expect(readFileSync(external, "utf8")).toBe("external\n");
    });

    it("rejects a source replacement after the lease without writing either inode", () => {
      const target = fixture();
      const original = join(target.sessionDirectory, "original.jsonl");

      expect(() =>
        withPinnedOfflineRolloutLease(target, (rollout) => {
          renameSync(target.sourcePath, original);
          writeFileSync(target.sourcePath, "replacement\n", { mode: 0o600 });
          rollout.appendAndSync("must-not-append\n");
        }),
      ).toThrow(/source changed during offline mutation/);
      expect(readFileSync(original, "utf8")).toBe("committed\n");
      expect(readFileSync(target.sourcePath, "utf8")).toBe("replacement\n");
    });

    it("rejects a parent replacement after the lease without following it", () => {
      const target = fixture();
      const originalDirectory = join(target.root, "original-session");

      expect(() =>
        withPinnedOfflineRolloutLease(target, (rollout) => {
          renameSync(target.sessionDirectory, originalDirectory);
          mkdirSync(target.sessionDirectory);
          writeFileSync(
            join(target.sessionDirectory, basename(target.sourcePath)),
            "replacement\n",
            { mode: 0o600 },
          );
          rollout.appendAndSync("must-not-append\n");
        }),
      ).toThrow(/directory changed during offline mutation/);
      expect(
        readFileSync(join(originalDirectory, basename(target.sourcePath)), "utf8"),
      ).toBe("committed\n");
      expect(readFileSync(target.sourcePath, "utf8")).toBe("replacement\n");
    });

    it("scans past a partial tail larger than one MiB without losing the committed prefix", () => {
      const target = fixture();
      writeFileSync(
        target.sourcePath,
        `committed\n${"x".repeat(1024 * 1024 + 257)}`,
        { mode: 0o600 },
      );

      withPinnedOfflineRolloutLease(target, (rollout) => {
        expect(rollout.readUtf8()).toBe("committed\n");
        rollout.appendAndSync("review\n");
      });
      expect(readFileSync(target.sourcePath, "utf8")).toBe(
        "committed\nreview\n",
      );
    });
  },
);
