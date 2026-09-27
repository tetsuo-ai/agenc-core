import { describe, expect, it } from "vitest";

import {
  hasWildcards,
  matchWildcardPattern,
  parsePermissionRule,
  permissionRuleExtractPrefix,
} from "../../../src/utils/permissions/shellRuleMatching.js";

describe("permissionRuleExtractPrefix", () => {
  it("reads the compatibility :* prefix and leaves other spellings alone", () => {
    expect(permissionRuleExtractPrefix("npm:*")).toBe("npm");
    expect(permissionRuleExtractPrefix("git commit:*")).toBe("git commit");
    expect(permissionRuleExtractPrefix("npm: *")).toBeNull();
    expect(permissionRuleExtractPrefix("npm*")).toBeNull();
    expect(permissionRuleExtractPrefix("npm:")).toBeNull();
    expect(permissionRuleExtractPrefix("")).toBeNull();
  });
});

describe("hasWildcards", () => {
  it("treats compatibility :* as a prefix, not a wildcard", () => {
    expect(hasWildcards("npm:*")).toBe(false);
    expect(hasWildcards("git *")).toBe(true);
    expect(hasWildcards("*")).toBe(true);
    expect(hasWildcards("echo hello")).toBe(false);
  });

  it("counts only unescaped asterisks", () => {
    expect(hasWildcards("echo \\*")).toBe(false);
    expect(hasWildcards("echo \\\\*")).toBe(true);
    expect(hasWildcards("echo \\\\\\*")).toBe(false);
  });
});

describe("parsePermissionRule", () => {
  it("classifies exact, prefix, and wildcard rules", () => {
    expect(parsePermissionRule("git status")).toEqual({
      type: "exact",
      command: "git status",
    });
    expect(parsePermissionRule("npm:*")).toEqual({
      type: "prefix",
      prefix: "npm",
    });
    expect(parsePermissionRule("git *")).toEqual({
      type: "wildcard",
      pattern: "git *",
    });
  });

  it("keeps an escaped asterisk as an exact command", () => {
    expect(parsePermissionRule("echo \\*")).toEqual({
      type: "exact",
      command: "echo \\*",
    });
  });

  it("prefers :* prefix syntax over a trailing wildcard", () => {
    expect(parsePermissionRule("rm:*")).toEqual({
      type: "prefix",
      prefix: "rm",
    });
  });
});

describe("matchWildcardPattern", () => {
  it("makes a lone trailing ' *' optional so bare commands match", () => {
    expect(matchWildcardPattern("git *", "git add")).toBe(true);
    expect(matchWildcardPattern("git *", "git")).toBe(true);
    expect(matchWildcardPattern("git *", "gitx")).toBe(false);
    expect(matchWildcardPattern("git *", "npm install")).toBe(false);
  });

  it("does not make the last star optional in multi-wildcard patterns", () => {
    expect(matchWildcardPattern("* run *", "npm run test")).toBe(true);
    expect(matchWildcardPattern("* run *", "npm run")).toBe(false);
  });

  it("matches a literal asterisk and a literal backslash", () => {
    expect(matchWildcardPattern("echo \\*", "echo *")).toBe(true);
    expect(matchWildcardPattern("echo \\*", "echo star")).toBe(false);
    expect(matchWildcardPattern("path\\\\*", "path\\to")).toBe(true);
  });

  it("matches embedded newlines and optional case folding", () => {
    expect(matchWildcardPattern("cat *", "cat <<EOF\nsecret\nEOF")).toBe(true);
    expect(matchWildcardPattern("Git *", "git status")).toBe(false);
    expect(matchWildcardPattern("Git *", "git status", true)).toBe(true);
  });
});
