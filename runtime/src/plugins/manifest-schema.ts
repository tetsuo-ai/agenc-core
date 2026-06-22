import { basename, isAbsolute, normalize, resolve, sep } from "node:path";
import { validateHooksConfig } from "../config/schema.js";
import { isRecord } from "../utils/record.js";

export { isRecord };

const MAX_DEFAULT_PROMPT_COUNT = 3;
const MAX_DEFAULT_PROMPT_LENGTH = 128;

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
  | readonly (string | Readonly<Record<string, unknown>>)[]
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

export type PluginUserConfigOptionType =
  | "string"
  | "number"
  | "boolean"
  | "directory"
  | "file";

export interface PluginUserConfigOption {
  readonly type: PluginUserConfigOptionType;
  readonly title: string;
  readonly description: string;
  readonly required?: boolean;
  readonly default?: string | number | boolean | readonly string[];
  readonly multiple?: boolean;
  readonly sensitive?: boolean;
  readonly min?: number;
  readonly max?: number;
}

export interface PluginManifestChannel {
  readonly server: string;
  readonly displayName?: string;
  readonly userConfig?: Readonly<Record<string, PluginUserConfigOption>>;
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
  readonly channels?: readonly PluginManifestChannel[];
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly userConfig?: Readonly<Record<string, PluginUserConfigOption>>;
  readonly interface?: PluginManifestInterface;
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
  const name = normalizeManifestName(value.name, fallbackName, issues);

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
    ...normalizeCommandDeclaration(pluginRoot, value.commands, issues),
    ...normalizePathDeclarationProperty("agents", pluginRoot, value.agents, issues, [".md"]),
    ...normalizePathDeclarationProperty("skills", pluginRoot, value.skills, issues),
    ...normalizePathDeclarationProperty("outputStyles", pluginRoot, value.outputStyles, issues),
    ...normalizePathDeclarationProperty("apps", pluginRoot, value.apps, issues, [".json"]),
    ...normalizeHooks(pluginRoot, value.hooks, issues),
    ...normalizeServerDeclaration("mcpServers", pluginRoot, value.mcpServers, issues),
    ...normalizeServerDeclaration("lspServers", pluginRoot, value.lspServers, issues),
    ...normalizeChannels(value.channels, issues),
    ...optionalRecordProperty(value, "settings"),
    ...normalizeUserConfig(value.userConfig, "userConfig", issues),
    ...normalizeInterface(pluginRoot, value.interface, issues),
  };

  if (issues.length > 0) {
    throw new PluginManifestError("Plugin manifest failed validation", issues);
  }
  return manifest;
}

function normalizeManifestName(
  value: unknown,
  fallbackName: string,
  issues: ManifestIssue[],
): string {
  if (value === undefined) return fallbackName;
  if (typeof value !== "string") {
    issues.push({ path: "name", message: "Plugin name must be a string" });
    return fallbackName;
  }
  const name = value.trim();
  if (name.length === 0) {
    issues.push({ path: "name", message: "Plugin name cannot be empty" });
    return fallbackName;
  }
  if (name.includes(" ")) {
    issues.push({ path: "name", message: "Plugin name cannot contain spaces" });
  }
  return name;
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

function validateRelativeManifestPath(
  pluginRoot: string,
  field: string,
  value: string,
  issues: ManifestIssue[],
  allowedExtensions?: readonly string[],
): void {
  try {
    resolveManifestRelativePath(pluginRoot, field, value);
  } catch (error) {
    if (error instanceof PluginManifestError) {
      issues.push(...error.issues);
      return;
    }
    throw error;
  }
  if (
    allowedExtensions !== undefined &&
    !allowedExtensions.some((extension) => value.toLowerCase().endsWith(extension))
  ) {
    issues.push({
      path: field,
      message: `Path must end with ${allowedExtensions.join(" or ")}`,
    });
  }
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function optionalString(value: unknown): string | undefined {
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
  for (const key of ["email", "url"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      issues.push({ path: `author.${key}`, message: "Expected string" });
    }
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
  pluginRoot: string,
  value: unknown,
  issues: ManifestIssue[],
  allowedExtensions?: readonly string[],
): Record<string, PluginPathDeclaration> {
  if (value === undefined) return {};
  if (typeof value === "string") {
    validateRelativeManifestPath(pluginRoot, key, value, issues, allowedExtensions);
    return { [key]: value };
  }
  if (Array.isArray(value)) {
    const paths: string[] = [];
    for (const [index, entry] of value.entries()) {
      if (typeof entry !== "string") {
        issues.push({ path: `${key}[${index}]`, message: "Expected path string" });
        continue;
      }
      validateRelativeManifestPath(
        pluginRoot,
        `${key}[${index}]`,
        entry,
        issues,
        allowedExtensions,
      );
      paths.push(entry);
    }
    return paths.length > 0 ? { [key]: paths } : {};
  }
  issues.push({ path: key, message: "Expected path string or path array" });
  return {};
}

function normalizeCommandDeclaration(
  pluginRoot: string,
  value: unknown,
  issues: ManifestIssue[],
): { commands?: PluginCommandDeclaration } {
  if (value === undefined) return {};
  if (typeof value === "string") {
    validateRelativeManifestPath(pluginRoot, "commands", value, issues);
    return { commands: value };
  }
  if (Array.isArray(value)) {
    const paths: string[] = [];
    for (const [index, entry] of value.entries()) {
      if (typeof entry !== "string") {
        issues.push({ path: `commands[${index}]`, message: "Expected path string" });
        continue;
      }
      validateRelativeManifestPath(pluginRoot, `commands[${index}]`, entry, issues);
      paths.push(entry);
    }
    return paths.length > 0 ? { commands: paths } : {};
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
      validateCommandMetadataFieldTypes(metadata, `commands.${name}`, issues);
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
      if (command.source !== undefined) {
        validateRelativeManifestPath(
          pluginRoot,
          `commands.${name}.source`,
          command.source,
          issues,
        );
      }
      out[name] = command;
    }
    return { commands: out };
  }
  issues.push({ path: "commands", message: "Expected path, path array, or command map" });
  return {};
}

function validateCommandMetadataFieldTypes(
  metadata: Readonly<Record<string, unknown>>,
  field: string,
  issues: ManifestIssue[],
): void {
  for (const key of ["source", "content", "description", "argumentHint", "model"] as const) {
    if (metadata[key] !== undefined && typeof metadata[key] !== "string") {
      issues.push({ path: `${field}.${key}`, message: "Expected string" });
    }
  }
  if (
    metadata.allowedTools !== undefined &&
    (
      !Array.isArray(metadata.allowedTools) ||
      metadata.allowedTools.some((entry) => typeof entry !== "string")
    )
  ) {
    issues.push({ path: `${field}.allowedTools`, message: "Expected string array" });
  }
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
  if (typeof record.homepage === "string" && !isValidUrl(record.homepage)) {
    issues.push({ path: "homepage", message: "Homepage must be a URL" });
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
  if (record.channels !== undefined && !Array.isArray(record.channels)) {
    issues.push({ path: "channels", message: "Expected channel array" });
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
  pluginRoot: string,
  value: unknown,
  issues: ManifestIssue[],
): { hooks?: PluginHookDeclaration } {
  if (value === undefined) return {};
  if (typeof value === "string") {
    validateRelativeManifestPath(pluginRoot, "hooks", value, issues, [".json"]);
    return { hooks: value };
  }
  if (Array.isArray(value)) {
    const declarations: Array<string | Readonly<Record<string, unknown>>> = [];
    for (const [index, entry] of value.entries()) {
      if (typeof entry === "string") {
        validateRelativeManifestPath(
          pluginRoot,
          `hooks[${index}]`,
          entry,
          issues,
          [".json"],
        );
        declarations.push(entry);
      } else if (isRecord(entry)) {
        validateInlineHooks(entry, `hooks[${index}]`, issues);
        declarations.push(entry);
      } else {
        issues.push({
          path: `hooks[${index}]`,
          message: "Expected hooks path or hooks map",
        });
      }
    }
    return declarations.length > 0 ? { hooks: declarations } : {};
  }
  if (isRecord(value)) {
    validateInlineHooks(value, "hooks", issues);
    return { hooks: value };
  }
  issues.push({
    path: "hooks",
    message: "Expected path string, path array, object, or object array",
  });
  return {};
}

function normalizeServerDeclaration(
  key: "mcpServers" | "lspServers",
  pluginRoot: string,
  value: unknown,
  issues: ManifestIssue[],
): Record<string, PluginServerDeclaration> {
  if (value === undefined) return {};
  if (typeof value === "string") {
    validateRelativeManifestPath(pluginRoot, key, value, issues, [".json"]);
    return { [key]: value };
  }
  if (isRecord(value)) {
    return { [key]: normalizeServerMapDeclaration(key, pluginRoot, value, key, issues) };
  }
  if (Array.isArray(value)) {
    const declarations: Array<string | Readonly<Record<string, unknown>>> = [];
    for (const [index, entry] of value.entries()) {
      if (typeof entry === "string") {
        validateRelativeManifestPath(
          pluginRoot,
          `${key}[${index}]`,
          entry,
          issues,
          [".json"],
        );
        declarations.push(entry);
      } else if (isRecord(entry)) {
        declarations.push(
          normalizeServerMapDeclaration(key, pluginRoot, entry, `${key}[${index}]`, issues),
        );
      } else {
        issues.push({
          path: `${key}[${index}]`,
          message: "Expected path string or server map",
        });
      }
    }
    return declarations.length > 0 ? { [key]: declarations } : {};
  }
  issues.push({
    path: key,
    message: "Expected path string, object map, or mixed declaration array",
  });
  return {};
}

function normalizeServerMapDeclaration(
  key: "mcpServers" | "lspServers",
  pluginRoot: string,
  value: Readonly<Record<string, unknown>>,
  field: string,
  issues: ManifestIssue[],
): Readonly<Record<string, unknown>> {
  const out = nullProtoRecord<unknown>();
  for (const [name, server] of Object.entries(value)) {
    if (isUnsafeObjectKey(name)) {
      issues.push({ path: `${field}.${name}`, message: "Unsafe server key" });
      continue;
    }
    if (key === "mcpServers") {
      validateMcpServerConfig(server, `${field}.${name}`, pluginRoot, issues);
    } else {
      validateLspServerConfig(server, `${field}.${name}`, pluginRoot, issues);
    }
    out[name] = server;
  }
  return out;
}

function validateInlineHooks(
  value: Readonly<Record<string, unknown>>,
  field: string,
  issues: ManifestIssue[],
): void {
  const hooks = isRecord(value.hooks) ? value.hooks : value;
  try {
    validateHooksConfig(hooks);
  } catch (error) {
    issues.push({
      path: field,
      message: error instanceof Error ? error.message : "Invalid hooks map",
    });
  }
}

function validateMcpServerConfig(
  value: unknown,
  field: string,
  pluginRoot: string,
  issues: ManifestIssue[],
): void {
  if (!isRecord(value)) {
    issues.push({ path: field, message: "MCP server must be an object" });
    return;
  }
  const command = value.command;
  const endpoint = value.endpoint ?? value.url;
  const transport = value.transport ?? value.type;
  if (
    command !== undefined &&
    (typeof command !== "string" || command.trim().length === 0)
  ) {
    issues.push({ path: `${field}.command`, message: "Expected non-empty string" });
  }
  if (
    endpoint !== undefined &&
    (typeof endpoint !== "string" || endpoint.trim().length === 0)
  ) {
    issues.push({ path: `${field}.endpoint`, message: "Expected non-empty string" });
  }
  if (command === undefined && endpoint === undefined) {
    issues.push({ path: field, message: "MCP server requires command or endpoint" });
  }
  if (transport === "stdio" && command === undefined) {
    issues.push({ path: `${field}.command`, message: "MCP stdio server requires command" });
  }
  if (
    (transport === "http" ||
      transport === "sse" ||
      transport === "websocket" ||
      transport === "ws") &&
    endpoint === undefined
  ) {
    issues.push({ path: `${field}.endpoint`, message: "MCP remote server requires endpoint" });
  }
  validateOptionalStringArray(value.args, `${field}.args`, issues);
  validateOptionalStringRecord(value.env, `${field}.env`, issues);
  validateOptionalStringRecord(value.headers, `${field}.headers`, issues);
  if (value.cwd !== undefined && typeof value.cwd !== "string") {
    issues.push({ path: `${field}.cwd`, message: "Expected string" });
  } else if (typeof value.cwd === "string") {
    validateServerWorkingDir(pluginRoot, `${field}.cwd`, value.cwd, issues);
  }
  if (
    value.transport !== undefined &&
    value.transport !== "stdio" &&
    value.transport !== "sse" &&
    value.transport !== "http" &&
    value.transport !== "websocket" &&
    value.transport !== "ws"
  ) {
    issues.push({ path: `${field}.transport`, message: "Invalid MCP transport" });
  }
  if (
    value.type !== undefined &&
    value.type !== "stdio" &&
    value.type !== "sse" &&
    value.type !== "http" &&
    value.type !== "websocket" &&
    value.type !== "ws"
  ) {
    issues.push({ path: `${field}.type`, message: "Invalid MCP type" });
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    issues.push({ path: `${field}.enabled`, message: "Expected boolean" });
  }
  if (value.timeout !== undefined && typeof value.timeout !== "number") {
    issues.push({ path: `${field}.timeout`, message: "Expected number" });
  }
}

function validateLspServerConfig(
  value: unknown,
  field: string,
  pluginRoot: string,
  issues: ManifestIssue[],
): void {
  if (!isRecord(value)) {
    issues.push({ path: field, message: "LSP server must be an object" });
    return;
  }
  for (const key of Object.keys(value)) {
    if (!LSP_SERVER_KEYS.has(key)) {
      issues.push({ path: `${field}.${key}`, message: "Unsupported LSP field" });
    }
  }
  if (typeof value.command !== "string" || value.command.trim().length === 0) {
    issues.push({ path: `${field}.command`, message: "LSP server requires command" });
  } else if (value.command.includes(" ") && !value.command.startsWith("/")) {
    issues.push({
      path: `${field}.command`,
      message: "Command with spaces must use args",
    });
  }
  validateOptionalStringArray(value.args, `${field}.args`, issues);
  validateOptionalStringRecord(value.env, `${field}.env`, issues);
  if (value.workspaceFolder !== undefined && typeof value.workspaceFolder !== "string") {
    issues.push({ path: `${field}.workspaceFolder`, message: "Expected string" });
  } else if (typeof value.workspaceFolder === "string") {
    validateServerWorkingDir(
      pluginRoot,
      `${field}.workspaceFolder`,
      value.workspaceFolder,
      issues,
    );
  }
  validateLspExtensionMap(value.extensionToLanguage, `${field}.extensionToLanguage`, issues);
  validateOptionalPositiveInteger(value.startupTimeout, `${field}.startupTimeout`, issues);
  validateOptionalNonNegativeInteger(value.maxRestarts, `${field}.maxRestarts`, issues);
}

function validateServerWorkingDir(
  pluginRoot: string,
  field: string,
  value: string,
  issues: ManifestIssue[],
): void {
  if (value === "." || value === "./") return;
  if (isAbsolute(value)) {
    issues.push({ path: field, message: "Path must be relative to the plugin root" });
    return;
  }
  const relativeValue = value.startsWith("./") ? value : `./${value}`;
  validateRelativeManifestPath(pluginRoot, field, relativeValue, issues);
}

function validateOptionalStringArray(
  value: unknown,
  field: string,
  issues: ManifestIssue[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    issues.push({ path: field, message: "Expected string array" });
  }
}

function validateOptionalStringRecord(
  value: unknown,
  field: string,
  issues: ManifestIssue[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push({ path: field, message: "Expected string map" });
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (isUnsafeObjectKey(key)) {
      issues.push({ path: `${field}.${key}`, message: "Unsafe key" });
    } else if (typeof entry !== "string") {
      issues.push({ path: `${field}.${key}`, message: "Expected string" });
    }
  }
}

function validateLspExtensionMap(
  value: unknown,
  field: string,
  issues: ManifestIssue[],
): void {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    issues.push({ path: field, message: "Expected non-empty extension map" });
    return;
  }
  for (const [extension, language] of Object.entries(value)) {
    if (!extension.startsWith(".") || extension.length < 2) {
      issues.push({ path: `${field}.${extension}`, message: "Extension must start with dot" });
    }
    if (typeof language !== "string" || language.trim().length === 0) {
      issues.push({ path: `${field}.${extension}`, message: "Expected language string" });
    }
  }
}

function validateOptionalPositiveInteger(
  value: unknown,
  field: string,
  issues: ManifestIssue[],
): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    issues.push({ path: field, message: "Expected positive integer" });
  }
}

function validateOptionalNonNegativeInteger(
  value: unknown,
  field: string,
  issues: ManifestIssue[],
): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    issues.push({ path: field, message: "Expected non-negative integer" });
  }
}

const DEPENDENCY_REF_PATTERN =
  /^[a-z0-9][-a-z0-9._]*(?:@[a-z0-9][-a-z0-9._]*)?(?:@(?:\^|~|>=|<=|>|<|=)[0-9a-z][0-9a-z._+-]*)?$/iu;
const DEPENDENCY_NAME_PATTERN = /^[a-z0-9][-a-z0-9._]*$/iu;
const DEPENDENCY_VERSION_CONSTRAINT_PATTERN = /^(?:\^|~|>=|<=|>|<|=)[0-9a-z][0-9a-z._+-]*$/iu;
const LSP_SERVER_KEYS = new Set([
  "command",
  "args",
  "env",
  "workspaceFolder",
  "extensionToLanguage",
  "initializationOptions",
  "startupTimeout",
  "maxRestarts",
]);

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
    .map((entry, index) => {
      if (typeof entry === "string") {
        if (!DEPENDENCY_REF_PATTERN.test(entry)) {
          issues.push({
            path: `dependencies[${index}]`,
            message: "Invalid dependency reference",
          });
          return null;
        }
        return entry;
      }
      if (isRecord(entry) && typeof entry.name === "string") {
        if (!DEPENDENCY_NAME_PATTERN.test(entry.name)) {
          issues.push({
            path: `dependencies[${index}].name`,
            message: "Invalid dependency name",
          });
          return null;
        }
        if (
          entry.marketplace !== undefined &&
          (
            typeof entry.marketplace !== "string" ||
            !DEPENDENCY_NAME_PATTERN.test(entry.marketplace)
          )
        ) {
          issues.push({
            path: `dependencies[${index}].marketplace`,
            message: "Invalid dependency marketplace",
          });
          return null;
        }
        const versionConstraint = normalizeObjectDependencyVersionConstraint(entry, index, issues);
        if (versionConstraint === null) return null;
        const id = typeof entry.marketplace === "string"
          ? `${entry.name}@${entry.marketplace}`
          : entry.name;
        return versionConstraint === undefined ? id : `${id}@${versionConstraint}`;
      }
      issues.push({
        path: `dependencies[${index}]`,
        message: "Invalid dependency entry",
      });
      return null;
    })
    .filter((entry): entry is string => entry !== null && entry.length > 0);
  return dependencies.length > 0 ? { dependencies } : {};
}

function normalizeObjectDependencyVersionConstraint(
  entry: Readonly<Record<string, unknown>>,
  index: number,
  issues: ManifestIssue[],
): string | undefined | null {
  const hasVersion = Object.prototype.hasOwnProperty.call(entry, "version");
  const hasVersionConstraint = Object.prototype.hasOwnProperty.call(entry, "versionConstraint");
  if (hasVersion && hasVersionConstraint) {
    issues.push({
      path: `dependencies[${index}].versionConstraint`,
      message: "Use version or versionConstraint, not both",
    });
    return null;
  }
  const raw = hasVersionConstraint ? entry.versionConstraint : entry.version;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    issues.push({
      path: `dependencies[${index}].${hasVersionConstraint ? "versionConstraint" : "version"}`,
      message: "Invalid dependency version constraint",
    });
    return null;
  }
  const trimmed = raw.trim();
  const constraint = hasVersion && !/^(?:\^|~|>=|<=|>|<|=)/u.test(trimmed)
    ? `=${trimmed}`
    : trimmed;
  if (!DEPENDENCY_VERSION_CONSTRAINT_PATTERN.test(constraint)) {
    issues.push({
      path: `dependencies[${index}].${hasVersionConstraint ? "versionConstraint" : "version"}`,
      message: "Invalid dependency version constraint",
    });
    return null;
  }
  return constraint;
}

const USER_CONFIG_OPTION_TYPES = new Set<PluginUserConfigOptionType>([
  "string",
  "number",
  "boolean",
  "directory",
  "file",
]);
const USER_CONFIG_OPTION_KEYS = new Set([
  "type",
  "title",
  "description",
  "required",
  "default",
  "multiple",
  "sensitive",
  "min",
  "max",
]);
const IDENTIFIER_KEY_PATTERN = /^[A-Za-z_]\w*$/u;

function normalizeUserConfig(
  value: unknown,
  field: string,
  issues: ManifestIssue[],
): { userConfig?: Readonly<Record<string, PluginUserConfigOption>> } {
  const options = normalizeUserConfigRecord(value, field, issues, true);
  return options === undefined ? {} : { userConfig: options };
}

function normalizeUserConfigRecord(
  value: unknown,
  field: string,
  issues: ManifestIssue[],
  requireIdentifierKeys: boolean,
): Readonly<Record<string, PluginUserConfigOption>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push({ path: field, message: "Expected user config object" });
    return undefined;
  }
  const out = nullProtoRecord<PluginUserConfigOption>();
  for (const [key, option] of Object.entries(value)) {
    const optionPath = `${field}.${key}`;
    if (isUnsafeObjectKey(key)) {
      issues.push({ path: optionPath, message: "Unsafe user config key" });
      continue;
    }
    if (requireIdentifierKeys && !IDENTIFIER_KEY_PATTERN.test(key)) {
      issues.push({
        path: optionPath,
        message: "User config key must be a valid identifier",
      });
      continue;
    }
    const normalized = normalizeUserConfigOption(option, optionPath, issues);
    if (normalized !== null) out[key] = normalized;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeUserConfigOption(
  value: unknown,
  field: string,
  issues: ManifestIssue[],
): PluginUserConfigOption | null {
  if (!isRecord(value)) {
    issues.push({ path: field, message: "Expected user config option object" });
    return null;
  }
  const defaultValue = value.default;
  if (hasUnsafeObjectKey(value)) {
    issues.push({ path: field, message: "User config option contains unsafe key" });
  }
  for (const key of Object.keys(value)) {
    if (!USER_CONFIG_OPTION_KEYS.has(key)) {
      issues.push({ path: `${field}.${key}`, message: "Unknown user config option field" });
    }
  }
  if (
    typeof value.type !== "string" ||
    !USER_CONFIG_OPTION_TYPES.has(value.type as PluginUserConfigOptionType)
  ) {
    issues.push({ path: `${field}.type`, message: "Invalid user config option type" });
  }
  if (typeof value.title !== "string") {
    issues.push({ path: `${field}.title`, message: "User config option requires title" });
  }
  if (typeof value.description !== "string") {
    issues.push({
      path: `${field}.description`,
      message: "User config option requires description",
    });
  }
  if (value.required !== undefined && typeof value.required !== "boolean") {
    issues.push({ path: `${field}.required`, message: "Expected boolean" });
  }
  if (value.multiple !== undefined && typeof value.multiple !== "boolean") {
    issues.push({ path: `${field}.multiple`, message: "Expected boolean" });
  }
  if (value.sensitive !== undefined && typeof value.sensitive !== "boolean") {
    issues.push({ path: `${field}.sensitive`, message: "Expected boolean" });
  }
  if (value.min !== undefined && typeof value.min !== "number") {
    issues.push({ path: `${field}.min`, message: "Expected number" });
  }
  if (value.max !== undefined && typeof value.max !== "number") {
    issues.push({ path: `${field}.max`, message: "Expected number" });
  }
  if (
    defaultValue !== undefined &&
    typeof defaultValue !== "string" &&
    typeof defaultValue !== "number" &&
    typeof defaultValue !== "boolean" &&
    !(
      Array.isArray(defaultValue) &&
      defaultValue.every((entry) => typeof entry === "string")
    )
  ) {
    issues.push({ path: `${field}.default`, message: "Invalid default value" });
  }
  if (
    typeof value.type !== "string" ||
    !USER_CONFIG_OPTION_TYPES.has(value.type as PluginUserConfigOptionType) ||
    typeof value.title !== "string" ||
    typeof value.description !== "string"
  ) {
    return null;
  }
  return {
    type: value.type as PluginUserConfigOptionType,
    title: value.title,
    description: value.description,
    ...(typeof value.required === "boolean" ? { required: value.required } : {}),
    ...(validDefaultValue(defaultValue) ? { default: defaultValue } : {}),
    ...(typeof value.multiple === "boolean" ? { multiple: value.multiple } : {}),
    ...(typeof value.sensitive === "boolean" ? { sensitive: value.sensitive } : {}),
    ...(typeof value.min === "number" ? { min: value.min } : {}),
    ...(typeof value.max === "number" ? { max: value.max } : {}),
  };
}

function validDefaultValue(
  value: unknown,
): value is string | number | boolean | readonly string[] {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"));
}

function normalizeChannels(
  value: unknown,
  issues: ManifestIssue[],
): { channels?: readonly PluginManifestChannel[] } {
  if (value === undefined) return {};
  if (!Array.isArray(value)) {
    issues.push({ path: "channels", message: "Expected channel array" });
    return {};
  }
  const channels: PluginManifestChannel[] = [];
  for (const [index, entry] of value.entries()) {
    const field = `channels[${index}]`;
    if (!isRecord(entry)) {
      issues.push({ path: field, message: "Expected channel object" });
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (isUnsafeObjectKey(key)) {
        issues.push({ path: `${field}.${key}`, message: "Unsafe channel key" });
      } else if (key !== "server" && key !== "displayName" && key !== "userConfig") {
        issues.push({ path: `${field}.${key}`, message: "Unknown channel field" });
      }
    }
    if (typeof entry.server !== "string" || entry.server.trim().length === 0) {
      issues.push({ path: `${field}.server`, message: "Channel requires server" });
      continue;
    }
    if (entry.displayName !== undefined && typeof entry.displayName !== "string") {
      issues.push({ path: `${field}.displayName`, message: "Expected string" });
    }
    const userConfig = normalizeUserConfigRecord(
      entry.userConfig,
      `${field}.userConfig`,
      issues,
      false,
    );
    channels.push({
      server: entry.server,
      ...(typeof entry.displayName === "string" ? { displayName: entry.displayName } : {}),
      ...(userConfig !== undefined ? { userConfig } : {}),
    });
  }
  return channels.length > 0 ? { channels } : {};
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
  validateInterfaceFieldTypes(value, issues);
  const defaultPrompt = normalizeDefaultPrompt(value.defaultPrompt, issues);
  const screenshots = normalizeScreenshots(pluginRoot, value.screenshots, issues);
  const normalized: PluginManifestInterface = {
    ...optionalStringProperty(value, "displayName"),
    ...optionalStringProperty(value, "shortDescription"),
    ...optionalStringProperty(value, "longDescription"),
    ...optionalStringProperty(value, "developerName"),
    ...optionalStringProperty(value, "category"),
    capabilities: Array.isArray(value.capabilities)
      ? value.capabilities.filter((entry): entry is string => typeof entry === "string")
      : [],
    ...optionalStringAliasProperty(value, "websiteUrl", ["websiteUrl", "websiteURL"]),
    ...optionalStringAliasProperty(value, "privacyPolicyUrl", [
      "privacyPolicyUrl",
      "privacyPolicyURL",
    ]),
    ...optionalStringAliasProperty(value, "termsOfServiceUrl", [
      "termsOfServiceUrl",
      "termsOfServiceURL",
    ]),
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

function validateInterfaceFieldTypes(
  value: Readonly<Record<string, unknown>>,
  issues: ManifestIssue[],
): void {
  for (const key of [
    "displayName",
    "shortDescription",
    "longDescription",
    "developerName",
    "category",
    "websiteUrl",
    "websiteURL",
    "privacyPolicyUrl",
    "privacyPolicyURL",
    "termsOfServiceUrl",
    "termsOfServiceURL",
    "brandColor",
  ] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      issues.push({ path: `interface.${key}`, message: "Expected string" });
    }
  }
}

function optionalStringAliasProperty(
  record: Record<string, unknown>,
  outputKey: string,
  keys: readonly string[],
): Record<string, string> {
  for (const key of keys) {
    const value = optionalString(record[key]);
    if (value !== undefined) return { [outputKey]: value };
  }
  return {};
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
  if (value === undefined) return {};
  if (typeof value !== "string") {
    issues.push({ path: `interface.${key}`, message: "Expected asset path string" });
    return {};
  }
  const resolved = safeResolveAsset(pluginRoot, `interface.${key}`, value, issues);
  return resolved === null ? {} : { [key]: resolved };
}

function normalizeScreenshots(
  pluginRoot: string,
  value: unknown,
  issues: ManifestIssue[],
): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push({ path: "interface.screenshots", message: "Expected screenshot array" });
    return [];
  }
  const screenshots: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      issues.push({
        path: `interface.screenshots[${index}]`,
        message: "Expected asset path string",
      });
      continue;
    }
    const resolved = safeResolveAsset(
      pluginRoot,
      `interface.screenshots[${index}]`,
      entry,
      issues,
    );
    if (resolved !== null) screenshots.push(resolved);
  }
  return screenshots;
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
