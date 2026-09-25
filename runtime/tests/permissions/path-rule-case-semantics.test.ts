/**
 * Path rules follow the case semantics of the volume that holds the target
 * (#2126). On a case-insensitive volume `Secret.txt` and `SECRET.txt` are one
 * file, so a rule written either way must govern both spellings; on a
 * case-sensitive volume they are two files and must stay distinct.
 *
 * Filesystem probing is replaced with a fixed answer so both semantics run on
 * one host; the probe itself is checked against the real temp volume.
 */

import { lstatSync, unlinkSync } from "node:fs";
import { link, mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  __pathCaseDirectoryCachedForTesting,
  __pathCaseSemanticsCacheSizeForTesting,
  __setPathCaseDirectorySemanticsForTesting,
  __setPathCaseLstatForTesting,
  __setPathCaseSemanticsResolverForTesting,
  __swapAsciiCaseForTesting,
  parseComparisonRoot,
  pathCaseSemantics,
  pathForComparison,
  platformDefaultPathCaseSemantics,
  type PathCaseSemantics,
} from "../../src/permissions/path-case.js";
import {
  checkToolPathPermission,
  matchPathRuleContent,
} from "../../src/permissions/path-validation.js";
import { applyPermissionUpdate } from "../../src/permissions/permission-updates.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";

const flipCase = (text: string): string =>
  text.replace(/[A-Za-z]/g, (ch) =>
    ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase(),
  );

type FixtureKind =
  | "secret-recursive"
  | "secret-exact"
  | "secret-relative"
  | "secret-glob"
  | "data-recursive"
  | "recased-notes"
  | "recased-report"
  | "recased-cwd-notes";

function fixturePath(kind: FixtureKind, root: string, outside: string): string {
  switch (kind) {
    case "secret-recursive":
      return join(root, "Secret", "**");
    case "secret-exact":
      return join(root, "Secret", "Notes.txt");
    case "secret-relative":
      return "./Secret/**";
    case "secret-glob":
      return join(root, "Secret", "*.txt");
    case "data-recursive":
      return join(outside, "Data", "**");
    case "recased-notes":
      return join(root, flipCase("Secret"), flipCase("Notes.txt"));
    case "recased-report":
      return join(outside, flipCase("Data"), flipCase("Report.txt"));
    case "recased-cwd-notes":
      return join(flipCase(root), "Secret", "Notes.txt");
    default: {
      const _never: never = kind;
      return _never;
    }
  }
}

async function withCaseFixtures(
  run: (root: string, outside: string) => Promise<void> | void,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agenc-case-a-"));
  const outside = await mkdtemp(join(tmpdir(), "agenc-case-b-"));
  try {
    await mkdir(join(root, "Secret"), { recursive: true });
    await mkdir(join(outside, "Data"), { recursive: true });
    await writeFile(join(root, "Secret", "Notes.txt"), "notes");
    await writeFile(join(outside, "Data", "Report.txt"), "report");
    await run(root, outside);
  } finally {
    __setPathCaseSemanticsResolverForTesting(null);
    __setPathCaseDirectorySemanticsForTesting(null);
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
}

function decide(
  volume: PathCaseSemantics,
  cwd: string,
  path: string,
  toolName: "FileRead" | "Write",
  operationType: "read" | "write",
  rule?: { behavior: "allow" | "ask" | "deny"; content: string },
) {
  __setPathCaseSemanticsResolverForTesting(() => volume);
  const empty = createEmptyToolPermissionContext();
  const seeded = rule
    ? applyPermissionUpdate(empty, {
        type: "addRules",
        destination: "session",
        behavior: rule.behavior,
        rules: [{ toolName, ruleContent: rule.content }],
      })
    : empty;
  return checkToolPathPermission({
    toolName,
    input: { file_path: path },
    path,
    cwd,
    context: seeded,
    operationType,
  });
}

describe("matchPathRuleContent follows the target volume's case semantics", () => {
  test.each([
    ["exact path", "C:/Work/Secret.txt", "c:/work/SECRET.txt", true, false],
    ["exact path, backslash rule", "C:\\Work\\Secret.txt", "c:/work/secret.txt", true, false],
    ["exact path, backslash target", "C:/Work/Secret.txt", "c:\\WORK\\Secret.TXT", true, false],
    ["recursive prefix", "C:/Work/**", "c:\\work\\Sub\\FILE.txt", true, false],
    ["recursive prefix names its root", "C:/Work/**", "c:/WORK", true, false],
    ["single-level glob", "C:/Work/*.txt", "c:/work/Secret.TXT", true, false],
    ["double-star glob", "C:/Work/**/*.txt", "c:/WORK/deep/er/Secret.TXT", true, false],
    ["question-mark glob", "C:/Work/Secret.??t", "c:/work/SECRET.txt", true, false],
    ["POSIX recursive folds", "/Users/Me/Project/**", "/users/me/project/src/App.ts", true, false],
    ["POSIX recursive same spelling", "/Users/Me/Project/**", "/Users/Me/Project/src/App.ts", true, true],
    ["prefix does not swallow workspace sibling", "C:/Work/**", "c:/workspace/file.txt", false, false],
    ["single-level glob stays in one directory", "C:/Work/*.txt", "c:/work/sub/a.txt", false, false],
    ["exact path does not prefix-match", "C:/Work/Secret.txt", "c:/work/secret.txt.bak", false, false],
  ] as const)("%s", (_label, rule, target, insensitive, sensitive) => {
    expect(matchPathRuleContent(rule, target, "insensitive")).toBe(insensitive);
    expect(matchPathRuleContent(rule, target, "sensitive")).toBe(sensitive);
  });
});

describe("pathCaseSemantics probes the volume that holds the path", () => {
  async function observedSemantics(dir: string): Promise<PathCaseSemantics> {
    const probe = join(dir, "Probe.txt");
    await writeFile(probe, "probe");
    try {
      const [a, b] = await Promise.all([
        stat(probe),
        stat(join(dir, flipCase("Probe.txt"))),
      ]);
      return a.ino === b.ino && a.dev === b.dev ? "insensitive" : "sensitive";
    } catch {
      return "sensitive";
    }
  }

  test("an existing file reports what the volume does", async () => {
    await withCaseFixtures(async (root) => {
      const file = join(root, "Secret", "Notes.txt");
      expect(pathCaseSemantics(file)).toBe(await observedSemantics(root));
    });
  });

  test("a path that does not exist yet inherits from its nearest ancestor", async () => {
    await withCaseFixtures(async (root) => {
      expect(pathCaseSemantics(join(root, "Not", "Yet", "Created.txt"))).toBe(
        await observedSemantics(root),
      );
    });
  });

  test("a directory holding two names that differ only by case is case-sensitive", async () => {
    await withCaseFixtures(async (root) => {
      const lower = join(root, "same.txt");
      const upper = join(root, "SAME.TXT");
      await writeFile(lower, "lower");
      await writeFile(upper, "upper");
      const [a, b] = await Promise.all([stat(lower), stat(upper)]);
      expect(pathCaseSemantics(lower)).toBe(
        a.ino === b.ino ? "insensitive" : "sensitive",
      );
      if (a.ino !== b.ino) expect(pathCaseSemantics(upper)).toBe("sensitive");
    });
  });

  test("ß.txt is probed as ß.TXT, not SS.TXT", async () => {
    expect(__swapAsciiCaseForTesting("ß.txt")).toBe("ß.TXT");
    await withCaseFixtures(async (root) => {
      const dir = join(root, "unicode");
      await mkdir(dir);
      const eszett = join(dir, "ß.txt");
      await writeFile(eszett, "eszett");
      __setPathCaseSemanticsResolverForTesting(null);
      const volume = await observedSemantics(dir);
      expect(pathCaseSemantics(eszett)).toBe(volume);
      if (volume === "sensitive") {
        expect(pathForComparison(join(dir, "Notes.TXT"))).toBe(join(dir, "Notes.TXT"));
        await link(eszett, join(dir, "SS.TXT"));
        __setPathCaseSemanticsResolverForTesting(null);
        expect(pathCaseSemantics(eszett)).toBe("sensitive");
      }
    });
  });

  test.each([
    ["symlink", symlink],
    ["hardlink", link],
  ] as const)(
    "a case-twin %s does not make a sensitive directory insensitive",
    async (_kind, linkNames) => {
      await withCaseFixtures(async (root) => {
        const dir = join(root, "links");
        await mkdir(dir);
        const file = join(dir, "file.txt");
        const twin = join(dir, "FILE.TXT");
        await writeFile(file, "file");
        try {
          await linkNames(file, twin);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
          throw err;
        }
        __setPathCaseSemanticsResolverForTesting(null);
        expect(pathCaseSemantics(file)).toBe("sensitive");
        expect(pathCaseSemantics(twin)).toBe("sensitive");
      });
    },
  );

  test("the platform default applies when nothing on the path can be probed", () => {
    __setPathCaseSemanticsResolverForTesting(null);
    const separatorOnly = process.platform === "win32" ? "C:\\" : "/";
    expect(pathCaseSemantics(separatorOnly)).toBe(
      platformDefaultPathCaseSemantics(),
    );
    expect(platformDefaultPathCaseSemantics()).toBe(
      process.platform === "win32" || process.platform === "darwin"
        ? "insensitive"
        : "sensitive",
    );
  });
});

describe("allow, ask, and deny rules agree with filesystem identity", () => {
  test.each([
    ["insensitive recursive deny follows recased file", "insensitive", "FileRead", "read", "deny", "secret-recursive", "recased-notes", "deny", "rule", true],
    ["insensitive exact deny follows recased file", "insensitive", "FileRead", "read", "deny", "secret-exact", "recased-notes", "deny", "rule", false],
    ["insensitive relative deny follows recased file", "insensitive", "FileRead", "read", "deny", "secret-relative", "recased-notes", "deny", "rule", false],
    ["insensitive glob deny follows recased file", "insensitive", "Write", "write", "deny", "secret-glob", "recased-notes", "deny", "rule", false],
    ["insensitive ask prompts for recased file", "insensitive", "Write", "write", "ask", "secret-recursive", "recased-notes", "ask", "rule", false],
    ["insensitive allow authorizes recased file", "insensitive", "Write", "write", "allow", "data-recursive", "recased-report", "allow", "rule", false],
    ["insensitive cwd contains recased spelling", "insensitive", "FileRead", "read", null, null, "recased-cwd-notes", "allow", "mode", false],
    ["sensitive recursive deny ignores recased file", "sensitive", "FileRead", "read", "deny", "secret-recursive", "recased-notes", "allow", "mode", false],
    ["sensitive recursive deny still matches exact spelling", "sensitive", "FileRead", "read", "deny", "secret-recursive", "secret-exact", "deny", "rule", false],
    ["sensitive ask does not fire for recased file", "sensitive", "Write", "write", "ask", "secret-recursive", "recased-notes", "ask", "workingDir", false],
    ["sensitive allow does not authorize recased file", "sensitive", "Write", "write", "allow", "data-recursive", "recased-report", "ask", "workingDir", false],
    ["sensitive cwd does not contain recased spelling", "sensitive", "FileRead", "read", null, null, "recased-cwd-notes", "ask", "workingDir", false],
  ] as const)(
    "%s",
    async (
      _title,
      volume,
      tool,
      op,
      ruleBehavior,
      ruleKind,
      targetKind,
      behavior,
      reason,
      keepRuleText,
    ) => {
      await withCaseFixtures((root, outside) => {
        const content =
          ruleKind === null ? undefined : fixturePath(ruleKind, root, outside);
        const result = decide(
          volume,
          root,
          fixturePath(targetKind, root, outside),
          tool,
          op,
          content === undefined || ruleBehavior === null
            ? undefined
            : { behavior: ruleBehavior, content },
        );
        expect(result.behavior).toBe(behavior);
        expect(result.decisionReason?.type).toBe(reason);
        if (reason === "rule") {
          expect(
            result.decisionReason?.type === "rule" &&
              result.decisionReason.rule.ruleBehavior,
          ).toBe(ruleBehavior);
        }
        if (keepRuleText) {
          expect(
            result.decisionReason?.type === "rule" &&
              result.decisionReason.rule.ruleValue.ruleContent,
          ).toBe(content);
        }
      });
    },
  );
});

describe("parseComparisonRoot keeps a UNC share root", () => {
  test("\\\\server\\share\\Secret.txt on win32", () => {
    expect(parseComparisonRoot("\\\\server\\share\\Secret.txt", "win32")).toEqual({
      kind: "unc",
      root: "//server/share",
      segments: ["Secret.txt"],
    });
    expect(parseComparisonRoot("//server/share", "win32")).toEqual({
      kind: "unc",
      root: "//server/share",
      segments: [],
    });
  });

  test("posix collapses a leading double slash", () => {
    expect(parseComparisonRoot("//etc/passwd", "linux")).toEqual({
      kind: "absolute",
      root: "/",
      segments: ["etc", "passwd"],
    });
    if (process.platform === "win32") return;
    expect(matchPathRuleContent("//etc/passwd", "/etc/passwd")).toBe(true);
  });
});

describe("real filesystem probe", () => {
  test("a missing intermediate and a wildcard use the real volume", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-case-real-"));
    try {
      await writeFile(join(root, "Probe.txt"), "probe");
      const missing = join(root, "New", "Secret.txt");
      const volume = pathCaseSemantics(join(root, "Probe.txt"));
      expect(pathForComparison(missing)).toBe(
        volume === "insensitive" ? missing.toLowerCase() : missing,
      );
      expect(
        matchPathRuleContent(join(root, "**", "Secret.txt"), missing),
      ).toBe(true);
      expect(
        matchPathRuleContent(join(root, "**", "Secret.txt"), join(root, "New", "secret.txt")),
      ).toBe(volume === "insensitive");
    } finally {
      __setPathCaseSemanticsResolverForTesting(null);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a deleted entry between the two lstats is not cached as sensitive", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-case-race-"));
    const file = join(root, "Keep.txt");
    const flipped = join(root, "kEEP.TXT");
    await writeFile(file, "keep");
    try {
      __setPathCaseLstatForTesting((target) => {
        if (target === flipped) {
          unlinkSync(file);
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return lstatSync(target);
      });
      expect(pathCaseSemantics(file)).toBe("sensitive");
      expect(__pathCaseDirectoryCachedForTesting(root)).toBe(false);
    } finally {
      __setPathCaseLstatForTesting(null);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an empty directory on another device does not inherit its parent", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agenc-case-mount-"));
    const empty = join(parent, "empty");
    await mkdir(empty);
    await writeFile(join(parent, "Probe.txt"), "probe");
    try {
      __setPathCaseDirectorySemanticsForTesting((directory) =>
        directory === parent ? "insensitive" : undefined,
      );
      __setPathCaseLstatForTesting((target) => {
        const stats = lstatSync(target);
        if (target !== empty) return stats;
        const dev = typeof stats.dev === "bigint" ? stats.dev + 1n : stats.dev + 1;
        return { dev, ino: stats.ino, isDirectory: () => true };
      });
      const folded = pathForComparison(join(empty, "New", "Secret.txt"));
      expect(folded.endsWith("/New/Secret.txt") || folded.endsWith("\\New\\Secret.txt")).toBe(true);
    } finally {
      __setPathCaseLstatForTesting(null);
      __setPathCaseDirectorySemanticsForTesting(null);
      await rm(parent, { recursive: true, force: true });
    }
  });
});
