import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

function sourceFiles(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((entry) => sourceFiles(`${path}/${entry}`));
}

describe("permission authority architecture", () => {
  test("obsolete setup and loader authorities cannot return", () => {
    expect(
      existsSync(`${SRC}/utils/permissions/permissionSetup.ts`),
    ).toBe(false);
    expect(
      existsSync(`${SRC}/utils/permissions/permissionsLoader.ts`),
    ).toBe(false);

    const obsoleteImport =
      /(?:from\s+|import\s*\()["'][^"']*(?:permissionSetup|permissionsLoader)\.js["']/;
    const offenders = sourceFiles(SRC)
      .filter((path) => path.endsWith(".ts") || path.endsWith(".tsx"))
      .filter((path) => obsoleteImport.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });

  test("the compatibility update facade persists through canonical settings", () => {
    const source = readFileSync(
      `${SRC}/utils/permissions/PermissionUpdate.ts`,
      "utf8",
    );
    expect(source).toContain(
      "persistPermissionUpdateToConfig",
    );
    expect(source).not.toMatch(/utils\/settings\/settings|permissionsLoader/);
  });
});
