import { homedir } from "node:os";

import { describe, expect, test } from "vitest";

import { matchPathRuleContent } from "../../src/permissions/path-validation.js";

interface RuleCase {
  readonly title: string;
  readonly rule: string;
  readonly matches: readonly string[];
  readonly rejects: readonly string[];
}

const home = homedir();

// One row per rule keeps the table readable and avoids a run of identical
// expect lines that differ only in their string literals.
const CASES: readonly RuleCase[] = [
  { title: "an exact path matches after slash normalization", rule: "/repo/src/a.ts", matches: ["/repo/src/a.ts", "\\repo\\src\\a.ts"], rejects: ["/repo/src/b.ts"] },
  { title: "a tilde rule matches the expanded home path and nothing else", rule: "~/notes.md", matches: [`${home}/notes.md`], rejects: [`${home}/other.md`] },
  { title: "a ~user rule is not expanded to this home", rule: "~root/.ssh/id_rsa", matches: [], rejects: [`${home}/.ssh/id_rsa`] },
  { title: "a /** rule covers the directory itself and descendants, not a sibling prefix", rule: "/repo/src/**", matches: ["/repo/src", "/repo/src/", "/repo/src/a.ts", "/repo/src/nested/a.ts"], rejects: ["/repo/src-other/a.ts", "/repo/other/a.ts"] },
  { title: "a doubled slash before /** is collapsed like any other", rule: "/repo/src//**", matches: ["/repo/src/a.ts", "/repo/src"], rejects: ["/repo/src-other/a.ts"] },
  { title: "* matches within one path segment", rule: "src/*.ts", matches: ["src/a.ts"], rejects: ["src/nested/a.ts", "src/a.tsx"] },
  { title: "a leading **/ needs at least one directory", rule: "**/*.ts", matches: ["nested/a.ts"], rejects: ["a.ts"] },
  { title: "a middle /**/ needs at least one directory", rule: "src/**/*.ts", matches: ["src/nested/a.ts"], rejects: ["src/a.ts"] },
  { title: "? matches exactly one character", rule: "src/?ile.ts", matches: ["src/file.ts", "src/xile.ts"], rejects: ["src/fiile.ts", "src/f/ile.ts"] },
  { title: "? never matches a separator", rule: "src?ile.ts", matches: ["srcfile.ts"], rejects: ["src/ile.ts"] },
  { title: "brackets are literals, not a character class", rule: "file[1].ts", matches: ["file[1].ts"], rejects: ["file1.ts"] },
  { title: "braces are literals, not an expansion", rule: "src/{a,b}.ts", matches: ["src/{a,b}.ts"], rejects: ["src/a.ts"] },
  // A rule without *, ?, [ ] or { } is compared exactly, so these carry a
  // wildcard to reach the regex translation.
  { title: "a regex quantifier after a wildcard stays a literal", rule: "src/*+b.ts", matches: ["src/a+b.ts"], rejects: ["src/ab.ts"] },
  { title: "a dot after a wildcard is a literal dot", rule: "lib/*.js", matches: ["lib/a.js"], rejects: ["lib/aXjs"] },
  { title: "a bare ** matches every path", rule: "**", matches: ["/repo/src/a.ts", ""], rejects: [] },
  { title: "an empty rule matches only the empty path", rule: "", matches: [""], rejects: ["/repo/src/a.ts"] },
];

describe("matchPathRuleContent", () => {
  test.each(CASES.map((row) => [row.title, row] as const))("%s", (_title, { rule, matches, rejects }) => {
    for (const path of matches) {
      expect(matchPathRuleContent(rule, path), `${rule} should match ${path}`).toBe(true);
    }
    for (const path of rejects) {
      expect(matchPathRuleContent(rule, path), `${rule} should not match ${path}`).toBe(false);
    }
  });
});
