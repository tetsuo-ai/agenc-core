import { access, readFile, stat } from "node:fs/promises";
import {
  basename,
  isAbsolute,
  join,
  normalize,
  resolve,
  sep,
} from "node:path";

export const PLUGIN_MANIFEST_DIR = ".agenc-plugin";
export const PLUGIN_MANIFEST_FILE = "plugin.json";
export const PLUGIN_MANIFEST_RELATIVE_PATH = `${PLUGIN_MANIFEST_DIR}/${PLUGIN_MANIFEST_FILE}`;
export const ROOT_PLUGIN_MANIFEST_RELATIVE_PATH = PLUGIN_MANIFEST_FILE;
export const MAX_DEFAULT_PROMPT_COUNT = 3;
export const MAX_DEFAULT_PROMPT_LENGTH = 128;
export const MAX_PLUGIN_JSON_BYTES = 1_048_576;

export type PluginComponentKind =
  | "commands"
  | "agents"
  | "skills"
  | "hooks"
  | "mcp"
  | "lsp"
  | "apps"
  | "output-styles";

export type PluginPathDeclaration = string | readonly string[];

export interface PluginAuthor {
  readonly name: string;
  readonly email?: string;
  readonly url?: string;
}

export interface PluginCommandMetadata {
  readonly source?: string;
  readonly content?: string;
  readonly description?: string;
  readonly argumentHint?: string;
  readonly model?: string;
  readonly allowedTools?: readonly string[];
}

export type PluginCommandDeclaration =
  | PluginPathDeclaration
  | Readonly<Record<string, PluginCommandMetadata>>;

export type PluginHookDeclaration =
  | string
  | readonly string[]
  | Record<string, unknown>
  | readonly Record<string, unknown>[];

export type PluginServerDeclaration =
  | string
  | readonly (string | Readonly<Record<string, unknown>>)[]
  | Readonly<Record<string, unknown>>;

export interface PluginManifestInterface {
  readonly displayName?: string;
  readonly shortDescription?: string;
  readonly longDescription?: string;
  readonly developerName?: string;
  readonly category?: string;
  readonly capabilities: readonly string[];
  readonly websiteUrl?: string;
  readonly privacyPolicyUrl?: string;
  readonly termsOfServiceUrl?: string;
  readonly defaultPrompt?: readonly string[];
  readonly brandColor?: string;
  readonly composerIcon?: string;
  readonly logo?: string;
  readonly screenshots: readonly string[];
}

export interface PluginManifest {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly author?: PluginAuthor;
  readonly homepage?: string;
  readonly repository?: string;
  readonly license?: string;
  readonly keywords?: readonly string[];
  readonly dependencies?: readonly string[];
  readonly commands?: PluginCommandDeclaration;
  readonly agents?: PluginPathDeclaration;
  readonly skills?: PluginPathDeclaration;
  readonly outputStyles?: PluginPathDeclaration;
  readonly apps?: PluginPathDeclaration;
  readonly hooks?: PluginHookDeclaration;
  readonly mcpServers?: PluginServerDeclaration;
  readonly lspServers?: PluginServerDeclaration;
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly userConfig?: Readonly<Record<string, unknown>>;
  readonly interface?: PluginManifestInterface;
}

export interface ParsedPluginManifest {
  readonly manifest: PluginManifest;
  readonly manifestPath: string;
}

export interface ManifestIssue {
  readonly path: string;
  readonly message: string;
}

export class PluginManifestError extends Error {
  constructor(
    message: string,
    readonly issues: readonly ManifestIssue[] = [],
  ) {
    super(message);
    this.name = "PluginManifestError";
  }
}

export async function findPluginManifestPath(
  pluginRoot: string,
): Promise<string | null> {
  for (const relativePath of [
    PLUGIN_MANIFEST_RELATIVE_PATH,
    ROOT_PLUGIN_MANIFEST_RELATIVE_PATH,
  ]) {
    const candidate = join(pluginRoot, relativePath);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next supported location.
    }
  }
  return null;
}

export async function loadPluginManifest(
  pluginRoot: string,
  fallbackName = basename(pluginRoot),
): Promise<ParsedPluginManifest | null> {
  const manifestPath = await findPluginManifestPath(pluginRoot);
  if (!manifestPath) return null;
  const raw = await readJsonText(manifestPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PluginManifestError(
      `Plugin manifest has invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      [{ path: "json", message: "Invalid JSON syntax" }],
    );
  }
  return {
    manifest: normalizePluginManifest(parsed, pluginRoot, fallbackName),
    manifestPath,
  };
}

export function normalizePluginManifest(
  value: unknown,
  pluginRoot: string,
  fallbackName = basename(pluginRoot),
): PluginManifest {
  if (!isRecord(value)) {
    throw new PluginManifestError("Plugin manifest must be a JSON object", [
      { path: "root", message: "Expected object" },
    ]);
  }
  const issues: ManifestIssue[] = [];
  validateManifestFieldTypes(value, issues);
  const name = optionalString(value.name)?.trim() || fallbackName;
  if (name.trim().length === 0) {
    issues.push({ path: "name", message: "Plugin name cannot be empty" });
  }

  const manifest: PluginManifest = {
    name,
    ...optionalStringProperty(value, "version", (version) => {
      const trimmed = version.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }),
    ...optionalStringProperty(value, "description"),
    ...optionalAuthor(value.author, issues),
    ...optionalStringProperty(value, "homepage"),
    ...optionalStringProperty(value, "repository"),
    ...optionalStringProperty(value, "license"),
    ...optionalStringArrayProperty(value, "keywords"),
    ...normalizeDependencies(value.dependencies, issues),
    ...normalizeCommandDeclaration(value.commands, issues),
    ...normalizePathDeclarationProperty("agents", value.agents, issues),
    ...normalizePathDeclarationProperty("skills", value.skills, issues),
    ...normalizePathDeclarationProperty("outputStyles", value.outputStyles, issues),
    ...normalizePathDeclarationProperty("apps", value.apps, issues),
    ...normalizeHooks(value.hooks, issues),
    ...normalizeServerDeclaration("mcpServers", value.mcpServers, issues),
    ...normalizeServerDeclaration("lspServers", value.lspServers, issues),
    ...optionalRecordProperty(value, "settings"),
    ...optionalRecordProperty(value, "userConfig"),
    ...normalizeInterface(pluginRoot, value.interface, issues),
  };

  if (issues.length > 0) {
    throw new PluginManifestError("Plugin manifest failed validation", issues);
  }
  return manifest;
}

export function resolveManifestRelativePath(
  pluginRoot: string,
  field: string,
  value: string,
): string {
  if (value.length === 0) {
    throw new PluginManifestError(`${field} path must not be empty`, [
      { path: field, message: "Path must not be empty" },
    ]);
  }
  if (!value.startsWith("./")) {
    throw new PluginManifestError(`${field} path must start with ./`, [
      { path: field, message: "Path must start with ./" },
    ]);
  }
  const relativePath = value.slice(2);
  if (relativePath.length === 0) {
    throw new PluginManifestError(`${field} path must not be ./`, [
      { path: field, message: "Path must not be ./" },
    ]);
  }
  const rawParts = relativePath.split(/[\\/]/u);
  if (
    rawParts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new PluginManifestError(`${field} path must be normalized`, [
      { path: field, message: "Path must not contain empty, ., or .. segments" },
    ]);
  }
  const normalized = normalize(relativePath);
  const parts = normalized.split(/[\\/]/u);
  if (
    isAbsolute(normalized) ||
    parts.includes("..") ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`)
  ) {
    throw new PluginManifestError(`${field} path escapes the plugin root`, [
      { path: field, message: "Path must stay inside the plugin root" },
    ]);
  }
  const resolved = resolve(pluginRoot, normalized);
  const root = resolve(pluginRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new PluginManifestError(`${field} path escapes the plugin root`, [
      { path: field, message: "Path must stay inside the plugin root" },
    ]);
  }
  return resolved;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJsonText(path: string): Promise<string> {
  const stats = await stat(path);
  if (stats.size > MAX_PLUGIN_JSON_BYTES) {
    throw new PluginManifestError("Plugin JSON file is too large", [
      { path, message: `JSON files must be at most ${MAX_PLUGIN_JSON_BYTES} bytes` },
    ]);
  }
  return readFile(path, "utf8");
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalStringProperty(
  record: Record<string, unknown>,
  key: string,
  transform: (value: string) => string | undefined = (value) => value,
): Record<string, string> {
  const value = optionalString(record[key]);
  if (value === undefined) return {};
  const transformed = transform(value);
  return transformed === undefined ? {} : { [key]: transformed };
}

function optionalStringArrayProperty(
  record: Record<string, unknown>,
  key: string,
): Record<string, readonly string[]> {
  const value = record[key];
  if (!Array.isArray(value)) return {};
  const out = value.filter((entry): entry is string => typeof entry === "string");
  return out.length > 0 ? { [key]: out } : {};
}

function optionalRecordProperty(
  record: Record<string, unknown>,
  key: string,
): Record<string, Readonly<Record<string, unknown>>> {
  const value = record[key];
  return isRecord(value) ? { [key]: cloneNullProtoRecord(value) } : {};
}

function optionalAuthor(
  value: unknown,
  issues: ManifestIssue[],
): { author?: PluginAuthor } {
  if (value === undefined) return {};
  if (!isRecord(value) || typeof value.name !== "string" || value.name.trim().length === 0) {
    issues.push({ path: "author", message: "Author must include a non-empty name" });
    return {};
  }
  return {
    author: {
      name: value.name,
      ...optionalStringProperty(value, "email"),
      ...optionalStringProperty(value, "url"),
    },
  };
}

function normalizePathDeclarationProperty(
  key: "agents" | "skills" | "outputStyles" | "apps",
  value: unknown,
  issues: ManifestIssue[],
): Record<string, PluginPathDeclaration> {
  if (value === undefined) return {};
  if (typeof value === "string") return { [key]: value };
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return { [key]: value };
  }
  issues.push({ path: key, message: "Expected path string or path array" });
  return {};
}

function normalizeCommandDeclaration(
  value: unknown,
  issues: ManifestIssue[],
): { commands?: PluginCommandDeclaration } {
  if (value === undefined) return {};
  if (typeof value === "string") return { commands: value };
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return { commands: value };
  }
  if (isRecord(value)) {
    const out = nullProtoRecord<PluginCommandMetadata>();
    for (const [name, metadata] of Object.entries(value)) {
      if (isUnsafeObjectKey(name)) {
        issues.push({ path: `commands.${name}`, message: "Unsafe command name" });
        continue;
      }
      if (!isRecord(metadata)) {
        issues.push({ path: `commands.${name}`, message: "Expected command metadata object" });
        continue;
      }
      const command: PluginCommandMetadata = {
        ...optionalStringProperty(metadata, "source"),
        ...optionalStringProperty(metadata, "content"),
        ...optionalStringProperty(metadata, "description"),
        ...optionalStringProperty(metadata, "argumentHint"),
        ...optionalStringProperty(metadata, "model"),
        ...optionalStringArrayProperty(metadata, "allowedTools"),
      };
      if (command.source === undefined && command.content === undefined) {
        issues.push({
          path: `commands.${name}`,
          message: "Command metadata requires source or content",
        });
        continue;
      }
      if (command.source !== undefined && command.content !== undefined) {
        issues.push({
          path: `commands.${name}`,
          message: "Command metadata cannot have both source and content",
        });
        continue;
      }
      out[name] = command;
    }
    return { commands: out };
  }
  issues.push({ path: "commands", message: "Expected path, path array, or command map" });
  return {};
}

function validateManifestFieldTypes(
  record: Record<string, unknown>,
  issues: ManifestIssue[],
): void {
  for (const key of ["version", "description", "homepage", "repository", "license"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "string") {
      issues.push({ path: key, message: "Expected string" });
    }
  }
  for (const key of ["keywords"] as const) {
    if (record[key] !== undefined && (
      !Array.isArray(record[key]) ||
      !(record[key] as unknown[]).every((entry) => typeof entry === "string")
    )) {
      issues.push({ path: key, message: "Expected string array" });
    }
  }
  for (const key of ["settings", "userConfig"] as const) {
    const value = record[key];
    if (value !== undefined && !isRecord(value)) {
      issues.push({ path: key, message: "Expected object" });
    } else if (isRecord(value) && hasUnsafeObjectKey(value)) {
      issues.push({ path: key, message: "Object contains unsafe key" });
    }
  }
  if (isRecord(record.interface)) {
    const capabilities = record.interface.capabilities;
    if (
      capabilities !== undefined &&
      (!Array.isArray(capabilities) ||
        !capabilities.every((entry) => typeof entry === "string"))
    ) {
      issues.push({ path: "interface.capabilities", message: "Expected string array" });
    }
  }
}

function cloneNullProtoRecord(
  record: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const out = nullProtoRecord<unknown>();
  for (const [key, value] of Object.entries(record)) {
    if (isUnsafeObjectKey(key)) continue;
    out[key] = value;
  }
  return out;
}

function hasUnsafeObjectKey(record: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(record).some(isUnsafeObjectKey);
}

function nullProtoRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function isUnsafeObjectKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function normalizeHooks(
  value: unknown,
  issues: ManifestIssue[],
): { hooks?: PluginHookDeclaration } {
  if (value === undefined) return {};
  if (typeof value === "string") return { hooks: value };
  if (Array.isArray(value)) {
    if (
      value.every((entry) => typeof entry === "string") ||
      value.every(isRecord)
    ) {
      return { hooks: value as readonly string[] | readonly Record<string, unknown>[] };
    }
  }
  if (isRecord(value)) return { hooks: value };
  issues.push({
    path: "hooks",
    message: "Expected path string, path array, object, or object array",
  });
  return {};
}

function normalizeServerDeclaration(
  key: "mcpServers" | "lspServers",
  value: unknown,
  issues: ManifestIssue[],
): Record<string, PluginServerDeclaration> {
  if (value === undefined) return {};
  if (typeof value === "string") return { [key]: value };
  if (isRecord(value)) return { [key]: value };
  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" || isRecord(entry))
  ) {
    return { [key]: value };
  }
  issues.push({
    path: key,
    message: "Expected path string, object map, or mixed declaration array",
  });
  return {};
}

function normalizeDependencies(
  value: unknown,
  issues: ManifestIssue[],
): { dependencies?: readonly string[] } {
  if (value === undefined) return {};
  if (!Array.isArray(value)) {
    issues.push({ path: "dependencies", message: "Expected dependency array" });
    return {};
  }
  const dependencies = value
    .map((entry) => {
      if (typeof entry === "string") return entry.replace(/@\^[^@]*$/u, "");
      if (isRecord(entry) && typeof entry.name === "string") {
        return typeof entry.marketplace === "string"
          ? `${entry.name}@${entry.marketplace}`
          : entry.name;
      }
      issues.push({ path: "dependencies", message: "Invalid dependency entry" });
      return null;
    })
    .filter((entry): entry is string => entry !== null && entry.length > 0);
  return dependencies.length > 0 ? { dependencies } : {};
}

function normalizeInterface(
  pluginRoot: string,
  value: unknown,
  issues: ManifestIssue[],
): { interface?: PluginManifestInterface } {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    issues.push({ path: "interface", message: "Expected interface object" });
    return {};
  }
  const defaultPrompt = normalizeDefaultPrompt(value.defaultPrompt, issues);
  const screenshots = Array.isArray(value.screenshots)
    ? value.screenshots
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => safeResolveAsset(pluginRoot, "interface.screenshots", entry, issues))
        .filter((entry): entry is string => entry !== null)
    : [];
  const normalized: PluginManifestInterface = {
    ...optionalStringProperty(value, "displayName"),
    ...optionalStringProperty(value, "shortDescription"),
    ...optionalStringProperty(value, "longDescription"),
    ...optionalStringProperty(value, "developerName"),
    ...optionalStringProperty(value, "category"),
    capabilities: Array.isArray(value.capabilities)
      ? value.capabilities.filter((entry): entry is string => typeof entry === "string")
      : [],
    ...optionalStringProperty(value, "websiteUrl"),
    ...optionalStringProperty(value, "privacyPolicyUrl"),
    ...optionalStringProperty(value, "termsOfServiceUrl"),
    ...(defaultPrompt ? { defaultPrompt } : {}),
    ...optionalStringProperty(value, "brandColor"),
    ...assetProperty(pluginRoot, "composerIcon", value.composerIcon, issues),
    ...assetProperty(pluginRoot, "logo", value.logo, issues),
    screenshots,
  };
  const hasValue = Object.entries(normalized).some(([key, entry]) =>
    Array.isArray(entry) ? entry.length > 0 : key !== "screenshots" && entry !== undefined,
  );
  return hasValue ? { interface: normalized } : {};
}

function normalizeDefaultPrompt(
  value: unknown,
  issues: ManifestIssue[],
): readonly string[] | undefined {
  const raw = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
  if (raw === undefined) return undefined;
  const prompts: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (prompts.length >= MAX_DEFAULT_PROMPT_COUNT) break;
    if (typeof entry !== "string") {
      issues.push({
        path: `interface.defaultPrompt[${index}]`,
        message: "Default prompt must be a string",
      });
      continue;
    }
    const prompt = entry.split(/\s+/u).filter(Boolean).join(" ");
    if (prompt.length === 0) continue;
    if ([...prompt].length > MAX_DEFAULT_PROMPT_LENGTH) {
      issues.push({
        path: `interface.defaultPrompt[${index}]`,
        message: `Default prompt must be at most ${MAX_DEFAULT_PROMPT_LENGTH} characters`,
      });
      continue;
    }
    prompts.push(prompt);
  }
  return prompts.length > 0 ? prompts : undefined;
}

function assetProperty(
  pluginRoot: string,
  key: "composerIcon" | "logo",
  value: unknown,
  issues: ManifestIssue[],
): Record<string, string> {
  if (typeof value !== "string") return {};
  const resolved = safeResolveAsset(pluginRoot, `interface.${key}`, value, issues);
  return resolved === null ? {} : { [key]: resolved };
}

function safeResolveAsset(
  pluginRoot: string,
  field: string,
  value: string,
  issues: ManifestIssue[],
): string | null {
  try {
    return resolveManifestRelativePath(pluginRoot, field, value);
  } catch (error) {
    if (error instanceof PluginManifestError) {
      issues.push(...error.issues);
      return null;
    }
    throw error;
  }
}
