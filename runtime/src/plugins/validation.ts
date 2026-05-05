import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  findPluginManifestPath,
  isRecord,
  loadPluginManifest,
  normalizePluginManifest,
  PLUGIN_MANIFEST_DIR,
  PLUGIN_MANIFEST_FILE,
  PluginManifestError,
} from "./manifest.js";

export interface ValidationError {
  readonly path: string;
  readonly message: string;
  readonly code?: string;
}

export interface ValidationWarning {
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly success: boolean;
  readonly errors: readonly ValidationError[];
  readonly warnings: readonly ValidationWarning[];
  readonly filePath: string;
  readonly fileType: "plugin" | "marketplace" | "skill" | "agent" | "command" | "hooks";
}

const MARKETPLACE_ONLY_MANIFEST_FIELDS = new Set([
  "category",
  "source",
  "tags",
  "strict",
  "id",
]);

function errno(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function detectManifestType(filePath: string): "plugin" | "marketplace" | "unknown" {
  const fileName = basename(filePath);
  const dirName = basename(dirname(filePath));
  if (fileName === PLUGIN_MANIFEST_FILE) return "plugin";
  if (fileName === "marketplace.json") return "marketplace";
  if (dirName === PLUGIN_MANIFEST_DIR) return "plugin";
  return "unknown";
}

function pluginRootForManifestPath(filePath: string): string {
  return basename(dirname(filePath)) === PLUGIN_MANIFEST_DIR
    ? dirname(dirname(filePath))
    : dirname(filePath);
}

function checkPathTraversal(
  value: string,
  field: string,
  errors: ValidationError[],
  hint?: string,
): void {
  if (value.includes("..")) {
    errors.push({
      path: field,
      message: hint
        ? `Path contains "..": ${value}. ${hint}`
        : `Path contains ".." which could escape the plugin root: ${value}`,
    });
  }
}

export async function validatePluginManifest(
  filePath: string,
): Promise<ValidationResult> {
  const absolutePath = resolve(filePath);
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    const code = errno(error);
    return {
      success: false,
      errors: [{
        path: code ? "file" : "json",
        message: code
          ? code === "ENOENT"
            ? `File not found: ${absolutePath}`
            : `Failed to read file: ${errorMessage(error)}`
          : `Invalid JSON syntax: ${errorMessage(error)}`,
        ...(code ? { code } : {}),
      }],
      warnings,
      filePath: absolutePath,
      fileType: "plugin",
    };
  }

  if (isRecord(parsed)) {
    for (const key of ["commands", "agents", "skills"] as const) {
      const value = parsed[key];
      const entries = Array.isArray(value) ? value : [value];
      for (const [index, entry] of entries.entries()) {
        if (typeof entry === "string") {
          checkPathTraversal(entry, `${key}[${index}]`, errors);
        }
      }
    }
    for (const key of Object.keys(parsed)) {
      if (MARKETPLACE_ONLY_MANIFEST_FIELDS.has(key)) {
        warnings.push({
          path: key,
          message: `Field '${key}' belongs in a marketplace entry, not plugin.json.`,
        });
      }
    }
  }

  try {
    normalizePluginManifest(parsed, pluginRootForManifestPath(absolutePath));
  } catch (error) {
    if (error instanceof PluginManifestError) {
      errors.push(...error.issues);
    } else {
      errors.push({ path: "manifest", message: errorMessage(error) });
    }
  }

  return {
    success: errors.length === 0,
    errors,
    warnings,
    filePath: absolutePath,
    fileType: "plugin",
  };
}

export async function validateMarketplaceManifest(
  filePath: string,
): Promise<ValidationResult> {
  const absolutePath = resolve(filePath);
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    const code = errno(error);
    return {
      success: false,
      errors: [{
        path: code ? "file" : "json",
        message: code
          ? code === "ENOENT"
            ? `File not found: ${absolutePath}`
            : `Failed to read file: ${errorMessage(error)}`
          : `Invalid JSON syntax: ${errorMessage(error)}`,
        ...(code ? { code } : {}),
      }],
      warnings,
      filePath: absolutePath,
      fileType: "marketplace",
    };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) {
    errors.push({ path: "plugins", message: "Marketplace must define a plugins array" });
  } else {
    const seen = new Set<string>();
    for (const [index, plugin] of parsed.plugins.entries()) {
      if (!isRecord(plugin) || typeof plugin.name !== "string") {
        errors.push({
          path: `plugins[${index}]`,
          message: "Marketplace plugin entries require a name",
        });
        continue;
      }
      if (seen.has(plugin.name)) {
        errors.push({
          path: `plugins[${index}].name`,
          message: `Duplicate plugin name "${plugin.name}"`,
        });
      }
      seen.add(plugin.name);
      if (typeof plugin.source === "string") {
        checkPathTraversal(plugin.source, `plugins[${index}].source`, errors);
      }
    }
  }
  if (isRecord(parsed) && !isRecord(parsed.metadata)) {
    warnings.push({
      path: "metadata",
      message: "Marketplace metadata is optional but recommended for discovery.",
    });
  }
  return {
    success: errors.length === 0,
    errors,
    warnings,
    filePath: absolutePath,
    fileType: "marketplace",
  };
}

export async function validateManifest(filePath: string): Promise<ValidationResult> {
  const absolutePath = resolve(filePath);
  let stats;
  try {
    stats = await stat(absolutePath);
  } catch (error) {
    return {
      success: false,
      errors: [{
        path: "file",
        message: `File not found: ${absolutePath}`,
        ...(errno(error) ? { code: errno(error) } : {}),
      }],
      warnings: [],
      filePath: absolutePath,
      fileType: "plugin",
    };
  }
  if (stats.isDirectory()) {
    const marketplacePath = join(absolutePath, PLUGIN_MANIFEST_DIR, "marketplace.json");
    const marketplace = await validateMarketplaceManifest(marketplacePath);
    if (marketplace.errors[0]?.code !== "ENOENT") return marketplace;
    const manifestPath = await findPluginManifestPath(absolutePath);
    return validatePluginManifest(
      manifestPath ?? join(absolutePath, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE),
    );
  }
  switch (detectManifestType(filePath)) {
    case "marketplace":
      return validateMarketplaceManifest(filePath);
    case "plugin":
    case "unknown":
      return validatePluginManifest(filePath);
  }
}

export async function validatePluginContents(
  pluginDir: string,
): Promise<readonly ValidationResult[]> {
  const parsed = await loadPluginManifest(pluginDir).catch(() => null);
  if (!parsed) return [];
  const results: ValidationResult[] = [];
  for (const [fileType, dir] of [
    ["skill", "skills"],
    ["agent", "agents"],
    ["command", "commands"],
  ] as const) {
    for (const filePath of await collectMarkdown(join(pluginDir, dir), fileType === "skill")) {
      const raw = await readFile(filePath, "utf8").catch(() => null);
      if (raw === null) continue;
      const result = validateMarkdownComponent(filePath, raw, fileType);
      if (result.errors.length > 0 || result.warnings.length > 0) {
        results.push(result);
      }
    }
  }
  return results;
}

async function collectMarkdown(dir: string, skillsDir: boolean): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  if (skillsDir) {
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name, "SKILL.md"));
  }
  const out: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectMarkdown(fullPath, false)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(fullPath);
    }
  }
  return out;
}

function validateMarkdownComponent(
  filePath: string,
  raw: string,
  fileType: "skill" | "agent" | "command",
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  if (!raw.startsWith("---")) {
    warnings.push({
      path: "frontmatter",
      message: "No frontmatter block found.",
    });
  }
  return {
    success: errors.length === 0,
    errors,
    warnings,
    filePath,
    fileType,
  };
}
