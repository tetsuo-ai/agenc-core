import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";
import { sourceUrl } from "../../helpers/source-path.ts";

import {
  AmendError,
  ExampleDidMatchError,
  ExampleDidNotMatchError,
  ExecPolicyError,
  Policy,
  PolicyParser,
  blockingAppendAllowPrefixRule,
  blockingAppendNetworkRule,
  evaluationIsMatch,
  formatMatchesJson,
  loadPolicies,
  normalizeNetworkRuleHost,
  parseExecPolicyArgv,
  parsePolicy,
  type Decision,
  type Evaluation,
} from "./index.js";
import { windowsExecutableLookupKey } from "./executable-name.js";

function tokens(command: readonly string[]): string[] {
  return [...command];
}

function allowAll(): Decision {
  return "allow";
}

function promptAll(): Decision {
  return "prompt";
}

function hostAbsolutePath(segments: readonly string[]): string {
  return path.join(path.parse(process.cwd()).root, ...segments);
}

function hostExecutableName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function escapedPolicyString(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"");
}

function withTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agenc-execpolicy-test-"));
}

describe("execpolicy", () => {
  test("appends allow prefix rules with dedupe and newline preservation", () => {
    const tmp = withTempDir();
    const policyPath = path.join(tmp, "rules", "default.agencpolicy");

    blockingAppendAllowPrefixRule(policyPath, ["python3"]);
    blockingAppendAllowPrefixRule(policyPath, ["python3"]);
    expect(fs.readFileSync(policyPath, "utf8")).toBe(
      'prefix_rule(pattern=["python3"], decision="allow")\n',
    );

    fs.writeFileSync(policyPath, 'prefix_rule(pattern=["ls"], decision="allow")');
    blockingAppendAllowPrefixRule(policyPath, ["echo", "Hello, world!"]);
    expect(fs.readFileSync(policyPath, "utf8")).toBe(
      'prefix_rule(pattern=["ls"], decision="allow")\n' +
        'prefix_rule(pattern=["echo", "Hello, world!"], decision="allow")\n',
    );
  });

  test("network rules normalize and compile allow/deny domain lists", () => {
    const policy = parsePolicy(
      "network.agencpolicy",
      `
network_rule(host = "LOCALHOST", protocol = "http", decision = "allow")
network_rule(host = "127.0.0.1:8443", protocol = "https_connect", decision = "allow")
network_rule(host = "[::1]:443", protocol = "http-connect", decision = "deny")
network_rule(host = "localhost", protocol = "https", decision = "deny")
network_rule(host = "localhost", protocol = "https", decision = "allow")
network_rule(host = "127.0.0.1", protocol = "socks5_tcp", decision = "prompt")
`,
    );

    expect(policy.networkRules()).toHaveLength(6);
    expect(policy.networkRules()[1]?.protocol).toBe("https");
    expect(policy.networkRules()[2]?.host).toBe("::1");
    expect(normalizeNetworkRuleHost("MÜNICH.")).toBe("mÜnich");
    expect(policy.compiledNetworkDomains()).toEqual([
      ["127.0.0.1", "localhost"],
      ["::1"],
    ]);
  });

  test("network rules reject wildcard hosts and empty justifications", () => {
    expect(() =>
      parsePolicy(
        "network.agencpolicy",
        'network_rule(host="*.localhost", protocol="http", decision="allow")',
      ),
    ).toThrow(/wildcards are not allowed/u);

    expect(() =>
      parsePolicy(
        "network.agencpolicy",
        'network_rule(host="localhost", protocol="http", decision="allow", justification=" ")',
      ),
    ).toThrow(/justification cannot be empty/u);
  });

  test("matches prefix rules and preserves justifications", () => {
    const policy = parsePolicy(
      "test.agencpolicy",
      `
prefix_rule(pattern = ["git", "status"])
prefix_rule(
  pattern = ["git", "status"],
  decision = "allow",
  justification = "read-only status",
)
prefix_rule(
  pattern = ["rm"],
  decision = "forbidden",
  justification = "destructive command",
)
`,
    );

    const statusEvaluation = policy.check(tokens(["git", "status"]), allowAll);
    expect(evaluationIsMatch(statusEvaluation)).toBe(true);
    expect(statusEvaluation).toEqual({
      decision: "allow",
      matchedRules: [
        {
          type: "prefix_rule_match",
          matchedPrefix: tokens(["git", "status"]),
          decision: "allow",
          resolvedProgram: null,
          justification: null,
        },
        {
          type: "prefix_rule_match",
          matchedPrefix: tokens(["git", "status"]),
          decision: "allow",
          resolvedProgram: null,
          justification: "read-only status",
        },
      ],
    } satisfies Evaluation);

    expect(policy.check(tokens(["rm", "-rf", "target"]), allowAll)).toEqual({
      decision: "forbidden",
      matchedRules: [
        {
          type: "prefix_rule_match",
          matchedPrefix: tokens(["rm"]),
          decision: "forbidden",
          resolvedProgram: null,
          justification: "destructive command",
        },
      ],
    } satisfies Evaluation);
  });

  test("addPrefixRule extends an existing policy and rejects empty prefixes", () => {
    const policy = Policy.empty();
    policy.addPrefixRule(tokens(["ls", "-l"]), "prompt");

    expect(policy.check(tokens(["ls", "-l", "src"]), allowAll)).toEqual({
      decision: "prompt",
      matchedRules: [
        {
          type: "prefix_rule_match",
          matchedPrefix: tokens(["ls", "-l"]),
          decision: "prompt",
          resolvedProgram: null,
          justification: null,
        },
      ],
    });
    expect(() => policy.addPrefixRule([], "allow")).toThrow(/prefix cannot be empty/u);
  });

  test("multiple policy parses accumulate rules and strictest decision wins", () => {
    const parser = new PolicyParser();
    parser.parse("first.agencpolicy", 'prefix_rule(pattern = ["git"], decision = "prompt")');
    parser.parse(
      "second.agencpolicy",
      'prefix_rule(pattern = ["git", "commit"], decision = "forbidden")',
    );
    const policy = parser.build();

    expect(policy.check(tokens(["git", "commit", "-m", "hi"]), allowAll)).toEqual({
      decision: "forbidden",
      matchedRules: [
        {
          type: "prefix_rule_match",
          matchedPrefix: tokens(["git"]),
          decision: "prompt",
          resolvedProgram: null,
          justification: null,
        },
        {
          type: "prefix_rule_match",
          matchedPrefix: tokens(["git", "commit"]),
          decision: "forbidden",
          resolvedProgram: null,
          justification: null,
        },
      ],
    });
  });

  test("first-token alternatives expand into separate rules while tail alternatives stay grouped", () => {
    const policy = parsePolicy(
      "test.agencpolicy",
      `
prefix_rule(pattern = [["bash", "sh"], ["-c", "-l"]])
prefix_rule(pattern = ["npm", ["i", "install"], ["--legacy-peer-deps", "--no-save"]])
`,
    );

    expect(policy.check(tokens(["bash", "-c", "echo", "hi"]), promptAll).decision).toBe(
      "allow",
    );
    expect(policy.check(tokens(["sh", "-l", "echo", "hi"]), promptAll).decision).toBe(
      "allow",
    );
    expect(policy.check(tokens(["npm", "install", "--no-save", "leftpad"]), promptAll))
      .toEqual({
        decision: "allow",
        matchedRules: [
          {
            type: "prefix_rule_match",
            matchedPrefix: tokens(["npm", "install", "--no-save"]),
            decision: "allow",
            resolvedProgram: null,
            justification: null,
          },
        ],
      });
  });

  test("parses Starlark-style variables, expressions, positional args, and f-strings", () => {
    const gitPath = hostAbsolutePath(["usr", "bin", hostExecutableName("git")]);
    const escapedGitPath = escapedPolicyString(gitPath);
    const policy = parsePolicy(
      "computed.agencpolicy",
      `
verb = "stat" + "us"
base = ["git"]
def make_tail(flag):
  return [f"{verb}", flag]
for flag in ["--short"]:
  prefix_rule(base + make_tail(flag), "prompt", justification = "computed rule")
extra = [f"{item}" for item in ["safe"]]
prefix_rule(["echo"] + extra)
network_host = "LOCALHOST"
network_rule(network_host, "http", "allow")
git_path = "${escapedGitPath}"
host_executable("git", [git_path])
`,
    );

    expect(policy.check(tokens(["git", "status", "--short"]), allowAll)).toEqual({
      decision: "prompt",
      matchedRules: [
        {
          type: "prefix_rule_match",
          matchedPrefix: tokens(["git", "status", "--short"]),
          decision: "prompt",
          resolvedProgram: null,
          justification: "computed rule",
        },
      ],
    });
    expect(policy.networkRules()[0]).toMatchObject({
      host: "localhost",
      protocol: "http",
      decision: "allow",
    });
    expect(policy.hostExecutables().get("git")).toEqual([gitPath]);
    expect(policy.check(tokens(["echo", "safe"]), allowAll).decision).toBe("allow");
  });

  test("list comprehension lookalikes inside strings stay literal", () => {
    const policy = parsePolicy(
      "lookalike.agencpolicy",
      'prefix_rule(["echo", "x for y in z"])',
    );

    expect(policy.check(tokens(["echo", "x for y in z"]), promptAll)).toEqual({
      decision: "allow",
      matchedRules: [
        {
          type: "prefix_rule_match",
          matchedPrefix: tokens(["echo", "x for y in z"]),
          decision: "allow",
          resolvedProgram: null,
          justification: null,
        },
      ],
    });
  });

  test("match and not_match examples validate at parse time", () => {
    expect(() =>
      parsePolicy(
        "test.agencpolicy",
        `
prefix_rule(
  pattern = ["git", "status"],
  match = [["git", "status"], "git status"],
  not_match = [["git", "--config", "color.status=always", "status"]],
)
`,
      ),
    ).not.toThrow();

    expect(() =>
      parsePolicy(
        "bad.agencpolicy",
        'prefix_rule(pattern = ["git", "status"], match = [["git", "commit"]])',
      ),
    ).toThrow(ExampleDidNotMatchError);
    expect(() =>
      parsePolicy(
        "bad.agencpolicy",
        'prefix_rule(pattern = ["git"], not_match = [["git", "status"]])',
      ),
    ).toThrow(ExampleDidMatchError);
  });

  test("match validation errors inside for-loop bodies keep source line numbers", () => {
    try {
      parsePolicy(
        "loop-examples.agencpolicy",
        `
for verb in ["status"]:
  prefix_rule(
    pattern = ["git", verb],
    match = [["git", "commit"]],
  )
`,
      );
      throw new Error("parse should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ExampleDidNotMatchError);
      expect((error as ExecPolicyError).location?.range.start.line).toBe(3);
    }
  });

  test("match and not_match examples honor host executable resolution", () => {
    const gitPath = hostAbsolutePath(["usr", "bin", hostExecutableName("git")]);
    const escapedGitPath = escapedPolicyString(gitPath);

    expect(() =>
      parsePolicy(
        "host-examples.agencpolicy",
        `
prefix_rule(
  pattern = ["git", "status"],
  match = [["${escapedGitPath}", "status"]],
  not_match = [["${escapedGitPath}", "commit"]],
)
host_executable(name = "git", paths = ["${escapedGitPath}"])
`,
      ),
    ).not.toThrow();

    expect(() =>
      parsePolicy(
        "bad-host-examples.agencpolicy",
        `
prefix_rule(pattern = ["git", "status"], match = [["${escapedGitPath}", "commit"]])
host_executable(name = "git", paths = ["${escapedGitPath}"])
`,
      ),
    ).toThrow(ExampleDidNotMatchError);

    expect(() =>
      parsePolicy(
        "bad-host-examples.agencpolicy",
        `
prefix_rule(pattern = ["git", "status"], not_match = [["${escapedGitPath}", "status"]])
host_executable(name = "git", paths = ["${escapedGitPath}"])
`,
      ),
    ).toThrow(ExampleDidMatchError);
  });

  test("loads the carried example policy corpus end-to-end", () => {
    const fixturePath = sourceUrl("sandbox/execpolicy/examples/example.agencpolicy");
    const policy = parsePolicy(
      "examples/example.agencpolicy",
      fs.readFileSync(fixturePath, "utf8"),
    );

    expect(policy.check(tokens(["git", "reset", "--hard"]), allowAll)).toEqual({
      decision: "forbidden",
      matchedRules: [
        {
          type: "prefix_rule_match",
          matchedPrefix: tokens(["git", "reset", "--hard"]),
          decision: "forbidden",
          resolvedProgram: null,
          justification: "destructive operation",
        },
      ],
    });
    expect(policy.check(tokens(["cp", "-r", "src", "dest"]), allowAll).decision).toBe(
      "prompt",
    );
    expect(policy.check(tokens(["which", "-a", "python3"]), promptAll).decision).toBe(
      "allow",
    );
  });

  test("heuristics fallback is returned when no policy matches", () => {
    const evaluation = Policy.empty().check(tokens(["python"]), promptAll);
    expect(evaluationIsMatch(evaluation)).toBe(false);
    expect(evaluation).toEqual({
      decision: "prompt",
      matchedRules: [
        {
          type: "heuristics_rule_match",
          command: tokens(["python"]),
          decision: "prompt",
        },
      ],
    });
  });

  test("multiple command evaluation aggregates matched rules", () => {
    const policy = parsePolicy(
      "test.agencpolicy",
      `
prefix_rule(pattern = ["git"], decision = "prompt")
prefix_rule(pattern = ["git", "commit"], decision = "forbidden")
`,
    );

    expect(
      policy.checkMultiple(
        [tokens(["git", "status"]), tokens(["git", "commit", "-m", "hi"])],
        allowAll,
      ).decision,
    ).toBe("forbidden");
  });

  test("host executable definitions dedupe paths and reject malformed declarations", () => {
    const gitName = hostExecutableName("git");
    const firstGit = hostAbsolutePath(["usr", "bin", gitName]);
    const secondGit = hostAbsolutePath(["opt", "bin", gitName]);
    const policy = parsePolicy(
      "test.agencpolicy",
      `
host_executable(
  name = "git",
  paths = ["${escapedPolicyString(firstGit)}", "${escapedPolicyString(secondGit)}", "${escapedPolicyString(secondGit)}"],
)
`,
    );

    expect(policy.hostExecutables().get("git")).toEqual([firstGit, secondGit]);
    const mutablePolicy = Policy.empty();
    mutablePolicy.setHostExecutablePaths("git", [firstGit, firstGit]);
    expect(mutablePolicy.hostExecutables().get("git")).toEqual([firstGit]);
    expect(() => mutablePolicy.setHostExecutablePaths("git", ["git"])).toThrow(
      /paths must be absolute/u,
    );
    expect(() =>
      mutablePolicy.addHostExecutable("git", [
        hostAbsolutePath(["usr", "bin", hostExecutableName("rg")]),
      ]),
    ).toThrow(/must have basename/u);
    expect(() =>
      parsePolicy("bad.agencpolicy", 'host_executable(name = "git", paths = ["git"])'),
    ).toThrow(/paths must be absolute/u);
    expect(() =>
      parsePolicy(
        "bad.agencpolicy",
        `host_executable(name = "${escapedPolicyString(firstGit)}", paths = ["${escapedPolicyString(firstGit)}"])`,
      ),
    ).toThrow(/bare executable name/u);
    expect(() =>
      parsePolicy(
        "bad.agencpolicy",
        `host_executable(name = "git", paths = ["${escapedPolicyString(hostAbsolutePath([
          "usr",
          "bin",
          "rg",
        ]))}"])`,
      ),
    ).toThrow(/must have basename/u);
  });

  test("Windows executable lookup parity lowercases ASCII only", () => {
    expect(windowsExecutableLookupKey("TÜLIP.EXE")).toBe("tÜlip");
    expect(windowsExecutableLookupKey("Git.CMD")).toBe("git");
  });

  test("host executable last definition wins", () => {
    const gitName = hostExecutableName("git");
    const firstGit = hostAbsolutePath(["usr", "bin", gitName]);
    const secondGit = hostAbsolutePath(["opt", "bin", gitName]);
    const parser = new PolicyParser();
    parser.parse(
      "shared.agencpolicy",
      `host_executable(name = "git", paths = ["${escapedPolicyString(firstGit)}"])`,
    );
    parser.parse(
      "user.agencpolicy",
      `host_executable(name = "git", paths = ["${escapedPolicyString(secondGit)}"])`,
    );

    expect(parser.build().hostExecutables().get("git")).toEqual([secondGit]);
  });

  test("host executable resolution maps absolute programs to basename rules", () => {
    const gitName = hostExecutableName("git");
    const allowedGit = hostAbsolutePath(["usr", "bin", gitName]);
    const otherGit = hostAbsolutePath(["opt", "bin", gitName]);
    const policy = parsePolicy(
      "test.agencpolicy",
      `
prefix_rule(pattern = ["git", "status"], decision = "prompt")
host_executable(name = "git", paths = ["${escapedPolicyString(allowedGit)}"])
`,
    );

    expect(
      policy.checkWithOptions([allowedGit, "status"], allowAll, {
        resolveHostExecutables: true,
      }),
    ).toEqual({
      decision: "prompt",
      matchedRules: [
        {
          type: "prefix_rule_match",
          matchedPrefix: tokens(["git", "status"]),
          decision: "prompt",
          resolvedProgram: allowedGit,
          justification: null,
        },
      ],
    });
    expect(
      policy.checkWithOptions([otherGit, "status"], allowAll, {
        resolveHostExecutables: true,
      }).matchedRules[0]?.type,
    ).toBe("heuristics_rule_match");
  });

  test("host executable resolution falls back without mapping and exact rules take precedence", () => {
    const gitName = hostExecutableName("git");
    const gitPath = hostAbsolutePath(["usr", "bin", gitName]);
    const fallbackPolicy = parsePolicy(
      "test.agencpolicy",
      'prefix_rule(pattern = ["git"], decision = "prompt")',
    );
    expect(
      fallbackPolicy.checkWithOptions([gitPath, "status"], allowAll, {
        resolveHostExecutables: true,
      }).matchedRules[0],
    ).toMatchObject({ type: "prefix_rule_match", resolvedProgram: gitPath });

    const exactPolicy = parsePolicy(
      "test.agencpolicy",
      `
prefix_rule(pattern = ["${escapedPolicyString(gitPath)}"], decision = "allow")
prefix_rule(pattern = ["git"], decision = "prompt")
host_executable(name = "git", paths = ["${escapedPolicyString(gitPath)}"])
`,
    );
    expect(
      exactPolicy.checkWithOptions([gitPath, "status"], allowAll, {
        resolveHostExecutables: true,
      }),
    ).toEqual({
      decision: "allow",
      matchedRules: [
        {
          type: "prefix_rule_match",
          matchedPrefix: [gitPath],
          decision: "allow",
          resolvedProgram: null,
          justification: null,
        },
      ],
    });
  });

  test("host executable resolution respects explicit empty allowlist", () => {
    const gitPath = hostAbsolutePath(["usr", "bin", hostExecutableName("git")]);
    const policy = parsePolicy(
      "test.agencpolicy",
      `
prefix_rule(pattern = ["git"], decision = "prompt")
host_executable(name = "git", paths = [])
`,
    );
    expect(
      policy.checkWithOptions([gitPath, "status"], allowAll, {
        resolveHostExecutables: true,
      }),
    ).toEqual({
      decision: "allow",
      matchedRules: [
        {
          type: "heuristics_rule_match",
          command: [gitPath, "status"],
          decision: "allow",
        },
      ],
    });
  });

  test("CLI check loader and JSON formatter report external-tagged matches", () => {
    const tmp = withTempDir();
    const policyPath = path.join(tmp, "rules.agencpolicy");
    fs.writeFileSync(
      policyPath,
      'prefix_rule(pattern = ["git", "status"], decision = "prompt")\n',
    );
    const policy = loadPolicies([policyPath]);
    const matches = policy.matchesForCommandWithOptions(tokens(["git", "status"]), null, {
      resolveHostExecutables: false,
    });

    expect(JSON.parse(formatMatchesJson(matches, false))).toEqual({
      matchedRules: [
        {
          prefixRuleMatch: {
            matchedPrefix: ["git", "status"],
            decision: "prompt",
          },
        },
      ],
      decision: "prompt",
    });
    expect(parseExecPolicyArgv(["check", "--rules", policyPath, "--", "git", "status"]))
      .toEqual({
        rules: [policyPath],
        pretty: false,
        resolveHostExecutables: false,
        command: ["git", "status"],
      });
    expect(parseExecPolicyArgv(["check", "--rules", policyPath, "-weird", "--flag"]))
      .toEqual({
        rules: [policyPath],
        pretty: false,
        resolveHostExecutables: false,
        command: ["-weird", "--flag"],
      });
  });

  test("amend network rules normalize and reject invalid input", () => {
    const tmp = withTempDir();
    const policyPath = path.join(tmp, "rules", "default.agencpolicy");
    blockingAppendNetworkRule(
      policyPath,
      "LOCALHOST:443",
      "https",
      "allow",
      "temporary approval",
    );
    expect(fs.readFileSync(policyPath, "utf8")).toBe(
      'network_rule(host="localhost", protocol="https", decision="allow", justification="temporary approval")\n',
    );
    expect(() =>
      blockingAppendNetworkRule(policyPath, "*.localhost", "https", "allow"),
    ).toThrow(AmendError);
  });

  test("parser rejects invalid decisions, patterns, examples, and unknown builtins", () => {
    expect(() =>
      parsePolicy("bad.agencpolicy", 'prefix_rule(pattern = ["ls"], decision = "maybe")'),
    ).toThrow(/invalid decision/u);
    expect(() =>
      parsePolicy("bad.agencpolicy", "prefix_rule(pattern = [])"),
    ).toThrow(/pattern cannot be empty/u);
    expect(() =>
      parsePolicy("bad.agencpolicy", 'prefix_rule(pattern = ["ls"], match = [""])'),
    ).toThrow(/example cannot be an empty string/u);
    expect(() => parsePolicy("bad.agencpolicy", "something_else(name = \"x\")")).toThrow(
      /unknown policy builtin/u,
    );
  });

  test("parser rejects unknown keyword arguments for every builtin", () => {
    const gitPath = hostAbsolutePath(["usr", "bin", hostExecutableName("git")]);
    const escapedGitPath = escapedPolicyString(gitPath);

    expect(() =>
      parsePolicy(
        "bad.agencpolicy",
        'prefix_rule(pattern = ["rm"], decisoin = "forbidden")',
      ),
    ).toThrow(/unexpected argument decisoin/u);
    expect(() =>
      parsePolicy(
        "bad.agencpolicy",
        'network_rule(host = "localhost", protocol = "http", decision = "allow", extra = "x")',
      ),
    ).toThrow(/unexpected argument extra/u);
    expect(() =>
      parsePolicy(
        "bad.agencpolicy",
        `host_executable(name = "git", paths = ["${escapedGitPath}"], extra = "x")`,
      ),
    ).toThrow(/unexpected argument extra/u);
  });

  test("parser rejects raw newlines in quoted strings", () => {
    expect(() =>
      parsePolicy(
        "bad.agencpolicy",
        ['prefix_rule(pattern = ["git', 'status"])'].join("\n"),
      ),
    ).toThrow(/raw newline in string literal/u);
  });

  test("parse errors carry source locations", () => {
    try {
      parsePolicy("bad.agencpolicy", 'prefix_rule(pattern = ["ls"]');
      throw new Error("parse should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ExecPolicyError);
      expect((error as ExecPolicyError).location?.path).toBe("bad.agencpolicy");
      expect((error as ExecPolicyError).location?.range.start.line).toBe(1);
    }
  });
});
