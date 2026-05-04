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
  test("flags recursive forced removal of absolute paths", () => {
    expect(isDangerousShellCommand("rm -rf /")).toBe(true);
    expect(isDangerousShellCommand("rm -fr -- /tmp/nonexistent")).toBe(true);
    expect(
      isDangerousShellCommand("rm --recursive --force /important/data"),
    ).toBe(true);
    expect(isDangerousShellCommand("NODE_ENV=test rm -rf '~/cache'")).toBe(true);
  });

  test("flags wrapper and nested shell removal forms", () => {
    expect(isDangerousShellCommand("nice rm -rf /tmp/nonexistent")).toBe(true);
    expect(isDangerousShellCommand("timeout 10 rm -rf /important/data")).toBe(true);
    expect(isDangerousShellCommand("env rm -rf /important/data")).toBe(true);
    expect(isDangerousShellCommand("bash -lc 'rm -rf /important/data'")).toBe(
      true,
    );
    expect(
      isDangerousShellCommand("bash -lc 'cd /tmp; rm -rf /important/data'"),
    ).toBe(true);
    expect(
      isDangerousShellCommand("bash -lc 'exec rm -rf /important/data'"),
    ).toBe(true);
  });

  test("does not flag relative cleanup or quoted text", () => {
    expect(isDangerousShellCommand("rm -rf ./dist")).toBe(false);
    expect(isDangerousShellCommand("echo 'rm -rf /'")).toBe(false);
    expect(isDangerousShellCommand("echo rm -rf /")).toBe(false);
  });

  test("returns the matched safety label", () => {
    expect(matchedDangerousShellCommandLabel("rm -rf /important/data")).toBe(
      "rm -rf absolute path",
    );
    expect(matchedDangerousShellCommandLabel("git status")).toBeNull();
  });
});
