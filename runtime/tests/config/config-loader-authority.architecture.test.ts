import { readFileSync, readdirSync, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

function sourceFiles(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((entry) => sourceFiles(`${path}/${entry}`));
}

describe("canonical configuration loader authority", () => {
  test("production cannot restore lenient or automatic migration loaders", () => {
    const forbidden =
      /\b(?:loadConfig|runStartupConfigMigrations|ensureUserConfigV2|skipUserMigration)\b/;
    const offenders = sourceFiles(SRC)
      .filter((path) => path.endsWith(".ts") || path.endsWith(".tsx"))
      .filter((path) => forbidden.test(readFileSync(path, "utf8")));

    expect(offenders).toEqual([]);
  });

  test("only the explicit config CLI imports the legacy migration engine", () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => path.endsWith(".ts") || path.endsWith(".tsx"))
      .filter((path) => /["']\.\.\/config\/migration\.js["']/u.test(
        readFileSync(path, "utf8"),
      ));

    expect(offenders).toEqual([`${SRC}/bin/config-cli.ts`]);
  });

  test("ordinary bootstrap cannot invoke automatic operator migrations", () => {
    const bootstrapBoundaries = [
      "bin/bootstrap.ts",
      "bin/bootstrap-services.ts",
      "session/bootstrap.ts",
      "app-server/agent-lifecycle.ts",
      "app-server/background-agent-runner.ts",
    ];
    const forbidden =
      /(?:config|personality|plugin)[^\n]{0,80}(?:migrat|ensureUserConfigV2)|(?:migrat|ensureUserConfigV2)[^\n]{0,80}(?:config|personality|plugin)/iu;
    const violations = bootstrapBoundaries.filter((name) =>
      forbidden.test(readFileSync(`${SRC}/${name}`, "utf8")),
    );

    expect(violations).toEqual([]);
    expect(existsSync(`${SRC}/personality/migration.ts`)).toBe(false);
  });

  test("has no process-global config gate or no-op settings cache", () => {
    expect(existsSync(`${SRC}/config/init.ts`)).toBe(false);
    expect(existsSync(`${SRC}/utils/settings/settingsCache.ts`)).toBe(false);
    const source = sourceFiles(SRC)
      .filter((path) => path.endsWith(".ts") || path.endsWith(".tsx"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(source).not.toMatch(
      /\b(?:enableConfigs|configReadsEnabled|assertConfigReadsEnabled|resetSettingsCache)\b/u,
    );
  });

  test("the parser module exposes syntax parsing only", () => {
    const source = readFileSync(`${SRC}/config/loader.ts`, "utf8");
    expect(source).not.toMatch(/\bloadConfig\b/);
    expect(source).toMatch(/export function parseToml\b/);
  });
});
