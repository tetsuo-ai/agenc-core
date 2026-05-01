import { describe, expect, test } from "vitest";

import {
  CROSS_PLATFORM_CODE_EXEC,
  DANGEROUS_BASH_PATTERNS,
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
