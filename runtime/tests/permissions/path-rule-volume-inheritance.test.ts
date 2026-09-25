/**
 * Per-directory case verdicts (#2126 review).
 *
 * A missing directory inherits the nearest existing ancestor, including
 * segments after a wildcard. A sensitive mount does not inherit an
 * insensitive parent. The whole-path resolver is not used here:
 * `matchPathRuleContent` / `isPathInside` / `checkToolPathPermission` go
 * through `pathForComparison`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  __setPathCaseDirectorySemanticsForTesting,
  type PathCaseSemantics,
} from "../../src/permissions/path-case.js";
import {
  __isPathInsideForTesting,
  checkToolPathPermission,
  matchPathRuleContent,
} from "../../src/permissions/path-validation.js";
import { applyPermissionUpdate } from "../../src/permissions/permission-updates.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";

function directoryKey(directory: string): string {
  const slash = directory.replaceAll("\\", "/").toLowerCase();
  return slash.length > 1 && slash.endsWith("/") ? slash.slice(0, -1) : slash;
}

function forceDirectories(
  volumes: ReadonlyMap<string, PathCaseSemantics>,
): void {
  __setPathCaseDirectorySemanticsForTesting((directory) =>
    volumes.get(directoryKey(directory)),
  );
}

function withVolumes(
  volumes: ReadonlyMap<string, PathCaseSemantics>,
  run: () => void,
): void {
  forceDirectories(volumes);
  try {
    run();
  } finally {
    __setPathCaseDirectorySemanticsForTesting(null);
  }
}

describe("pathForComparison inherits only the probed volume", () => {
  test("a new entry under a sensitive mount does not inherit the parent", () => {
    const volumes = new Map<string, PathCaseSemantics>([
      ["/parent", "insensitive"],
      ["/parent/mount", "sensitive"],
    ]);
    withVolumes(volumes, () => {
      expect(
        matchPathRuleContent(
          "/parent/Mount/New/Secret.txt",
          "/parent/mount/NEW/SECRET.txt",
        ),
      ).toBe(false);
      expect(
        matchPathRuleContent(
          "/parent/Mount/Secret.txt",
          "/parent/Mount/SECRET.txt",
        ),
      ).toBe(false);
      expect(
        __isPathInsideForTesting(
          "/parent/Mount/New/Secret.txt",
          "/parent/mount/SECRET",
        ),
      ).toBe(false);
      expect(
        __isPathInsideForTesting("/parent/Mount/New/Secret.txt", "/parent/Mount"),
      ).toBe(true);
      expect(matchPathRuleContent("/parent/**/Secret.txt", "/parent/mount/Secret.txt")).toBe(true);
      expect(matchPathRuleContent("/parent/*/Secret.txt", "/parent/mount/Secret.txt")).toBe(true);
      expect(matchPathRuleContent("/parent/**/Secret.txt", "/parent/mount/secret.txt")).toBe(false);
      expect(matchPathRuleContent("**/Secret.txt", "/parent/mount/Secret.txt")).toBe(true);
      expect(matchPathRuleContent("**/Secret.txt", "/parent/mount/secret.txt")).toBe(false);
      expect(matchPathRuleContent("**/*.TS", "/parent/mount/app.ts")).toBe(false);
    });
  });

  test("a wildcard tail follows an insensitive share, not the parent volume", () => {
    withVolumes(
      new Map<string, PathCaseSemantics>([
        ["/", "sensitive"],
        ["/mnt", "sensitive"],
        ["/mnt/smb", "insensitive"],
      ]),
      () => {
        expect(matchPathRuleContent("/mnt/**/Secret.txt", "/mnt/smb/Secret.txt")).toBe(true);
        expect(matchPathRuleContent("/mnt/**/Secret.txt", "/mnt/smb/secret.txt")).toBe(true);
        expect(matchPathRuleContent("**/Secret.txt", "/mnt/smb/secret.txt")).toBe(true);
        expect(matchPathRuleContent("**/*.TS", "/mnt/smb/app.ts")).toBe(true);
      },
    );
  });

  test.each([
    ["insensitive", true],
    ["sensitive", false],
  ] as const)(
    "a missing intermediate directory on an %s volume",
    (semantics, matches) => {
      const volumes = new Map<string, PathCaseSemantics>([
        ["c:", semantics],
        ["c:/work", semantics],
      ]);
      withVolumes(volumes, () => {
        expect(
          matchPathRuleContent(
            "C:/Work/New/Secret.txt",
            "c:/work/NEW/SECRET.txt",
          ),
        ).toBe(matches);
        expect(
          matchPathRuleContent("C:/Work/**/*.TXT", "c:/work/deep/secret.txt"),
        ).toBe(matches);
        expect(
          matchPathRuleContent("C:/Work/**", "c:/workspace/file.txt"),
        ).toBe(false);
        expect(
          __isPathInsideForTesting(
            "C:/Work/New/Secret.txt",
            "C:/Work/NEW",
          ),
        ).toBe(matches);
      });
    },
  );

  test("deny still matches a recased path under a not-yet-existing directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-case-inherit-"));
    const realRoot = root;
    try {
      forceDirectories(
        new Map<string, PathCaseSemantics>([[directoryKey(realRoot), "insensitive"]]),
      );
      const empty = createEmptyToolPermissionContext();
      const seeded = applyPermissionUpdate(empty, {
        type: "addRules",
        destination: "session",
        behavior: "deny",
        rules: [
          {
            toolName: "Write",
            ruleContent: join(realRoot, "New", "Secret.txt"),
          },
        ],
      });
      const result = checkToolPathPermission({
        toolName: "Write",
        input: { file_path: join(realRoot, "NEW", "SECRET.txt") },
        path: join(realRoot, "NEW", "SECRET.txt"),
        cwd: realRoot,
        context: seeded,
        operationType: "write",
      });
      expect(result.behavior).toBe("deny");
      expect(result.decisionReason?.type).toBe("rule");
    } finally {
      __setPathCaseDirectorySemanticsForTesting(null);
      await rm(root, { recursive: true, force: true });
    }
  });
});
