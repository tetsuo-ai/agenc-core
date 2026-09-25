/**
 * Per-directory case verdicts (#2126 review).
 *
 * A missing directory inherits the nearest existing ancestor, including
 * segments after a wildcard. A sensitive mount does not inherit an
 * insensitive parent. The whole-path resolver is not used here:
 * `matchPathRuleContent` / `isPathInside` / `checkToolPathPermission` go
 * through `pathForComparison`.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  __setPathCaseDirectorySemanticsForTesting,
  type PathCaseSemantics,
} from "../../src/permissions/path-case.js";
import { readOnlyDelegationPathAllowed } from "../../src/agents/readonly-delegation.js";
import {
  __isPathInsideForTesting,
  checkToolPathPermission,
  matchPathRuleContent,
} from "../../src/permissions/path-validation.js";
import type { Session } from "../../src/session/session.js";
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
      expect(matchPathRuleContent("/parent/**/Secret.txt", "/parent/mount/Secret.txt", undefined, "narrow")).toBe(true);
      expect(matchPathRuleContent("/parent/*/Secret.txt", "/parent/mount/Secret.txt", undefined, "narrow")).toBe(true);
      expect(matchPathRuleContent("/parent/**/Secret.txt", "/parent/mount/secret.txt", undefined, "narrow")).toBe(false);
      expect(matchPathRuleContent("**/Secret.txt", "/parent/mount/Secret.txt", undefined, "narrow")).toBe(true);
      expect(matchPathRuleContent("**/Secret.txt", "/parent/mount/secret.txt", undefined, "narrow")).toBe(false);
      expect(matchPathRuleContent("**/*.TS", "/parent/mount/app.ts", undefined, "narrow")).toBe(false);
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
        expect(matchPathRuleContent("/mnt/**/Secret.txt", "/mnt/smb/Secret.txt", undefined, "narrow")).toBe(true);
        expect(matchPathRuleContent("/mnt/**/Secret.txt", "/mnt/smb/secret.txt", undefined, "narrow")).toBe(false);
        expect(matchPathRuleContent("/mnt/**/Secret.txt", "/mnt/smb/secret.txt")).toBe(true);
        expect(matchPathRuleContent("**/Secret.txt", "/mnt/smb/secret.txt", undefined, "narrow")).toBe(false);
        expect(matchPathRuleContent("**/*.TS", "/mnt/smb/app.ts", undefined, "narrow")).toBe(false);
        expect(matchPathRuleContent("**/Secret.txt", "/mnt/smb/secret.txt")).toBe(true);
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

  test("an allow wildcard does not widen across a case-sensitive directory", () => {
    const mixed = new Map<string, PathCaseSemantics>([
      ["/home", "insensitive"],
      ["/home/u", "insensitive"],
      ["/home/u/proj", "sensitive"],
      ["/home/u/proj/private", "insensitive"],
    ]);
    withVolumes(mixed, () => {
      expect(
        matchPathRuleContent("/home/u/*/Private/*.txt", "/home/u/proj/private/a.txt", undefined, "narrow"),
      ).toBe(false);
      expect(
        matchPathRuleContent(
          "/home/u/*/Private/*.txt",
          "/home/u/proj/private/a.txt",
          undefined,
          "wide",
        ),
      ).toBe(true);
    });
    withVolumes(
      new Map<string, PathCaseSemantics>([
        ["/home", "insensitive"],
        ["/home/u", "insensitive"],
        ["/home/u/proj", "insensitive"],
        ["/home/u/proj/private", "insensitive"],
      ]),
      () => {
        expect(
          matchPathRuleContent("/home/u/*/Private/*.txt", "/home/u/proj/private/a.txt", undefined, "narrow"),
        ).toBe(true);
      },
    );
  });

  test("deny still matches when a sensitive directory sits above an insensitive mount", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-case-mixed-"));
    const proj = join(root, "proj");
    const mount = join(proj, "private");
    await mkdir(mount, { recursive: true });
    try {
      forceDirectories(
        new Map<string, PathCaseSemantics>([
          [directoryKey(root), "insensitive"],
          [directoryKey(proj), "sensitive"],
          [directoryKey(mount), "insensitive"],
        ]),
      );
      const seeded = applyPermissionUpdate(createEmptyToolPermissionContext(), {
        type: "addRules",
        destination: "session",
        behavior: "deny",
        rules: [
          {
            toolName: "Write",
            ruleContent: join(root, "*", "Private", "*.txt"),
          },
        ],
      });
      const target = join(mount, "a.txt");
      const result = checkToolPathPermission({
        toolName: "Write",
        input: { file_path: target },
        path: target,
        cwd: root,
        context: seeded,
        operationType: "write",
      });
      expect(result.behavior).toBe("deny");
    } finally {
      __setPathCaseDirectorySemanticsForTesting(null);
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    {
      label: "allow skips a sensitive directory that holds the first wildcard",
      volumes: [
        ["/home/u", "sensitive"],
        ["/home/u/proj", "insensitive"],
      ] as const,
      rule: "/home/u/Pro*/a.txt",
      candidate: "/home/u/proj/a.txt",
      tail: "narrow" as const,
      matches: false,
    },
    {
      label: "allow folds the first wildcard when that directory is insensitive",
      volumes: [
        ["/home/u", "insensitive"],
        ["/home/u/proj", "insensitive"],
      ] as const,
      rule: "/home/u/Pro*/a.txt",
      candidate: "/home/u/proj/a.txt",
      tail: "narrow" as const,
      matches: true,
    },
    {
      label: "deny still folds when a later mount is insensitive",
      volumes: [
        ["/home/u", "sensitive"],
        ["/home/u/proj", "insensitive"],
      ] as const,
      rule: "/home/u/Pro*/a.txt",
      candidate: "/home/u/proj/a.txt",
      tail: "wide" as const,
      matches: true,
    },
    {
      label: "allow does not fold a sensitive leaf under an insensitive folder",
      volumes: [
        ["/home/u", "insensitive"],
        ["/home/u/proj", "insensitive"],
        ["/home/u/proj/private", "sensitive"],
      ] as const,
      rule: "/home/u/*/Private/*.txt",
      candidate: "/home/u/proj/PRIVATE/a.txt",
      tail: "narrow" as const,
      matches: false,
    },
    {
      label: "deny folds when any directory from the wildcard down is insensitive",
      volumes: [
        ["/home/u", "insensitive"],
        ["/home/u/proj", "insensitive"],
        ["/home/u/proj/private", "sensitive"],
      ] as const,
      rule: "/home/u/*/Private/*.txt",
      candidate: "/home/u/proj/PRIVATE/a.txt",
      tail: "wide" as const,
      matches: true,
    },
  ])("$label", ({ volumes, rule, candidate, tail, matches }) => {
    withVolumes(new Map<string, PathCaseSemantics>(volumes), () => {
      expect(matchPathRuleContent(rule, candidate, undefined, tail)).toBe(matches);
      if (tail !== "wide") return;
      const seeded = applyPermissionUpdate(createEmptyToolPermissionContext(), {
        type: "addRules",
        destination: "session",
        behavior: "deny",
        rules: [{ toolName: "Write", ruleContent: rule }],
      });
      const result = checkToolPathPermission({
        toolName: "Write",
        input: { file_path: candidate },
        path: candidate,
        cwd: "/home/u",
        context: seeded,
        operationType: "write",
      });
      expect(result.behavior).toBe("deny");
    });
  });

  test("a read-only none glob uses the wide fold", () => {
    withVolumes(
      new Map<string, PathCaseSemantics>([
        ["/home/u", "insensitive"],
        ["/home/u/proj", "insensitive"],
        ["/home/u/proj/private", "sensitive"],
      ]),
      () => {
        const session = {
          sessionConfiguration: { cwd: "/home/u" },
          permissionModeRegistry: { current: () => createEmptyToolPermissionContext() },
          services: {
            sandboxExecutionBroker: {
              cwd: "/home/u",
              sessionTempRoot: "/tmp/agenc-readonly",
              executionAuthority: () => ({
                permissionProfile: {
                  fileSystem: {
                    entries: [
                      {
                        path: { kind: "glob", pattern: "/home/u/*/Private/*.txt" },
                        access: "none",
                      },
                    ],
                  },
                },
              }),
            },
          },
        } as Session;
        expect(readOnlyDelegationPathAllowed(session, "/home/u/proj/PRIVATE/a.txt")).toBe(false);
      },
    );
  });

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
