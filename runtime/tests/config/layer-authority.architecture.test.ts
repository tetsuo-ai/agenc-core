import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { MANAGED_ONLY_CONFIG_KEYS } from "../../src/config/layer-authority.js";

const sourceRoot = resolve(import.meta.dirname, "../../src");

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

function source(relativePath: string): string {
  return readFileSync(resolve(sourceRoot, relativePath), "utf8");
}

describe("config layer authority architecture", () => {
  test("defines authority registries in exactly one neutral module", () => {
    const definition = /(?:export\s+)?const\s+(?:MANAGED_ONLY_CONFIG_KEYS|OPERATOR_ONLY_CONFIG_KEYS|REPOSITORY_MONOTONIC_CONFIG_KEYS)\s*=/u;
    const violations = sourceFiles(sourceRoot)
      .filter((path) => definition.test(readFileSync(path, "utf8")))
      .map((path) => relative(sourceRoot, path));
    expect(violations).toEqual(["config/layer-authority.ts"]);

    expect(source("config/repository.ts")).toMatch(
      /MANAGED_ONLY_CONFIG_KEYS[\s\S]*OPERATOR_ONLY_CONFIG_KEYS/u,
    );
    expect(source("utils/settings/settings.ts")).toMatch(
      /MANAGED_ONLY_CONFIG_KEYS[\s\S]*OPERATOR_ONLY_CONFIG_KEYS/u,
    );
  });

  test("profiles and environment adapters cannot synthesize managed-only policy", () => {
    for (const relativePath of ["config/env.ts", "config/profiles.ts"]) {
      const content = source(relativePath);
      for (const key of MANAGED_ONLY_CONFIG_KEYS) {
        expect(content, `${relativePath}:${key}`).not.toContain(key);
      }
    }
  });

  test("managed-only consumers project the managed source explicitly", () => {
    for (const relativePath of [
      "tools/WebFetchTool/utils.ts",
      "memory/agencmd.ts",
    ]) {
      expect(source(relativePath), relativePath).toContain(
        "getSettingsForSource('policySettings')",
      );
    }
  });

  test("model policy reads only the final config passed by its caller", () => {
    const matcher = source("utils/model/modelAllowlist.ts");
    expect(matcher).not.toMatch(
      /getSettingsForSource|getExecutionAuthoritySettings|ConfigStore/u,
    );
    expect(source("session/provider-model-selection.ts")).toContain(
      "isModelAllowed",
    );
    expect(source("commands/model-menu.tsx")).toContain("isModelAllowed");
  });

  test("every generic user-config write boundary checks source authority", () => {
    const cli = source("bin/config-cli.ts");
    expect(cli).toContain("assertConfigPatchAuthority");
    expect(cli).toContain("mutateCanonicalUserConfigSync");
    expect(cli).toContain("editCanonicalUserConfig");
    expect(cli).not.toMatch(
      /(?:serializeConfigToml|writeTextAtomic|readConfigTomlRaw|validateAndWriteConfig)/u,
    );
    expect(source("config/edit.ts")).toContain(
      "mutateCanonicalUserConfigSync",
    );
    expect(source("config/update-sync.ts")).toContain(
      "assertConfigPatchAuthority(scope, patch)",
    );
  });

  test("onboarding mutations use the canonical locked config writer", () => {
    const autonomy = source("onboarding/acts/autonomy.ts");
    expect(autonomy).toContain("mutateCanonicalUserConfigSync");
    expect(autonomy).not.toMatch(
      /resolveGatewayConfigPath|gateway\/config\.json|appendTomlSectionIfAbsent/u,
    );
  });

  test("repository policy contains no authority rules for retired sandbox or shell fields", () => {
    const repository = source("config/repository.ts");
    for (const field of [
      "failIfUnavailable",
      "writable_roots",
      "ignore_default_excludes",
      "include_only",
    ]) {
      expect(repository, field).not.toContain(field);
    }
    expect(repository).not.toMatch(/shell_environment_policy\.(?:inherit|exclude)\b/u);
  });
});
