import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigStore } from "../src/config/store.js";
import {
  getManagedFilePath,
  resolveManagedConfigPath,
  resolveManagedInstructionPath,
  resolveManagedInstructionRulesPath,
  resolveManagedRootPath,
} from "../src/utils/settings/managedPath.js";
import { runWithCanonicalSettingsAuthority } from "../src/utils/settings/canonicalAuthority.js";

describe("hermetic managed-policy path", () => {
  it("routes marked Vitest workers into the minted test home", () => {
    const hermeticHome = process.env.AGENC_TEST_HERMETIC_HOME;

    expect(hermeticHome).toBeTruthy();
    expect(process.env.VITEST).toBe("true");
    const managedRoot = join(hermeticHome as string, "managed-policy");
    const store = new ConfigStore({
      home: hermeticHome,
      managedConfigPath: join(managedRoot, "config.toml"),
      loader: async () => ({ configVersion: 2 }),
    });
    expect(
      runWithCanonicalSettingsAuthority(store, () => getManagedFilePath()),
    ).toBe(managedRoot);
    expect(store.managedPaths).toEqual({
      root: managedRoot,
      instructions: join(managedRoot, "AGENC.md"),
      rules: join(managedRoot, "rules"),
    });
  });

  it("resolves platform defaults and adjacent override rules", () => {
    expect(resolveManagedInstructionPath({}, "linux")).toBe(
      "/etc/agenc/AGENC.md",
    );
    expect(resolveManagedInstructionPath({}, "darwin")).toBe(
      "/Library/Application Support/AgenC/AGENC.md",
    );
    const windowsInstructions = resolveManagedInstructionPath(
      { ProgramData: "D:\\CapturedProgramData" },
      "win32",
    );
    expect(windowsInstructions).toBe(
      "D:\\CapturedProgramData\\AgenC\\AGENC.md",
    );
    expect(
      resolveManagedInstructionRulesPath(windowsInstructions, "win32"),
    ).toBe("D:\\CapturedProgramData\\AgenC\\rules");

    const override = "E:\\CapturedPolicy\\Team.md";
    expect(
      resolveManagedInstructionPath(
        { AGENC_MANAGED_INSTRUCTIONS: override },
        "win32",
      ),
    ).toBe(override);
    expect(resolveManagedInstructionRulesPath(override, "win32")).toBe(
      "E:\\CapturedPolicy\\rules",
    );
  });

  it("resolves Windows managed paths from the captured environment", () => {
    expect(
      resolveManagedRootPath(
        { ProgramData: "D:\\CapturedProgramData" },
        "win32",
      ),
    ).toBe("D:\\CapturedProgramData\\AgenC");
    expect(
      resolveManagedConfigPath(
        { ProgramData: "D:\\CapturedProgramData" },
        "win32",
      ),
    ).toBe("D:\\CapturedProgramData\\AgenC\\config.toml");
    expect(resolveManagedConfigPath({}, "win32")).toBe(
      "C:\\ProgramData\\AgenC\\config.toml",
    );
  });

  it("keeps repository and migration defaults on the shared captured resolver", () => {
    const repositorySource = readFileSync(
      join(import.meta.dirname, "../src/config/repository.ts"),
      "utf8",
    );
    const migrationSource = readFileSync(
      join(import.meta.dirname, "../src/config/migration.ts"),
      "utf8",
    );

    expect(repositorySource).not.toContain("process.env.ProgramData");
    expect(migrationSource).not.toContain("process.env.ProgramData");
    expect(
      repositorySource.match(/resolveManagedConfigPath\(env\)/gu),
    ).toHaveLength(2);
    expect(
      migrationSource.match(/resolveManagedConfigPath\(environment\)/gu),
    ).toHaveLength(1);
    expect(repositorySource).not.toContain("AGENC_MANAGED_INSTRUCTIONS");
    expect(migrationSource).not.toContain("AGENC_MANAGED_INSTRUCTIONS");
  });

  it("keeps prompt and Markdown consumers on captured managed authority", () => {
    const promptSource = readFileSync(
      join(import.meta.dirname, "../src/prompts/agenc-md.ts"),
      "utf8",
    );
    const rulesSource = readFileSync(
      join(import.meta.dirname, "../src/prompts/rules/discovery.ts"),
      "utf8",
    );
    const markdownSource = readFileSync(
      join(import.meta.dirname, "../src/utils/markdownConfigLoader.ts"),
      "utf8",
    );
    const managedPathSource = readFileSync(
      join(import.meta.dirname, "../src/utils/settings/managedPath.ts"),
      "utf8",
    );

    expect(promptSource).not.toContain(
      "process.env." + "AGENC_MANAGED_INSTRUCTIONS",
    );
    expect(promptSource).not.toContain("DEFAULT_MANAGED_INSTRUCTION_PATH");
    expect(promptSource).not.toContain("DEFAULT_MANAGED_RULES_DIR");
    expect(rulesSource).not.toContain("DEFAULT_MANAGED_RULES_DIR");
    expect(markdownSource).toContain("getManagedFilePath(authority)");
    expect(managedPathSource).not.toContain("memoize");
  });
});
