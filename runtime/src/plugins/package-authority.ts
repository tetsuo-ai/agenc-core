import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { PLUGIN_MANIFEST_RELATIVE_PATH } from "./manifest.js";

export const RETIRED_PLUGIN_MCP_FILE = ".mcp.json";
export const RETIRED_PLUGIN_SETTINGS_FILE = "settings.json";
export const CONVENTIONAL_HOOKS_FILE = "hooks/hooks.json";
export const CONVENTIONAL_LSP_FILE = ".lsp.json";
export const CONVENTIONAL_APP_FILE = ".app.json";

export interface PluginPackageDeclarations {
  readonly hooks?: unknown;
  readonly mcpServers?: unknown;
  readonly lspServers?: unknown;
  readonly apps?: unknown;
}

export interface PluginPackageAuthorityIssue {
  readonly path: string;
  readonly field: "hooks" | "mcpServers" | "lspServers" | "apps" | "settings";
  readonly message: string;
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function declarationReferencesFile(
  declaration: unknown,
  relativePath: string,
): boolean {
  const entries = Array.isArray(declaration) ? declaration : [declaration];
  return entries.some(
    (entry) =>
      typeof entry === "string" &&
      entry.replace(/^\.\//u, "") === relativePath,
  );
}

export async function inspectPluginPackageAuthority(
  pluginRoot: string,
  declarations: PluginPackageDeclarations,
): Promise<readonly PluginPackageAuthorityIssue[]> {
  const issues: PluginPackageAuthorityIssue[] = [];
  const retiredMcpPath = join(pluginRoot, RETIRED_PLUGIN_MCP_FILE);
  if (await pathEntryExists(retiredMcpPath)) {
    issues.push({
      path: retiredMcpPath,
      field: "mcpServers",
      message:
        `Retired plugin MCP file detected at ${retiredMcpPath}. Move its declarations into mcpServers in ${PLUGIN_MANIFEST_RELATIVE_PATH} and remove the file, or reinstall the plugin.`,
    });
  }

  const retiredSettingsPath = join(pluginRoot, RETIRED_PLUGIN_SETTINGS_FILE);
  if (await pathEntryExists(retiredSettingsPath)) {
    issues.push({
      path: retiredSettingsPath,
      field: "settings",
      message:
        `Retired plugin settings file detected at ${retiredSettingsPath}. Move package defaults into settings in ${PLUGIN_MANIFEST_RELATIVE_PATH} and remove the file, or reinstall the plugin.`,
    });
  }

  for (const [relativePath, declaration, field] of [
    [CONVENTIONAL_HOOKS_FILE, declarations.hooks, "hooks"],
    [CONVENTIONAL_LSP_FILE, declarations.lspServers, "lspServers"],
    [CONVENTIONAL_APP_FILE, declarations.apps, "apps"],
  ] as const) {
    const conventionalPath = join(pluginRoot, relativePath);
    if (!(await pathEntryExists(conventionalPath))) continue;
    if (declarationReferencesFile(declaration, relativePath)) continue;
    issues.push({
      path: conventionalPath,
      field,
      message:
        `Implicit plugin configuration at ${conventionalPath} is retired. Declare it explicitly as ${field} = ${JSON.stringify(`./${relativePath}`)} in ${PLUGIN_MANIFEST_RELATIVE_PATH}, or remove the file.`,
    });
  }
  return issues;
}
