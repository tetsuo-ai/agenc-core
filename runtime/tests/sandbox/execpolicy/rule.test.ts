import { describe, expect, test } from "vitest";

import { ExecPolicyError } from "../../../src/sandbox/execpolicy/error.js";
import {
  assertBareExecutableName,
  normalizeNetworkRuleHost,
  parseNetworkRuleProtocol,
  prefixRuleMatches,
  serializeRuleMatch,
  withResolvedProgram,
  type PrefixRule,
  type RuleMatch,
} from "../../../src/sandbox/execpolicy/rule.js";

function prefixRule(
  first: string,
  rest: PrefixRule["pattern"]["rest"],
  decision: PrefixRule["decision"] = "allow",
  justification: string | null = null,
): PrefixRule {
  return {
    type: "prefix_rule",
    pattern: { first, rest },
    decision,
    justification,
  };
}

function expectInvalidRule(run: () => unknown, message: string): void {
  expect(run).toThrow(ExecPolicyError);
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({
      name: "ExecPolicyError",
      kind: "invalid_rule",
    });
    expect((error as Error).message).toContain(message);
  }
}

describe("normalizeNetworkRuleHost", () => {
  test("trims, lowercases, and strips a trailing dot or :port", () => {
    expect(normalizeNetworkRuleHost("  API.Example.COM.  ")).toBe("api.example.com");
    expect(normalizeNetworkRuleHost("example.com:443")).toBe("example.com");
    expect(normalizeNetworkRuleHost("[::1]")).toBe("::1");
    expect(normalizeNetworkRuleHost("[::1]:443")).toBe("::1");
    expect(normalizeNetworkRuleHost("2001:DB8::1")).toBe("2001:db8::1");
  });

  test.each([
    ["", "cannot be empty"],
    ["   ", "cannot be empty"],
    [".", "cannot be empty"],
    ["https://example.com", "without scheme or path"],
    ["example.com/path", "without scheme or path"],
    ["example.com?q=1", "without scheme or path"],
    ["*.example.com", "wildcards are not allowed"],
    ["exam ple.com", "cannot contain whitespace"],
    ["[::1", "invalid bracketed IPv6"],
    ["[::1]:", "unsupported suffix"],
    ["[::1]foo", "unsupported suffix"],
  ] as const)("refuses %j", (host, message) => {
    expectInvalidRule(() => normalizeNetworkRuleHost(host), message);
  });
});

describe("parseNetworkRuleProtocol", () => {
  test("maps aliases onto the four stored protocols", () => {
    expect(parseNetworkRuleProtocol("http")).toBe("http");
    expect(parseNetworkRuleProtocol("https")).toBe("https");
    expect(parseNetworkRuleProtocol("https_connect")).toBe("https");
    expect(parseNetworkRuleProtocol("http-connect")).toBe("https");
    expect(parseNetworkRuleProtocol("socks5_tcp")).toBe("socks5_tcp");
    expect(parseNetworkRuleProtocol("socks5_udp")).toBe("socks5_udp");
  });

  test("refuses an unknown protocol", () => {
    expectInvalidRule(
      () => parseNetworkRuleProtocol("ftp"),
      "network_rule protocol must be one of",
    );
  });
});

describe("prefixRuleMatches", () => {
  test("matches a prefix and leaves extra operands unmatched", () => {
    const rule = prefixRule("git", [{ type: "single", value: "status" }], "prompt", "review");
    expect(prefixRuleMatches(rule, ["git", "status", "--short"])).toEqual({
      type: "prefix_rule_match",
      matchedPrefix: ["git", "status"],
      decision: "prompt",
      resolvedProgram: null,
      justification: "review",
    });
  });

  test("matches alternative tokens and refuses a shorter or different command", () => {
    const rule = prefixRule("git", [{ type: "alts", alternatives: ["status", "diff"] }]);
    expect(prefixRuleMatches(rule, ["git", "diff"])?.matchedPrefix).toEqual(["git", "diff"]);
    expect(prefixRuleMatches(rule, ["git", "log"])).toBeNull();
    expect(prefixRuleMatches(rule, ["git"])).toBeNull();
    expect(prefixRuleMatches(rule, ["hg", "status"])).toBeNull();
  });

  test("serializeRuleMatch and withResolvedProgram keep optional fields optional", () => {
    const match: RuleMatch = {
      type: "prefix_rule_match",
      matchedPrefix: ["npm", "test"],
      decision: "allow",
      resolvedProgram: null,
      justification: null,
    };
    expect(serializeRuleMatch(match)).toEqual({
      prefixRuleMatch: { matchedPrefix: ["npm", "test"], decision: "allow" },
    });
    expect(serializeRuleMatch(withResolvedProgram(match, "/usr/bin/npm"))).toEqual({
      prefixRuleMatch: {
        matchedPrefix: ["npm", "test"],
        decision: "allow",
        resolvedProgram: "/usr/bin/npm",
      },
    });
    expect(serializeRuleMatch({
      type: "heuristics_rule_match",
      command: ["curl", "https://example.test"],
      decision: "forbidden",
    })).toEqual({
      heuristicsRuleMatch: {
        command: ["curl", "https://example.test"],
        decision: "forbidden",
      },
    });
  });
});

describe("assertBareExecutableName", () => {
  test("accepts a basename-only executable", () => {
    expect(() => assertBareExecutableName("git")).not.toThrow();
    expect(() => assertBareExecutableName("git.exe")).not.toThrow();
  });

  test.each(["", "/usr/bin/git", "dir\\git", "bin/git"])("refuses %j", (name) => {
    expectInvalidRule(() => assertBareExecutableName(name), "host_executable name");
  });
});
