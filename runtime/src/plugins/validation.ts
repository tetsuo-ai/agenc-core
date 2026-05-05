import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import {
  findPluginManifestPath,
  isRecord,
  loadPluginManifest,
  normalizePluginManifest,
  PLUGIN_MANIFEST_DIR,
  PLUGIN_MANIFEST_FILE,
  PluginManifestError,
  readJsonText,
  resolveManifestRelativePath,
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
const MAX_VALIDATION_MARKDOWN_FILES = 512;
const MAX_VALIDATION_SCAN_DEPTH = 8;

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
  if (value.split(/[\\/]/u).includes("..")) {
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
    parsed = JSON.parse(await readJsonText(absolutePath));
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
    validateManifestPathFields(parsed, pluginRootForManifestPath(absolutePath), errors);
    await validateServerDeclarationFiles(parsed, pluginRootForManifestPath(absolutePath), errors);
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

function validateManifestPathFields(
  manifest: Readonly<Record<string, unknown>>,
  pluginRoot: string,
  errors: ValidationError[],
): void {
  for (const key of ["agents", "skills", "outputStyles", "apps", "hooks", "mcpServers", "lspServers"] as const) {
    validatePathDeclaration(manifest[key], key, pluginRoot, errors);
  }
  validateServerMapPaths(manifest.mcpServers, "mcpServers", pluginRoot, errors);
  validateServerMapPaths(manifest.lspServers, "lspServers", pluginRoot, errors);
  const commands = manifest.commands;
  if (typeof commands === "string" || Array.isArray(commands)) {
    validatePathDeclaration(commands, "commands", pluginRoot, errors);
  } else if (isRecord(commands)) {
    for (const [name, metadata] of Object.entries(commands)) {
      if (isRecord(metadata) && typeof metadata.source === "string") {
        validateManifestPath(metadata.source, `commands.${name}.source`, pluginRoot, errors);
      }
    }
  }
}

async function validateServerDeclarationFiles(
  manifest: Readonly<Record<string, unknown>>,
  pluginRoot: string,
  errors: ValidationError[],
): Promise<void> {
  await validateServerFilesForKey(manifest.mcpServers, "mcpServers", pluginRoot, errors);
  await validateServerFilesForKey(manifest.lspServers, "lspServers", pluginRoot, errors);
}

async function validateServerFilesForKey(
  value: unknown,
  wrapperKey: "mcpServers" | "lspServers",
  pluginRoot: string,
  errors: ValidationError[],
): Promise<void> {
  const paths = typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  for (const [index, entry] of paths.entries()) {
    let resolved: string;
    const field = paths.length === 1 ? wrapperKey : `${wrapperKey}[${index}]`;
    try {
      resolved = resolveManifestRelativePath(pluginRoot, field, entry);
    } catch {
      continue;
    }
    const parsed = await readJsonFile(resolved, field, errors);
    const map = isRecord(parsed) && isRecord(parsed[wrapperKey])
      ? parsed[wrapperKey]
      : parsed;
    validateServerMapPaths(map, wrapperKey, pluginRoot, errors);
  }
}

async function readJsonFile(
  filePath: string,
  field: string,
  errors: ValidationError[],
): Promise<unknown> {
  try {
    return JSON.parse(await readJsonText(filePath));
  } catch (error) {
    errors.push({
      path: field,
      message: `Failed to read server config: ${errorMessage(error)}`,
    });
    return undefined;
  }
}

function validateServerMapPaths(
  value: unknown,
  wrapperKey: "mcpServers" | "lspServers",
  pluginRoot: string,
  errors: ValidationError[],
): void {
  if (!isRecord(value)) return;
  const fieldName = wrapperKey === "mcpServers" ? "cwd" : "workspaceFolder";
  for (const [name, server] of Object.entries(value)) {
    if (!isRecord(server)) continue;
    const pathValue = server[fieldName];
    if (typeof pathValue !== "string") continue;
    validateServerWorkingDir(pathValue, `${wrapperKey}.${name}.${fieldName}`, pluginRoot, errors);
  }
}

function validateServerWorkingDir(
  value: string,
  field: string,
  pluginRoot: string,
  errors: ValidationError[],
): void {
  if (value === "." || value === "./") return;
  if (isAbsolute(value)) {
    errors.push({ path: field, message: "Path must be relative to the plugin root." });
    return;
  }
  const relativeValue = value.startsWith("./") ? value : `./${value}`;
  validateManifestPath(relativeValue, field, pluginRoot, errors);
}

function validatePathDeclaration(
  value: unknown,
  field: string,
  pluginRoot: string,
  errors: ValidationError[],
): void {
  if (typeof value === "string") {
    validateManifestPath(value, field, pluginRoot, errors);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      if (typeof entry === "string") {
        validateManifestPath(entry, `${field}[${index}]`, pluginRoot, errors);
      }
    }
  }
}

function validateManifestPath(
  value: string,
  field: string,
  pluginRoot: string,
  errors: ValidationError[],
): void {
  checkPathTraversal(value, field, errors);
  try {
    resolveManifestRelativePath(pluginRoot, field, value);
  } catch (error) {
    errors.push({
      path: field,
      message: errorMessage(error),
    });
  }
}

export async function validateMarketplaceManifest(
  filePath: string,
): Promise<ValidationResult> {
  const absolutePath = resolve(filePath);
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readJsonText(absolutePath));
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
  const out: string[] = [];
  const queue: Array<{ readonly path: string; readonly depth: number }> = [
    { path: dir, depth: 0 },
  ];
  const visited = new Set<string>();
  while (queue.length > 0) {
    if (out.length >= MAX_VALIDATION_MARKDOWN_FILES) break;
    const current = queue.shift()!;
    if (current.depth > MAX_VALIDATION_SCAN_DEPTH) continue;
    let identity = current.path;
    try {
      identity = await realpath(current.path);
    } catch {
      // Keep walking best-effort if a path disappears during validation.
    }
    if (visited.has(identity)) continue;
    visited.add(identity);
    const currentEntries = await readdir(current.path, { withFileTypes: true }).catch(() => []);
    for (const entry of currentEntries) {
      if (out.length >= MAX_VALIDATION_MARKDOWN_FILES) break;
      const fullPath = join(current.path, entry.name);
      if (entry.isDirectory()) {
        queue.push({ path: fullPath, depth: current.depth + 1 });
      } else if (
        entry.isFile() &&
        (skillsDir
          ? entry.name === "SKILL.md"
          : entry.name.toLowerCase().endsWith(".md"))
      ) {
        out.push(fullPath);
      }
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
  const frontmatter = readMarkdownFrontmatter(raw, errors);
  if (frontmatter === undefined) {
    warnings.push({
      path: "frontmatter",
      message: "No frontmatter block found.",
    });
  } else {
    validateFrontmatterShape(frontmatter, fileType, errors, warnings);
  }
  return {
    success: errors.length === 0,
    errors,
    warnings,
    filePath,
    fileType,
  };
}

function readMarkdownFrontmatter(
  raw: string,
  errors: ValidationError[],
): Readonly<Record<string, unknown>> | undefined {
  if (!raw.startsWith("---")) return undefined;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) {
    errors.push({
      path: "frontmatter",
      message: "Frontmatter block is not closed.",
    });
    return undefined;
  }
  try {
    const parsed = loadYaml(raw.slice(3, end).trim()) ?? {};
    if (!isRecord(parsed)) {
      errors.push({
        path: "frontmatter",
        message: "Frontmatter must be an object.",
      });
      return undefined;
    }
    return parsed;
  } catch (error) {
    errors.push({
      path: "frontmatter",
      message: `Invalid frontmatter syntax: ${errorMessage(error)}`,
    });
    return undefined;
  }
}

function validateFrontmatterShape(
  frontmatter: Readonly<Record<string, unknown>>,
  fileType: "skill" | "agent" | "command",
  errors: ValidationError[],
  warnings: ValidationWarning[],
): void {
  for (const [key, value] of Object.entries(frontmatter)) {
    switch (key) {
      case "name":
      case "description":
      case "argument-hint":
      case "argumentHint":
      case "when_to_use":
      case "whenToUse":
      case "version":
      case "model":
      case "context":
      case "agent":
      case "effort":
      case "shell":
      case "system-prompt":
      case "systemPrompt":
        validateStringField(key, value, errors);
        break;
      case "allowed-tools":
      case "allowedTools":
      case "tools":
      case "paths":
        validateStringListField(key, value, errors);
        break;
      case "arguments":
        validateArgumentsField(value, errors);
        break;
      case "disable-model-invocation":
      case "disableModelInvocation":
      case "user-invocable":
      case "userInvocable":
        if (typeof value !== "boolean") {
          errors.push({ path: key, message: "Expected boolean value." });
        }
        break;
      case "hooks":
        if (!isRecord(value)) {
          errors.push({ path: key, message: "Expected hooks object." });
        }
        break;
      default:
        warnings.push({
          path: key,
          message: `Unknown ${fileType} frontmatter field.`,
        });
    }
  }
  if (fileType === "skill" && typeof frontmatter.description !== "string") {
    errors.push({
      path: "description",
      message: "Skill frontmatter requires a description string.",
    });
  }
}

function validateStringField(
  key: string,
  value: unknown,
  errors: ValidationError[],
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push({ path: key, message: "Expected non-empty string." });
  }
}

function validateStringListField(
  key: string,
  value: unknown,
  errors: ValidationError[],
): void {
  if (typeof value === "string") return;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return;
  errors.push({ path: key, message: "Expected string or string array." });
}

function validateArgumentsField(
  value: unknown,
  errors: ValidationError[],
): void {
  if (typeof value === "string") return;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return;
  errors.push({ path: "arguments", message: "Expected string or string array." });
}
