import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  getManagedFilePath,
  resolveManagedConfigPath,
  resolveManagedRootPath,
} from "../src/utils/settings/managedPath.js";

describe("hermetic managed-policy path", () => {
  it("routes marked Vitest workers into the minted test home", () => {
    const hermeticHome = process.env.AGENC_TEST_HERMETIC_HOME;

    expect(hermeticHome).toBeTruthy();
    expect(process.env.VITEST).toBe("true");
    expect(getManagedFilePath()).toBe(
      join(hermeticHome as string, "managed-policy"),
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
  });
});
