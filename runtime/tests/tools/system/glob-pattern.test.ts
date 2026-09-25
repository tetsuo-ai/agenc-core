/**
 * Unit tests for the Glob pattern planner and path matcher.
 *
 * The matcher must reproduce ripgrep's own `--glob` semantics (globset with a
 * literal separator, gitignore anchoring), so the differential test runs the
 * pinned ripgrep binary over the same fixture and compares every pattern.
 */

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  GlobMatchWorkExceeded,
  GlobPatternError,
  normalizeGlobPattern,
  planGlobPattern,
} from "../../../src/tools/system/glob-pattern.js";
import { __INTERNAL } from "../../../src/tools/system/glob.js";
import { selectPinnedRipgrepPath } from "../../../src/tools/system/pinned-ripgrep.js";

const { compileGlobMatcher } = __INTERNAL;

function matches(pattern: string, path: string): boolean {
  return compileGlobMatcher(pattern).matches(Buffer.from(path, "utf8"));
}

describe("normalizeGlobPattern", () => {
  test("treats backslashes as separators on Windows only", () => {
    expect(normalizeGlobPattern("src\\**\\*.ts", "win32")).toBe("src/**/*.ts");
    expect(normalizeGlobPattern("src\\**\\*.ts", "linux")).toBe("src\\**\\*.ts");
    expect(normalizeGlobPattern("src\\**\\*.ts", "darwin")).toBe(
      "src\\**\\*.ts",
    );
  });

  test("anchors a leading ./ at the search root", () => {
    expect(normalizeGlobPattern("./src/*.ts", "linux")).toBe("src/*.ts");
    expect(normalizeGlobPattern("././src/*.ts", "linux")).toBe("src/*.ts");
    // Without a remaining slash the pattern would match at any depth, so it
    // keeps a leading "/" (ripgrep's anchored form).
    expect(normalizeGlobPattern("./*.ts", "linux")).toBe("/*.ts");
    expect(normalizeGlobPattern(".\\src\\*.ts", "win32")).toBe("src/*.ts");
    expect(normalizeGlobPattern("*.ts", "linux")).toBe("*.ts");
    expect(normalizeGlobPattern(".hidden/*.ts", "linux")).toBe(".hidden/*.ts");
  });
});

describe("planGlobPattern", () => {
  test("leaves slash-free patterns to ripgrep's file-name filter", () => {
    expect(planGlobPattern("*.ts")).toEqual({ nameGlob: "*.ts" });
    expect(planGlobPattern("*.{ts,tsx}")).toEqual({ nameGlob: "*.{ts,tsx}" });
    expect(planGlobPattern("*")).toEqual({ nameGlob: "*" });
  });

  test("keeps **/NAME exact without a path matcher", () => {
    expect(planGlobPattern("**/*.ts")).toEqual({ nameGlob: "*.ts" });
    expect(planGlobPattern("**/**/*.md")).toEqual({ nameGlob: "*.md" });
    expect(planGlobPattern("**/*.{ts,tsx}")).toEqual({
      nameGlob: "*.{ts,tsx}",
    });
  });

  test("filters slash patterns by full path with the tightest safe prefilters", () => {
    const tree = planGlobPattern("tree/**/*.txt");
    expect(tree.nameGlob).toBe("*.txt");
    expect(tree.maxDepth).toBeUndefined();
    expect(tree.pathMatcher).toBeDefined();

    const depth = planGlobPattern("tree/*/*/*.txt");
    expect(depth.nameGlob).toBe("*.txt");
    expect(depth.maxDepth).toBe(4);

    const repo = planGlobPattern("repo/*.py");
    expect(repo.nameGlob).toBe("*.py");
    expect(repo.maxDepth).toBe(2);

    const everything = planGlobPattern("tree/**");
    expect(everything.nameGlob).toBe("*");
    expect(everything.maxDepth).toBeUndefined();

    const anchored = planGlobPattern("/*.ts");
    expect(anchored.nameGlob).toBe("*.ts");
    expect(anchored.maxDepth).toBe(1);
  });

  test("drops prefilters a separator-capable token could defeat", () => {
    // A negated class can match "/", so neither the depth nor the name part
    // is known from the text alone.
    const negated = planGlobPattern("a[!x]b/*.txt");
    expect(negated.maxDepth).toBeUndefined();
    expect(negated.nameGlob).toBe("*.txt");

    const spanning = planGlobPattern("{src/a,lib}/*.ts");
    expect(spanning.maxDepth).toBeUndefined();
    expect(spanning.nameGlob).toBe("*.ts");

    const insideBraces = planGlobPattern("src/{a/*.ts,b.ts}");
    expect(insideBraces.nameGlob).toBe("*");

    // ripgrep's --type-add cannot carry a ":".
    expect(planGlobPattern("src/a:b.txt").nameGlob).toBe("*");
  });

  test("directory-only patterns never name a file", () => {
    expect(planGlobPattern("src/").matchesNothing).toBe(true);
    expect(planGlobPattern("src/**/").matchesNothing).toBe(true);
  });

  test("reports malformed patterns with ripgrep's glob error text", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      [
        "tree/{a,b",
        "error parsing glob 'tree/{a,b': unclosed alternate group; missing '}' (maybe escape '{' with '[{]'?)",
      ],
      [
        "tree/}",
        "error parsing glob 'tree/}': unopened alternate group; missing '{' (maybe escape '}' with '[}]'?)",
      ],
      [
        "tree/[a",
        "error parsing glob 'tree/[a': unclosed character class; missing ']'",
      ],
      ["tree/a\\", "error parsing glob 'tree/a\\': dangling '\\'"],
      ["[z-a]/f.txt", "error parsing glob '[z-a]/f.txt': invalid range; 'z' > 'a'"],
    ];
    for (const [pattern, message] of cases) {
      expect(() => planGlobPattern(pattern)).toThrowError(GlobPatternError);
      expect(() => planGlobPattern(pattern)).toThrowError(message);
    }
  });

  test("bounds brace nesting before compiling", () => {
    const nested = (depth: number) =>
      `src/${"{".repeat(depth)}a${"}".repeat(depth)}.ts`;
    expect(planGlobPattern(nested(32)).pathMatcher?.matches(
      Buffer.from("src/a.ts"),
    )).toBe(true);
    expect(() => planGlobPattern(nested(33))).toThrowError(GlobPatternError);
    expect(() => planGlobPattern(nested(33))).toThrowError(
      "alternate groups nest deeper than 32 levels",
    );
    // 4,003 bytes, under the pattern limit, used to overflow the stack.
    expect(() =>
      planGlobPattern(`x/${"{".repeat(2000)}a${"}".repeat(2000)}`),
    ).toThrowError(GlobPatternError);
  });
});

describe("compileGlobMatcher", () => {
  test("anchors slash patterns and keeps * inside one directory", () => {
    expect(matches("repo/*.py", "repo/config.py")).toBe(true);
    expect(matches("repo/*.py", "repo/pkg/mod.py")).toBe(false);
    expect(matches("repo/*.py", "x/repo/config.py")).toBe(false);
    expect(matches("tree/**/*.txt", "tree/top.txt")).toBe(true);
    expect(matches("tree/**/*.txt", "tree/a/b/c.txt")).toBe(true);
    expect(matches("tree/**/*.txt", "other/tree/c.txt")).toBe(false);
    expect(matches("*.py", "repo/pkg/mod.py")).toBe(true);
    expect(matches("dir with spaces/*.txt", "dir with spaces/a.txt")).toBe(
      true,
    );
    expect(matches("café-ñandú/*.md", "café-ñandú/résumé.md")).toBe(true);
  });

  test("stops once its work cap is spent", () => {
    const matcher = compileGlobMatcher("**/a*/b*/c*", { maxWork: 10 });
    expect(() => matcher.matches(Buffer.from("x/a1/b2/c3", "utf8"))).toThrowError(
      GlobMatchWorkExceeded,
    );
  });

  test("matches pathological patterns in linear time", () => {
    // A backtracking regular expression needs exponential time here; the
    // matcher simulates the pattern's automaton instead.
    const pattern = `${"*a".repeat(24)}*b/x`;
    const path = `${"a".repeat(240)}/x`;
    const startedAt = performance.now();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(matches(pattern, path)).toBe(false);
    }
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(matches(`${"*a".repeat(24)}*/x`, path)).toBe(true);
  });
});

const DIFFERENTIAL_FILES: readonly string[] = [
  "a.txt",
  "b.md",
  ".hidden",
  ".config/app.json",
  "tree/top.txt",
  "tree/a/mid.txt",
  "tree/a/b/deep.txt",
  "tree/a/b/.dot.txt",
  "x/tree/other.txt",
  "repo/config.py",
  "repo/pkg/mod.py",
  "dir with spaces/s.txt",
  "dir with spaces/nested/t.txt",
  "café-ñandú/résumé.md",
  "é/in.txt",
  "日本/語.txt",
  "[x]/f.txt",
  "a{b/f.txt",
  "a,b/f.txt",
  "-/f.txt",
  "]/f.txt",
  "back\\slash/f.txt",
  "a/fb",
  "a/xyzb",
  "line\nbreak/f.txt",
  "star*/f.txt",
  "q?/f.txt",
  "Q/f.txt",
];

const DIFFERENTIAL_PATTERNS: readonly string[] = [
  "*.txt",
  "**/*.txt",
  "tree/**/*.txt",
  "tree/*.txt",
  "tree/*/*.txt",
  "tree/*/*/*.txt",
  "tree/**",
  "tree/**/*",
  "**/tree/*.txt",
  "**/tree/**",
  "*/tree/*.txt",
  "tree/a/**/deep.txt",
  "tree/**/**/deep.txt",
  "**/*.py",
  "repo/*.py",
  "repo/**/*.py",
  "**/a/**",
  "**/b/*",
  "/tree/*.txt",
  "/*.txt",
  "/a.txt",
  "a.txt",
  "tree/top.txt",
  ".*",
  "**/.*",
  "tree/**/.*",
  ".config/*",
  "*/*.json",
  "dir with spaces/*.txt",
  "dir with spaces/**",
  "café-ñandú/*.md",
  "?/in.txt",
  "??/in.txt",
  "é/*",
  "日本/*.txt",
  "??????/*.txt",
  "[é]/in.txt",
  "[[]x]/f.txt",
  "\\[x]/f.txt",
  "[!a]/f.txt",
  "[^a]/f.txt",
  "[]]/f.txt",
  "[!]]/f.txt",
  "[a-]/f.txt",
  "[-a]/f.txt",
  "[A-Z]/f.txt",
  "tree[/]top.txt",
  "tree[!x]top.txt",
  "[\\]]/f.txt",
  "[\\\\]/f.txt",
  "{tree,repo}/*.{txt,py}",
  "{a.b,[x]}/f.txt",
  "{tree/a,x}/*.txt",
  "{**/deep.txt,x}",
  "tree/{**/deep.txt,x}",
  "a/{f,xyz}b",
  "a/{f,{x,q}yz}b",
  "{a,}/fb",
  "{}/f.txt",
  "a,b/f.txt",
  "a\\{b/f.txt",
  "a\\,b/f.txt",
  "a/**b",
  "a/f**",
  "**a/fb",
  "a**/fb",
  "tree/**/",
  "**/",
  "tree/",
  "line*/f.txt",
  "line?break/*",
  "*/f.txt",
  "star\\*/f.txt",
  "q\\?/f.txt",
  "back\\\\slash/*",
  "**/f.txt",
  "**",
  "**/**",
  "*/**",
  "*/*",
  "tree/[a",
  "tree/{a",
  "tree/}",
  "tree/a\\",
  "[z-a]/f.txt",
];

describe.runIf(process.platform !== "win32")(
  "compileGlobMatcher agrees with ripgrep --glob",
  () => {
    let root = "";

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "agenc-glob-pattern-"));
      for (const file of DIFFERENTIAL_FILES) {
        await mkdir(dirname(join(root, file)), { recursive: true });
        await writeFile(join(root, file), "x\n", "utf8");
      }
    });

    afterAll(async () => {
      if (root) await rm(root, { recursive: true, force: true });
    });

    test.each(DIFFERENTIAL_PATTERNS)("%s", (pattern) => {
      const ripgrep = selectPinnedRipgrepPath();
      expect(ripgrep).toBeDefined();
      const listed = spawnSync(
        ripgrep!,
        [
          "--no-config",
          "--files",
          "-0",
          "--no-ignore",
          "--hidden",
          "--glob",
          pattern,
          "--",
          ".",
        ],
        { cwd: root, encoding: "buffer" },
      );
      const stderr = listed.stderr.toString("utf8");
      if (stderr.includes("error parsing glob")) {
        const expected = stderr.trim().replace(/^rg: /u, "");
        expect(() => compileGlobMatcher(pattern)).toThrowError(expected);
        return;
      }
      expect(stderr).toBe("");
      const expected = listed.stdout
        .toString("utf8")
        .split("\0")
        .filter((entry) => entry.length > 0)
        .map((entry) => entry.replace(/^\.\//u, ""))
        .sort();
      const matcher = compileGlobMatcher(pattern);
      const actual = DIFFERENTIAL_FILES.filter((file) =>
        matcher.matches(Buffer.from(file, "utf8")),
      ).sort();
      expect(actual).toEqual(expected);
    });
  },
);
