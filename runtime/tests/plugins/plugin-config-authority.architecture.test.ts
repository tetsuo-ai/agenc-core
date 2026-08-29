import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, test } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../../src");
const docsRoot = resolve(import.meta.dirname, "../../../docs");

function source(relativePath: string): string {
  return readFileSync(resolve(sourceRoot, relativePath), "utf8");
}

function markdownFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory()
      ? markdownFiles(path)
      : entry.endsWith(".md")
        ? [path]
        : [];
  });
}

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

describe("plugin config authority architecture", () => {
  test("plugin package and cache authority has no live fallback path", () => {
    const manifest = source("plugins/manifest.ts");
    const canonicalLoader = source("plugins/loader.ts");
    const directories = source("plugins/directories.ts");
    const runtimeOptions = source("session/runtime-options.ts");

    expect(manifest).toContain("assertNoRetiredRootPluginManifest");
    expect(manifest).toContain("loadRequiredPluginManifest");
    expect(manifest).not.toContain("ROOT_PLUGIN_MANIFEST_RELATIVE_PATH");
    expect(canonicalLoader).toContain("inspectPluginPackageAuthority(");
    expect(canonicalLoader).toContain("loadRequiredPluginManifest(");
    const packageAuthority = source("plugins/package-authority.ts");
    expect(packageAuthority).toContain('RETIRED_PLUGIN_MCP_FILE = ".mcp.json"');
    expect(packageAuthority).toContain('RETIRED_PLUGIN_SETTINGS_FILE = "settings.json"');
    expect(source("plugins/registration/mcp-plugin-integration.ts")).not.toMatch(
      /loadMcpServersFromFile\(\s*plugin\.path,\s*["']\.mcp\.json/u,
    );
    expect(
      sourceFiles(sourceRoot).map((path) => relative(sourceRoot, path)),
    ).not.toContain("utils/plugins/mcpPluginIntegration.ts");
    expect(directories).not.toContain("process.env");
    expect(directories).not.toContain("getPluginSeedDirs");
    expect(runtimeOptions).not.toContain("pluginSeedRoots");
    expect(runtimeOptions).toContain("RETIRED_AGENT_RUNTIME_ENV_REPLACEMENTS");
    expect(directories).toContain("one explicit or session-owned plugin storage authority");
    const sourcePaths = sourceFiles(sourceRoot)
      .map((path) => relative(sourceRoot, path).replaceAll("\\", "/"));
    for (const retiredPath of [
      "utils/plugins/pluginDirectories.ts",
      "utils/plugins/cacheUtils.ts",
      "utils/plugins/dependencyResolver.ts",
      "utils/plugins/gitAvailability.ts",
      "utils/plugins/installedPluginsManager.ts",
      "utils/plugins/managedPlugins.ts",
      "utils/plugins/marketplaceHelpers.ts",
      "utils/plugins/pluginInstallationHelpers.ts",
      "utils/plugins/pluginLoader.ts",
      "utils/plugins/pluginPolicy.ts",
      "utils/plugins/pluginVersioning.ts",
      "utils/plugins/zipCache.ts",
    ]) {
      expect(sourcePaths).not.toContain(retiredPath);
    }
  });

  test("plugin storage paths and reserved child names have one owner", () => {
    const directories = source("plugins/directories.ts");
    const inventory = source("plugins/marketplace/inventory.ts");
    const loader = source("plugins/loader.ts");
    const operations = source("plugins/cli/pluginOperations.ts");

    expect(directories).toContain("isReservedPluginStorageChildName");
    expect(loader).toContain("isReservedPluginStorageChildName(entry.name)");
    expect(operations).toContain("isReservedPluginStorageChildName(trimmed)");
    expect(operations).toContain("pluginFilesystemKey(trimmed)");
    expect(loader).not.toMatch(
      /const SKIP_PLUGIN_ROOTS = new Set\(\[[^\]]*["'](?:build|cache|coverage|data|dist|marketplaces|node_modules)["']/u,
    );
    expect(operations).not.toContain("RESERVED_INSTALL_NAMES");

    expect(inventory).toContain("pluginInventoryPath(");
    expect(inventory).not.toMatch(
      /(?:join|resolve)\([\s\S]{0,160}?["']known_marketplaces\.json["']/u,
    );
    const inventoryPathConstructors = sourceFiles(sourceRoot)
      .map((path) => relative(sourceRoot, path).replaceAll("\\", "/"))
      .filter((path) =>
        /(?:join|resolve)\([\s\S]{0,160}?["']known_marketplaces\.json["']/u
          .test(source(path)))
      .sort();
    expect(inventoryPathConstructors).toEqual(["plugins/directories.ts"]);
  });

  test("removed plugin directory selectors have no runtime residue", () => {
    const retiredSelector = /AGENC_USE_COWORK_PLUGINS|cowork_plugins|useCoworkPlugins|UseCoworkPlugins/u;
    const violations = sourceFiles(sourceRoot)
      .filter((path) => retiredSelector.test(readFileSync(path, "utf8")))
      .map((path) => relative(sourceRoot, path));
    expect(violations).toEqual([]);
  });

  test("retired plugin storage environment names are absent from code and docs", () => {
    const retiredEnvironmentName =
      /AGENC_PLUGIN_SEED_DIR|AGENC_PLUGIN_USE_ZIP_CACHE|CLAUDE_PLUGIN_(?:ROOT|DATA|SESSION_ID)/u;
    const sourceViolations = sourceFiles(sourceRoot)
      .filter((path) => retiredEnvironmentName.test(readFileSync(path, "utf8")))
      .map((path) => relative(sourceRoot, path));
    const documentationViolations = markdownFiles(docsRoot)
      .filter((path) => retiredEnvironmentName.test(readFileSync(path, "utf8")))
      .map((path) => relative(docsRoot, path));

    expect(sourceViolations).toEqual([]);
    expect(documentationViolations).toEqual([]);
  });

  test("plugin request paths never consult ambient process environment or cwd", () => {
    const pluginRoots = [
      resolve(sourceRoot, "plugins"),
      resolve(sourceRoot, "utils/plugins"),
    ];
    const violations = pluginRoots
      .flatMap(sourceFiles)
      .filter((path) => /process\.env|process\.cwd\(\)/u.test(readFileSync(path, "utf8")))
      .map((path) => relative(sourceRoot, path).replaceAll("\\", "/"));

    expect(violations).toEqual([]);
  });

  test("CLI plugin entry writes use the canonical config authority", () => {
    const operations = source("plugins/cli/pluginOperations.ts");

    expect(operations).toContain("mutateCanonicalUserConfigSync(");
    expect(operations.match(/mutateCanonicalUserConfigSync\(/gu)).toHaveLength(2);
    expect(operations).not.toMatch(
      /(?:serializeConfigToml|parseToml|writeTextAtomic|MANAGED_CONFIG_|managedMarker|removeManagedBlock|renderManagedPluginBlock)/u,
    );
    expect(operations).not.toMatch(/entry\.(?:source|version|required|options)\b/u);
  });

  test("canonical TOML serialization has only sanctioned production callers", () => {
    const callers = sourceFiles(sourceRoot)
      .map((path) => relative(sourceRoot, path))
      .filter((path) => path !== "config/serialize.ts")
      .filter((path) => /\bserializeConfigToml\b/u.test(source(path)))
      .sort();

    expect(callers).toEqual([
      "config/migration.ts",
      "config/project-init.ts",
      "config/update-sync.ts",
    ]);
  });

  test("plugin option values have one canonical config owner", () => {
    const storage = source("utils/plugins/pluginOptionsStorage.ts");
    expect(storage).toContain("settings.pluginConfigs?.[pluginId]?.options");
    expect(storage).toContain("pluginConfigs:");
    expect(storage).not.toMatch(
      /settings\.plugins\?\.plugins\?\.\[pluginId\]\?\.options/u,
    );
  });

  test("plugin secret writes use serialized native secure storage transactions", () => {
    for (const path of [
      "utils/plugins/pluginOptionsStorage.ts",
      "utils/plugins/mcpbHandler.ts",
    ]) {
      const content = source(path);
      expect(content, path).toContain("updateNativeSecureStorage(");
      expect(content, path).toContain("rollbackPluginSecretBucket(");
      expect(content, path).not.toMatch(/\bstorage\.update\s*\(/u);
    }
  });

  test("plugin enablement has one block-shaped config representation", () => {
    const schema = source("config/schema.ts");
    expect(schema).toContain(
      "readonly plugins?: Readonly<Record<string, PluginEntryConfig>>",
    );
    expect(schema).not.toMatch(/PluginEntryConfig\s*\|\s*boolean|boolean\s*\|\s*PluginEntryConfig/u);
    for (const path of [
      "plugins/loader.ts",
      "plugins/builtinPlugins.ts",
    ]) {
      expect(source(path), path).not.toMatch(
        /typeof\s+[^\n]*(?:plugin|setting|entry)[^\n]*===\s*["']boolean["']/iu,
      );
    }
  });

  test("non-config-reference docs do not advertise retired plugin entry fields", () => {
    const retiredEntryField =
      /plugins\.plugins[^\n`|]*\.(?:source|version|required|options)\b/u;
    const violations = markdownFiles(docsRoot)
      .filter((path) => relative(docsRoot, path) !== "reference/config.md")
      .filter((path) => retiredEntryField.test(readFileSync(path, "utf8")))
      .map((path) => relative(docsRoot, path));

    expect(violations).toEqual([]);
  });

  test("marketplace runtime has no TOML marketplace authority", () => {
    const migrationOnly = new Set([
      "config/retired-field-manifest.ts",
      "config/migration.ts",
      "config/schema.ts",
      "config/strict-schema.ts",
    ]);
    const violations = sourceFiles(sourceRoot)
      .filter((path) => /\bextraKnownMarketplaces\b/u.test(readFileSync(path, "utf8")))
      .map((path) => relative(sourceRoot, path))
      .filter((path) => !migrationOnly.has(path));

    expect(violations).toEqual([]);
    const inventory = source("plugins/marketplace/inventory.ts");
    const operations = source("plugins/marketplace/marketplace.ts");
    expect(inventory).not.toMatch(
      /getDeclaredMarketplaces|saveMarketplaceToSettings|gitPull|gitClone|refreshMarketplace|addMarketplaceSource/u,
    );
    expect(inventory).toContain("KnownMarketplacesFileSchema");
    expect(inventory).toContain("duplicateJsonObjectPaths");
    expect(inventory).toContain("lockfile.lock");
    expect(inventory).toContain("writeDurableAtomicFile");
    expect(inventory).toContain("updateMarketplaceInventory");
    expect(inventory).not.toMatch(/process\.env|memoize\(/u);
    expect(operations).toContain("updateMarketplaceInventory(");
    expect(operations).toContain(
      'MARKETPLACE_MANIFEST_RELATIVE_PATH = ".agenc-plugin/marketplace.json"',
    );
    expect(operations).not.toMatch(
      /process\.env|writeMarketplaceIndex|getPluginById\b|source:\s*["']settings["']/u,
    );
    const operationalOwners = sourceFiles(sourceRoot)
      .filter((path) =>
        /export async function (?:add|remove|upgrade)MarketplaceOp\b/u.test(
          readFileSync(path, "utf8"),
        ))
      .map((path) => relative(sourceRoot, path).replaceAll("\\", "/"));
    expect(operationalOwners).toEqual([
      "plugins/marketplace/marketplace.ts",
    ]);
    expect(
      sourceFiles(sourceRoot).map((path) => relative(sourceRoot, path)),
    ).not.toContain("utils/plugins/marketplaceManager.ts");
    expect(source("utils/plugins/schemas.ts")).not.toMatch(
      /KnownMarketplaceSchema|KnownMarketplacesFileSchema/u,
    );
  });
});
