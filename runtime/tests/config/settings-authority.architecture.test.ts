import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../../src");
const testRoot = resolve(import.meta.dirname, "..");
const sdkSourceRoot = resolve(import.meta.dirname, "../../../packages/agenc-sdk/src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/u.test(entry)
        ? [path]
        : [];
  });
}

const legacyOperatorSurface =
  /(?:~\/)?\.agenc\/settings(?:\.local)?\.json|managed-settings(?:\.json|\.d)|\bAGENC_MANAGED_SETTINGS(?:_PATH)?\b/u;
const joinedLegacyProjectSurface =
  /["']\.agenc["'][\s\S]{0,120}["']settings(?:\.local)?\.json["']/u;

const explicitLegacyBoundary = new Set([
  "config/migration.ts",
  // Ordinary loading names retired inputs only to reject them with explicit
  // migration guidance; the metadata-only detector never parses a file.
  "config/retired-input-preflight.ts",
  // These security parsers retain literal retired filenames so attempted
  // writes remain denied after migration.
  "tools/BashTool/bashPermissions.ts",
  "tools/BashTool/pathValidation.ts",
  "tools/PowerShellTool/modeValidation.ts",
  "tools/PowerShellTool/pathValidation.ts",
  "tools/PowerShellTool/powershellPermissions.ts",
  "utils/permissions/filesystem.ts",
  "utils/permissions/pathValidation.ts",
]);

const explicitLegacyTestBoundary = new Set([
  // Revert-sensitive migration fixtures.
  "bin/config-cli-v2-migration.test.ts",
  "bin/project-trust-preflight.test.ts",
  "config/canonical-repository.test.ts",
  "config/config-value-alias-migration.test.ts",
  "config/global-state-authority-migration.test.ts",
  "config/gateway-config-authority-migration.test.ts",
  "config/keybindings-authority-migration.test.ts",
  "config/mcp-json-authority-migration.test.ts",
  "config/migration-quarantine-race.test.ts",
  "config/migration-lock-release.test.ts",
  "config/migration-transaction.test.ts",
  "config/ordinary-load-no-migration.test.ts",
  "config/per-tool-config-authority.test.ts",
  "config/permission-control-migration.test.ts",
  "config/plaintext-credential-migration.test.ts",
  "config/retired-config-surface-authority.test.ts",
  // Retired paths remain protected security targets.
  "permissions/path-validation.test.ts",
  "utils/agencUiSurfaces.test.ts",
  // This test necessarily spells the forbidden patterns it enforces.
  "config/settings-authority.architecture.test.ts",
]);

describe("single settings authority boundary", () => {
  test("retired operator JSON paths appear only in migration and security deny lists", () => {
    const violations = sourceFiles(sourceRoot).flatMap((path) => {
      const name = relative(sourceRoot, path);
      if (explicitLegacyBoundary.has(name)) return [];
      return legacyOperatorSurface.test(readFileSync(path, "utf8"))
        ? [name]
        : [];
    });

    expect(violations).toEqual([]);
  });

  test("plugin bundles load defaults only from manifest.settings", () => {
    const loaders = ["plugins/loader.ts"] as const;
    const violations = loaders.flatMap((name) => {
      const source = readFileSync(resolve(sourceRoot, name), "utf8");
      return source.includes("settings.json") ||
          !source.includes("manifest.settings")
        ? [name]
        : [];
    });

    expect(violations).toEqual([]);
  });

  test("removed JSON authority APIs and modules cannot return", () => {
    const forbidden =
      /\b(?:parseSettingsFile|readSettingsFileLenient|getSettings_DEPRECATED|getManagedSettingsDropInDir)\b|addDirPluginSettings|utils\/settings\/mdm\//u;
    const violations = sourceFiles(sourceRoot).flatMap((path) => {
      const name = relative(sourceRoot, path);
      return forbidden.test(readFileSync(path, "utf8")) ? [name] : [];
    });

    expect(violations).toEqual([]);
  });

  test("the retired JSON shape and compatibility projection cannot return", () => {
    const forbidden =
      /\b(?:SettingsSchema|SettingsJson|mergeExecutionAuthoritySettings|settingsMergeCustomizer|getPluginSettingsBase|setPluginSettingsBase|cachePluginSettings|getFlagSettingsPath|setFlagSettingsPath|flagSettingsPath)\b/u;
    const sourceViolations = sourceFiles(sourceRoot).flatMap((path) => {
      const name = relative(sourceRoot, path);
      return forbidden.test(readFileSync(path, "utf8")) ? [name] : [];
    });
    const sdkViolations = sourceFiles(sdkSourceRoot).flatMap((path) => {
      const name = relative(sdkSourceRoot, path);
      return forbidden.test(readFileSync(path, "utf8")) ? [name] : [];
    });

    expect({ source: sourceViolations, sdk: sdkViolations }).toEqual({
      source: [],
      sdk: [],
    });
  });

  test("retired CLI, credential-helper, and renamed config seams stay migration-only", () => {
    const migrationFiles = new Set([
      "config/retired-field-manifest.ts",
      "config/migration.ts",
      "config/state.ts",
    ]);
    const forbidden =
      /--settings|\bapiKeyHelper\b|\.enabledPlugins\b|\.effortLevel\b|sandbox\.enabled|permissions\.default_mode/u;
    const violations = sourceFiles(sourceRoot).flatMap((path) => {
      const name = relative(sourceRoot, path);
      if (migrationFiles.has(name)) return [];
      return forbidden.test(readFileSync(path, "utf8")) ? [name] : [];
    });

    expect(violations).toEqual([]);
  });

  test("runtime settings bridges contain no JSON file authority", () => {
    for (const name of [
      "utils/settings/settings.ts",
      "permissions/settings.ts",
    ]) {
      const content = readFileSync(resolve(sourceRoot, name), "utf8");
      expect(content, name).not.toMatch(/JSON\.parse|JSON\.stringify/u);
      expect(content, name).not.toMatch(legacyOperatorSurface);
      expect(content, name).not.toMatch(/\bSettingsSchema\b/u);
      expect(content, name).not.toMatch(/\bSettingsJson\b/u);
    }
  });

  test("settings consumers never re-resolve a process-global home", () => {
    for (const name of [
      "utils/settings/settings.ts",
      "utils/settings/changeDetector.ts",
      "utils/settings/canonicalAuthority.ts",
    ]) {
      const content = readFileSync(resolve(sourceRoot, name), "utf8");
      expect(content, name).not.toMatch(/\bresolveHomeContext\b/u);
    }
  });

  test("tests and generated SDK surfaces cannot advertise retired config paths", () => {
    const testViolations = sourceFiles(testRoot).flatMap((path) => {
      const name = relative(testRoot, path);
      if (explicitLegacyTestBoundary.has(name)) return [];
      const content = readFileSync(path, "utf8");
      return legacyOperatorSurface.test(content) || joinedLegacyProjectSurface.test(content)
        ? [name]
        : [];
    });
    const sdkViolations = sourceFiles(sdkSourceRoot).flatMap((path) => {
      const name = relative(sdkSourceRoot, path);
      return legacyOperatorSurface.test(readFileSync(path, "utf8"))
        ? [name]
        : [];
    });

    expect({ tests: testViolations, sdk: sdkViolations }).toEqual({
      tests: [],
      sdk: [],
    });
  });
});
