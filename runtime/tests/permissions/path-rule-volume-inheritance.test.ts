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

const SENSITIVE_HOME: readonly (readonly [string, PathCaseSemantics])[] = [
  ["/agenc-case-root/u", "sensitive"],
  ["/agenc-case-root/u/proj", "insensitive"],
];
const INSENSITIVE_HOME: readonly (readonly [string, PathCaseSemantics])[] = [
  ["/agenc-case-root/u", "insensitive"],
  ["/agenc-case-root/u/proj", "insensitive"],
];
const SENSITIVE_LEAF: readonly (readonly [string, PathCaseSemantics])[] = [
  ["/agenc-case-root/u", "insensitive"],
  ["/agenc-case-root/u/proj", "insensitive"],
  ["/agenc-case-root/u/proj/private", "sensitive"],
];
const PRO_STAR = {
  rule: "/agenc-case-root/u/Pro*/a.txt",
  candidate: "/agenc-case-root/u/proj/a.txt",
} as const;
const PRIVATE_GLOB = {
  rule: "/agenc-case-root/u/*/Private/*.txt",
  candidate: "/agenc-case-root/u/proj/PRIVATE/a.txt",
} as const;

function foldCase(
  label: string,
  volumes: readonly (readonly [string, PathCaseSemantics])[],
  pattern: { readonly rule: string; readonly candidate: string },
  tail: "narrow" | "wide",
  matches: boolean,
) {
  return {
    label,
    volumes,
    rule: pattern.rule,
    candidate: pattern.candidate,
    tail,
    matches,
  };
}

function writePermission(
  behavior: "allow" | "deny",
  rule: string,
  candidate: string,
) {
  const context = applyPermissionUpdate(createEmptyToolPermissionContext(), {
    type: "addRules",
    destination: "session",
    behavior,
    rules: [{ toolName: "Write", ruleContent: rule }],
  });
  return checkToolPathPermission({
    toolName: "Write",
    input: { file_path: candidate },
    path: candidate,
    cwd: "/agenc-case-root/u",
    context,
    operationType: "write",
  });
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
      ["/agenc-case-root", "insensitive"],
      ["/agenc-case-root/u", "insensitive"],
      ["/agenc-case-root/u/proj", "sensitive"],
      ["/agenc-case-root/u/proj/private", "insensitive"],
    ]);
    withVolumes(mixed, () => {
      expect(
        matchPathRuleContent("/agenc-case-root/u/*/Private/*.txt", "/agenc-case-root/u/proj/private/a.txt", undefined, "narrow"),
      ).toBe(false);
      expect(
        matchPathRuleContent(
          "/agenc-case-root/u/*/Private/*.txt",
          "/agenc-case-root/u/proj/private/a.txt",
          undefined,
          "wide",
        ),
      ).toBe(true);
    });
    withVolumes(
      new Map<string, PathCaseSemantics>([
        ["/agenc-case-root", "insensitive"],
        ["/agenc-case-root/u", "insensitive"],
        ["/agenc-case-root/u/proj", "insensitive"],
        ["/agenc-case-root/u/proj/private", "insensitive"],
      ]),
      () => {
        expect(
          matchPathRuleContent("/agenc-case-root/u/*/Private/*.txt", "/agenc-case-root/u/proj/private/a.txt", undefined, "narrow"),
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
    foldCase(
      "allow skips a sensitive directory that holds the first wildcard",
      SENSITIVE_HOME,
      PRO_STAR,
      "narrow",
      false,
    ),
    foldCase(
      "allow folds the first wildcard when that directory is insensitive",
      INSENSITIVE_HOME,
      PRO_STAR,
      "narrow",
      true,
    ),
    foldCase(
      "deny still folds when a later mount is insensitive",
      SENSITIVE_HOME,
      PRO_STAR,
      "wide",
      true,
    ),
    foldCase(
      "allow does not fold a sensitive leaf under an insensitive folder",
      SENSITIVE_LEAF,
      PRIVATE_GLOB,
      "narrow",
      false,
    ),
    foldCase(
      "deny folds when any directory from the wildcard down is insensitive",
      SENSITIVE_LEAF,
      PRIVATE_GLOB,
      "wide",
      true,
    ),
  ])("$label", ({ volumes, rule, candidate, tail, matches }) => {
    withVolumes(new Map<string, PathCaseSemantics>(volumes), () => {
      expect(matchPathRuleContent(rule, candidate, undefined, tail)).toBe(matches);
      if (tail !== "wide") return;
      expect(writePermission("deny", rule, candidate).behavior).toBe("deny");
    });
  });

  test("a read-only none glob uses the wide fold", () => {
    withVolumes(new Map<string, PathCaseSemantics>(SENSITIVE_LEAF), () => {
      const session = {
        sessionConfiguration: { cwd: "/agenc-case-root/u" },
        permissionModeRegistry: { current: () => createEmptyToolPermissionContext() },
        services: {
          sandboxExecutionBroker: {
            cwd: "/agenc-case-root/u",
            sessionTempRoot: "/tmp/agenc-readonly",
            executionAuthority: () => ({
              permissionProfile: {
                fileSystem: {
                  kind: "restricted",
                  entries: [
                    { path: { kind: "path", path: "/agenc-case-root/u" }, access: "read" },
                    { path: { kind: "glob", pattern: PRIVATE_GLOB.rule }, access: "none" },
                  ],
                },
              },
            }),
          },
        },
      } as Session;
      expect(readOnlyDelegationPathAllowed(session, PRIVATE_GLOB.candidate)).toBe(false);
      expect(readOnlyDelegationPathAllowed(session, "/agenc-case-root/u/proj/notes.txt")).toBe(true);
    });
  });

  test("an allow rule does not auto-allow a recased path across a sensitive directory", () => {
    withVolumes(new Map<string, PathCaseSemantics>(SENSITIVE_HOME), () => {
      expect(writePermission("allow", PRO_STAR.rule, PRO_STAR.candidate).behavior).toBe("ask");
    });
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
