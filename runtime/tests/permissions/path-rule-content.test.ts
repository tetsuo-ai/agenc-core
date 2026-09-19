import { homedir } from "node:os";

import { describe, expect, test } from "vitest";

import { matchPathRuleContent } from "../../src/permissions/path-validation.js";

describe("matchPathRuleContent", () => {
  test("an exact path matches after slash normalization", () => {
    expect(matchPathRuleContent("/repo/src/a.ts", "/repo/src/a.ts")).toBe(true);
    expect(matchPathRuleContent("/repo/src/a.ts", "\\repo\\src\\a.ts")).toBe(true);
    expect(matchPathRuleContent("/repo/src/a.ts", "/repo/src/b.ts")).toBe(false);
  });

  test("a tilde rule matches the expanded home path and nothing else", () => {
    expect(matchPathRuleContent("~/notes.md", `${homedir()}/notes.md`)).toBe(true);
    expect(matchPathRuleContent("~/notes.md", `${homedir()}/other.md`)).toBe(false);
    expect(matchPathRuleContent("~root/.ssh/id_rsa", `${homedir()}/.ssh/id_rsa`)).toBe(false);
  });

  test("a /** rule covers the directory itself and descendants, not a sibling prefix", () => {
    expect(matchPathRuleContent("/repo/src/**", "/repo/src")).toBe(true);
    expect(matchPathRuleContent("/repo/src/**", "/repo/src/")).toBe(true);
    expect(matchPathRuleContent("/repo/src/**", "/repo/src/a.ts")).toBe(true);
    expect(matchPathRuleContent("/repo/src/**", "/repo/src/nested/a.ts")).toBe(true);
    expect(matchPathRuleContent("/repo/src/**", "/repo/src-other/a.ts")).toBe(false);
    expect(matchPathRuleContent("/repo/src/**", "/repo/other/a.ts")).toBe(false);
  });

  test("a trailing slash on a /** root is stripped before the prefix check", () => {
    expect(matchPathRuleContent("/repo/src//**", "/repo/src/a.ts")).toBe(true);
    expect(matchPathRuleContent("/repo/src//**", "/repo/src")).toBe(true);
  });

  test("* matches one path segment; ** matches across directories", () => {
    expect(matchPathRuleContent("src/*.ts", "src/a.ts")).toBe(true);
    expect(matchPathRuleContent("src/*.ts", "src/nested/a.ts")).toBe(false);
    expect(matchPathRuleContent("src/*.ts", "src/a.tsx")).toBe(false);
    expect(matchPathRuleContent("**/*.ts", "nested/a.ts")).toBe(true);
    expect(matchPathRuleContent("**/*.ts", "a.ts")).toBe(false);
    expect(matchPathRuleContent("src/**/*.ts", "src/nested/a.ts")).toBe(true);
    expect(matchPathRuleContent("src/**/*.ts", "src/a.ts")).toBe(false);
  });

  test("? matches exactly one character that is not a separator", () => {
    expect(matchPathRuleContent("src/?ile.ts", "src/file.ts")).toBe(true);
    expect(matchPathRuleContent("src/?ile.ts", "src/fiile.ts")).toBe(false);
    expect(matchPathRuleContent("src/?ile.ts", "src/xile.ts")).toBe(true);
    expect(matchPathRuleContent("src/?ile.ts", "src/f/ile.ts")).toBe(false);
  });

  test("bracket and brace characters are literals, not character classes or expansions", () => {
    expect(matchPathRuleContent("file[1].ts", "file[1].ts")).toBe(true);
    expect(matchPathRuleContent("file[1].ts", "file1.ts")).toBe(false);
    expect(matchPathRuleContent("src/{a,b}.ts", "src/{a,b}.ts")).toBe(true);
    expect(matchPathRuleContent("src/{a,b}.ts", "src/a.ts")).toBe(false);
  });

  test("regex metacharacters in a glob rule stay literals", () => {
    expect(matchPathRuleContent("src/a+b.ts", "src/a+b.ts")).toBe(true);
    expect(matchPathRuleContent("src/a+b.ts", "src/ab.ts")).toBe(false);
    expect(matchPathRuleContent("src/a.ts", "src/aXts")).toBe(false);
  });

  test("a bare ** matches every path; an empty rule matches only the empty path", () => {
    expect(matchPathRuleContent("**", "/repo/src/a.ts")).toBe(true);
    expect(matchPathRuleContent("**", "")).toBe(true);
    expect(matchPathRuleContent("", "")).toBe(true);
    expect(matchPathRuleContent("", "/repo/src/a.ts")).toBe(false);
  });
});
