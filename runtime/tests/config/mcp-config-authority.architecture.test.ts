import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

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

describe("canonical MCP configuration authority", () => {
  test("keeps retired operator MCP JSON names inside migration and plugin bundles", () => {
    const allowedPrefixes = ["plugins/", "utils/plugins/"];
    const violations = sourceFiles(sourceRoot).flatMap((path) => {
      const name = relative(sourceRoot, path);
      if (
        name === "config/migration.ts" ||
        name === "config/retired-input-preflight.ts" ||
        allowedPrefixes.some((prefix) => name.startsWith(prefix))
      ) {
        return [];
      }
      return /(?:\.mcp\.json|managed-mcp\.json)/u.test(
        readFileSync(path, "utf8"),
      )
        ? [name]
        : [];
    });

    expect(violations).toEqual([]);
  });

  test("does not parse or select MCP config outside canonical layer snapshots", () => {
    const config = readFileSync(
      resolve(sourceRoot, "services/mcp/config.ts"),
      "utf8",
    );
    const user = readFileSync(
      resolve(sourceRoot, "services/mcp/user-config-toml.ts"),
      "utf8",
    );

    expect(config).toContain("authority.sources(");
    expect(config).toContain("hasManagedMcpAuthority(authority)");
    expect(config).not.toMatch(
      /parseMcpConfigFromFilePath|getEnterpriseMcpFilePath|writeMcpjsonFile|getProjectMcpConfigsFromCwd|getCanonicalSettingsAuthority/u,
    );
    expect(user).not.toMatch(
      /parseToml|readFileSync|resolveAgencHome|getCanonicalSettingsAuthority/u,
    );
  });

  test("keeps the removed MCP environment channel rejection-only", () => {
    const references = sourceFiles(sourceRoot)
      .filter((path) =>
        readFileSync(path, "utf8").includes("AGENC_MCP_SERVERS"),
      )
      .map((path) => relative(sourceRoot, path).replaceAll("\\", "/"))
      .sort();

    expect(references).toEqual(["config/env.ts"]);
    expect(readFileSync(resolve(sourceRoot, "session/mcp-startup.ts"), "utf8"))
      .not.toMatch(/getMcpConfigFromEnv|createSessionMcpManagerFromEnv/u);
    expect(readFileSync(resolve(sourceRoot, "bin/agenc-main.ts"), "utf8"))
      .not.toContain("envWithBridgeMcpServers");
  });
});
