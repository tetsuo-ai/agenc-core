import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

const TEST_ROOT = resolve(import.meta.dirname, "..");

const EXPLICIT_OBSOLETE_ALIAS_FIXTURES = new Set([
  "bin/agenc-help.test.ts",
  "config/canonical-repository.test.ts",
  "config/plaintext-credential-migration.test.ts",
  "hermetic-test-discovery.test.ts",
  "sdk-package/protocol-drift.contract.test.ts",
  "tui-e2e-harness-env.test.ts",
  "utils/agencPaths.test.ts",
  "utils/env.test.ts",
  "utils/secureStorage/migrationIdentity.test.ts",
]);

function testSourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) return testSourceFiles(path);
    return /\.(?:mjs|ts|tsx)$/u.test(entry) ? [path] : [];
  });
}

describe("canonical test home authority", () => {
  test("ordinary tests never install the removed config-home alias", () => {
    const aliasAssignment =
      /(?:\.AGENC_CONFIG_DIR|\[\s*["']AGENC_CONFIG_DIR["']\s*\])\s*=|(?:^|[{,]\s*)AGENC_CONFIG_DIR\s*:/mu;
    const violations = testSourceFiles(TEST_ROOT).flatMap((path) => {
      const name = relative(TEST_ROOT, path);
      if (EXPLICIT_OBSOLETE_ALIAS_FIXTURES.has(name)) return [];
      return aliasAssignment.test(readFileSync(path, "utf8")) ? [name] : [];
    });

    expect(violations).toEqual([]);
  });
});
