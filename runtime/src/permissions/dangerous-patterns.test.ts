import { describe, expect, test } from "vitest";

import {
  CROSS_PLATFORM_CODE_EXEC,
  DANGEROUS_BASH_PATTERNS,
  isDangerousShellCommand,
  matchedDangerousShellCommandLabel,
} from "./dangerous-patterns.js";
import {
  CROSS_PLATFORM_CODE_EXEC as UPSTREAM_CROSS_PLATFORM_CODE_EXEC,
  DANGEROUS_BASH_PATTERNS as UPSTREAM_DANGEROUS_BASH_PATTERNS,
} from "../agenc/upstream/utils/permissions/dangerousPatterns.js";

describe("dangerous-patterns upstream parity", () => {
  test("cross-platform code execution entries match upstream", () => {
    expect([...CROSS_PLATFORM_CODE_EXEC]).toEqual([
      ...UPSTREAM_CROSS_PLATFORM_CODE_EXEC,
    ]);
  });

  test("Bash dangerous pattern entries match upstream for the current env", () => {
    expect([...DANGEROUS_BASH_PATTERNS]).toEqual([
      ...UPSTREAM_DANGEROUS_BASH_PATTERNS,
    ]);
  });
});

describe("dangerous shell command detection", () => {
  test("flags recursive forced removal of critical paths", () => {
    expect(isDangerousShellCommand("rm -rf /")).toBe(true);
    expect(isDangerousShellCommand("rm -fr -- '/*'")).toBe(true);
    expect(isDangerousShellCommand("rm --recursive --force /tmp")).toBe(true);
    expect(isDangerousShellCommand("NODE_ENV=test rm -rf '~'")).toBe(true);
  });

  test("flags wrapper and nested shell removal forms", () => {
    expect(isDangerousShellCommand("nice rm -rf /tmp")).toBe(true);
    expect(isDangerousShellCommand("timeout 10 rm -rf /")).toBe(true);
    expect(isDangerousShellCommand("env rm -rf /")).toBe(true);
    expect(isDangerousShellCommand("bash -lc 'rm -rf /'")).toBe(true);
    expect(
      isDangerousShellCommand("bash -lc 'cd /tmp; rm -rf /'"),
    ).toBe(true);
    expect(
      isDangerousShellCommand("bash -lc 'exec rm -rf /'"),
    ).toBe(true);
  });

  test("does not flag relative or non-critical absolute cleanup", () => {
    const workspaceTmp = `${process.cwd().replace(/\\/g, "/")}/tmp`;

    expect(isDangerousShellCommand("rm -rf ./dist")).toBe(false);
    expect(isDangerousShellCommand(`rm -rf ${workspaceTmp}`)).toBe(false);
    expect(isDangerousShellCommand("rm -rf ~/cache")).toBe(false);
  });

  test("does not flag quoted text or non-rm wrapped commands", () => {
    expect(isDangerousShellCommand("echo 'rm -rf /'")).toBe(false);
    expect(isDangerousShellCommand("echo rm -rf /")).toBe(false);
    expect(isDangerousShellCommand("timeout 10 echo rm -rf /")).toBe(false);
    expect(isDangerousShellCommand("nice echo rm -rf /")).toBe(false);
    expect(isDangerousShellCommand("env FOO=bar echo rm -rf /")).toBe(false);
  });

  test("returns the matched safety label", () => {
    expect(matchedDangerousShellCommandLabel("rm -rf /")).toBe(
      "rm -rf critical path",
    );
    expect(matchedDangerousShellCommandLabel("git status")).toBeNull();
  });
});
