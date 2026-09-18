/**
 * Path rules follow the case semantics of the volume that holds the target
 * (#2126). On a case-insensitive volume `Secret.txt` and `SECRET.txt` are one
 * file, so a rule written either way must govern both spellings; on a
 * case-sensitive volume they are two files and must stay distinct.
 *
 * Filesystem probing is replaced with a fixed answer so both semantics run on
 * one host; the probe itself is checked against the real temp volume.
 */

import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  __setPathCaseSemanticsResolverForTesting,
  pathCaseSemantics,
  platformDefaultPathCaseSemantics,
  type PathCaseSemantics,
} from "../../src/permissions/path-case.js";
import {
  checkToolPathPermission,
  matchPathRuleContent,
} from "../../src/permissions/path-validation.js";
import { applyPermissionUpdate } from "../../src/permissions/permission-updates.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "../../src/permissions/types.js";

function swapCase(text: string): string {
  return [...text]
    .map((char) =>
      char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase(),
    )
    .join("");
}

/** The same path with the last segment's letters flipped. */
function recased(path: string): string {
  return join(dirname(path), swapCase(basename(path)));
}

describe("matchPathRuleContent follows the target volume's case semantics", () => {
  const windowsCases: ReadonlyArray<readonly [string, string, string]> = [
    ["exact path", "C:/Work/Secret.txt", "c:/work/SECRET.txt"],
    ["exact path, backslash rule", "C:\\Work\\Secret.txt", "c:/work/secret.txt"],
    ["exact path, backslash target", "C:/Work/Secret.txt", "c:\\WORK\\Secret.TXT"],
    ["recursive prefix", "C:/Work/**", "c:\\work\\Sub\\FILE.txt"],
    ["recursive prefix names its root", "C:/Work/**", "c:/WORK"],
    ["single-level glob", "C:/Work/*.txt", "c:/work/Secret.TXT"],
    ["double-star glob", "C:/Work/**/*.txt", "c:/WORK/deep/er/Secret.TXT"],
    ["question-mark glob", "C:/Work/Secret.??t", "c:/work/SECRET.txt"],
  ];

  test.each(windowsCases)(
    "%s matches alternate casing and separators on a case-insensitive volume",
    (_label, rule, target) => {
      expect(matchPathRuleContent(rule, target, "insensitive")).toBe(true);
    },
  );

  test.each(windowsCases)(
    "%s keeps differently cased spellings distinct on a case-sensitive volume",
    (_label, rule, target) => {
      expect(matchPathRuleContent(rule, target, "sensitive")).toBe(false);
    },
  );

  test("case folding never widens a rule beyond its own subtree", () => {
    expect(
      matchPathRuleContent("C:/Work/**", "c:/workspace/file.txt", "insensitive"),
    ).toBe(false);
    expect(
      matchPathRuleContent("C:/Work/*.txt", "c:/work/sub/a.txt", "insensitive"),
    ).toBe(false);
    expect(
      matchPathRuleContent("C:/Work/Secret.txt", "c:/work/secret.txt.bak", "insensitive"),
    ).toBe(false);
  });

  test("POSIX rules fold the same way", () => {
    expect(
      matchPathRuleContent("/Users/Me/Project/**", "/users/me/project/src/App.ts", "insensitive"),
    ).toBe(true);
    expect(
      matchPathRuleContent("/Users/Me/Project/**", "/users/me/project/src/App.ts", "sensitive"),
    ).toBe(false);
    expect(
      matchPathRuleContent("/Users/Me/Project/**", "/Users/Me/Project/src/App.ts", "sensitive"),
    ).toBe(true);
  });
});

describe("pathCaseSemantics probes the volume that holds the path", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-path-case-"));
  });

  afterEach(async () => {
    __setPathCaseSemanticsResolverForTesting(null);
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  /**
   * What this host's temp volume actually does: two spellings that stat to
   * the same file identity mean the volume ignores case.
   */
  async function observedSemantics(dir: string): Promise<PathCaseSemantics> {
    const probe = join(dir, "Probe.txt");
    await writeFile(probe, "probe");
    try {
      const [a, b] = await Promise.all([stat(probe), stat(recased(probe))]);
      return a.ino === b.ino && a.dev === b.dev ? "insensitive" : "sensitive";
    } catch {
      return "sensitive";
    }
  }

  test("an existing file reports what the volume does", async () => {
    const file = join(root, "Secret.txt");
    await writeFile(file, "x");
    __setPathCaseSemanticsResolverForTesting(null);
    expect(pathCaseSemantics(file)).toBe(await observedSemantics(root));
  });

  test("a path that does not exist yet inherits from its nearest ancestor", async () => {
    const missing = join(root, "Not", "Yet", "Created.txt");
    __setPathCaseSemanticsResolverForTesting(null);
    expect(pathCaseSemantics(missing)).toBe(await observedSemantics(root));
  });

  test("a directory holding two names that differ only by case is case-sensitive", async () => {
    const lower = join(root, "same.txt");
    const upper = join(root, "SAME.TXT");
    await writeFile(lower, "lower");
    await writeFile(upper, "upper");
    const [a, b] = await Promise.all([stat(lower), stat(upper)]);
    if (a.ino === b.ino) {
      // The volume folded the two spellings into one file; the distinct-file
      // scenario cannot exist here and the probe must say so.
      __setPathCaseSemanticsResolverForTesting(null);
      expect(pathCaseSemantics(lower)).toBe("insensitive");
      return;
    }
    __setPathCaseSemanticsResolverForTesting(null);
    expect(pathCaseSemantics(lower)).toBe("sensitive");
    expect(pathCaseSemantics(upper)).toBe("sensitive");
  });

  test("the platform default applies when nothing on the path can be probed", () => {
    __setPathCaseSemanticsResolverForTesting(null);
    const separatorOnly = process.platform === "win32" ? "C:\\" : "/";
    expect(pathCaseSemantics(separatorOnly)).toBe(platformDefaultPathCaseSemantics());
    expect(platformDefaultPathCaseSemantics()).toBe(
      process.platform === "win32" || process.platform === "darwin"
        ? "insensitive"
        : "sensitive",
    );
  });
});

describe("allow, ask, and deny rules agree with filesystem identity", () => {
  let root = "";
  let outside = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-path-case-root-"));
    outside = await mkdtemp(join(tmpdir(), "agenc-path-case-outside-"));
    await mkdir(join(root, "Secret"), { recursive: true });
    await mkdir(join(outside, "Data"), { recursive: true });
    await writeFile(join(root, "Secret", "Notes.txt"), "notes");
    await writeFile(join(outside, "Data", "Report.txt"), "report");
  });

  afterEach(async () => {
    __setPathCaseSemanticsResolverForTesting(null);
    if (root) await rm(root, { recursive: true, force: true });
    if (outside) await rm(outside, { recursive: true, force: true });
    root = "";
    outside = "";
  });

  function withRule(
    behavior: "allow" | "ask" | "deny",
    toolName: string,
    ruleContent: string,
  ): ToolPermissionContext {
    return applyPermissionUpdate(createEmptyToolPermissionContext(), {
      type: "addRules",
      destination: "session",
      behavior,
      rules: [{ toolName, ruleContent }],
    });
  }

  function check(
    toolName: string,
    path: string,
    context: ToolPermissionContext,
    operationType: "read" | "write",
    cwd = root,
  ) {
    return checkToolPathPermission({
      toolName,
      input: { file_path: path },
      path,
      cwd,
      context,
      operationType,
    });
  }

  /** `<root>/secret/NOTES.TXT` for a rule spelled `<root>/Secret/...`. */
  const recasedSecretNotes = () =>
    join(root, swapCase("Secret"), swapCase("Notes.txt"));
  const recasedDataReport = () =>
    join(outside, swapCase("Data"), swapCase("Report.txt"));

  describe("on a case-insensitive volume", () => {
    beforeEach(() => {
      __setPathCaseSemanticsResolverForTesting(() => "insensitive");
    });

    test("a recursive deny rule denies the same file spelled differently", () => {
      const context = withRule("deny", "FileRead", join(root, "Secret", "**"));
      const result = check("FileRead", recasedSecretNotes(), context, "read");
      expect(result.behavior).toBe("deny");
      expect(result.decisionReason?.type).toBe("rule");
    });

    test("an exact deny rule denies the same file spelled differently", () => {
      const context = withRule(
        "deny",
        "FileRead",
        join(root, "Secret", "Notes.txt"),
      );
      expect(check("FileRead", recasedSecretNotes(), context, "read").behavior).toBe(
        "deny",
      );
    });

    test("a relative deny rule anchored at the cwd denies the recased file", () => {
      const context = withRule("deny", "FileRead", "./Secret/**");
      expect(check("FileRead", recasedSecretNotes(), context, "read").behavior).toBe(
        "deny",
      );
    });

    test("a glob deny rule denies the recased file", () => {
      const context = withRule("deny", "Write", join(root, "Secret", "*.txt"));
      expect(check("Write", recasedSecretNotes(), context, "write").behavior).toBe(
        "deny",
      );
    });

    test("an ask rule prompts for the same file spelled differently", () => {
      const context = withRule("ask", "Write", join(root, "Secret", "**"));
      const result = check("Write", recasedSecretNotes(), context, "write");
      expect(result.behavior).toBe("ask");
      expect(result.decisionReason?.type).toBe("rule");
      expect(
        result.decisionReason?.type === "rule" &&
          result.decisionReason.rule.ruleBehavior,
      ).toBe("ask");
    });

    test("an allow rule authorizes the same file spelled differently", () => {
      const context = withRule("allow", "Write", join(outside, "Data", "**"));
      const result = check("Write", recasedDataReport(), context, "write");
      expect(result.behavior).toBe("allow");
      expect(result.decisionReason?.type).toBe("rule");
    });

    test("a working directory contains its own recased spelling", () => {
      const target = join(swapCase(root), "Secret", "Notes.txt");
      const result = check(
        "FileRead",
        target,
        createEmptyToolPermissionContext(),
        "read",
      );
      expect(result.behavior).toBe("allow");
      expect(result.decisionReason?.type).toBe("mode");
    });

    test("the matched rule keeps its original spelling for audit", () => {
      const ruleContent = join(root, "Secret", "**");
      const context = withRule("deny", "FileRead", ruleContent);
      const result = check("FileRead", recasedSecretNotes(), context, "read");
      expect(
        result.decisionReason?.type === "rule" &&
          result.decisionReason.rule.ruleValue.ruleContent,
      ).toBe(ruleContent);
    });
  });

  describe("on a case-sensitive volume", () => {
    beforeEach(() => {
      __setPathCaseSemanticsResolverForTesting(() => "sensitive");
    });

    test("a recursive deny rule leaves a differently cased path alone", () => {
      const context = withRule("deny", "FileRead", join(root, "Secret", "**"));
      const result = check("FileRead", recasedSecretNotes(), context, "read");
      expect(result.behavior).toBe("allow");
      expect(result.decisionReason?.type).toBe("mode");
    });

    test("a recursive deny rule still denies the exact spelling", () => {
      const context = withRule("deny", "FileRead", join(root, "Secret", "**"));
      const result = check(
        "FileRead",
        join(root, "Secret", "Notes.txt"),
        context,
        "read",
      );
      expect(result.behavior).toBe("deny");
    });

    test("an ask rule does not fire for a differently cased path", () => {
      const context = withRule("ask", "Write", join(root, "Secret", "**"));
      const result = check("Write", recasedSecretNotes(), context, "write");
      // Still a prompt in default mode, but from the working-directory
      // fallback rather than the rule, which names a different file here.
      expect(result.behavior).toBe("ask");
      expect(result.decisionReason?.type).toBe("workingDir");
    });

    test("an allow rule does not authorize a differently cased path", () => {
      const context = withRule("allow", "Write", join(outside, "Data", "**"));
      const result = check("Write", recasedDataReport(), context, "write");
      expect(result.behavior).toBe("ask");
      expect(result.decisionReason?.type).toBe("workingDir");
    });

    test("a working directory does not contain a differently cased spelling", () => {
      const target = join(swapCase(root), "Secret", "Notes.txt");
      const result = check(
        "FileRead",
        target,
        createEmptyToolPermissionContext(),
        "read",
      );
      expect(result.behavior).toBe("ask");
      expect(result.decisionReason?.type).toBe("workingDir");
    });
  });
});
