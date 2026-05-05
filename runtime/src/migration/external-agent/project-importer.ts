import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
} from "node:path";

import { load as loadYaml } from "js-yaml";

import { HOOK_EVENT_NAMES } from "../../config/schema.js";
import type { TomlTable } from "./toml.js";
import { renderTomlDocument } from "./toml.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonRecord = { readonly [key: string]: JsonValue };

export interface SourceAgentLayout {
  readonly configDirName?: string;
  readonly projectConfigFileName?: string;
  readonly projectDirEnvVar?: string;
  readonly docFileName?: string;
  readonly termVariants?: readonly string[];
  readonly hooksSubdir?: string;
  readonly migratedHooksSubdir?: string;
  readonly commandSkillPrefix?: string;
}

export interface NormalizedSourceAgentLayout {
  readonly configDirName: string;
  readonly projectConfigFileName: string;
  readonly projectDirEnvVar: string;
  readonly docFileName: string;
  readonly termVariants: readonly string[];
  readonly hooksSubdir: string;
  readonly migratedHooksSubdir: string;
  readonly commandSkillPrefix: string;
}

export interface AgenCMcpServerMigrationConfig {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly transport?: "stdio" | "http";
  readonly endpoint?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface AgenCMcpMigrationConfig {
  readonly mcp_servers?: Readonly<Record<string, AgenCMcpServerMigrationConfig>>;
}

export interface BuildMcpConfigOptions {
  readonly sourceRoot: string;
  readonly sourceAgentHome?: string | null;
  readonly settings?: JsonValue | null;
  readonly layout?: SourceAgentLayout;
}

export interface ImportExternalAgentProjectOptions
  extends BuildMcpConfigOptions {
  readonly targetAgencHome: string;
  readonly targetMcpConfigFile?: string;
  readonly targetHooksFile?: string;
  readonly sourceAgentsDir?: string;
  readonly targetAgentsDir?: string;
  readonly sourceCommandsDir?: string;
  readonly targetSkillsDir?: string;
}

export interface ImportExternalAgentProjectResult {
  readonly mcpConfig: AgenCMcpMigrationConfig;
  readonly mcpToml: string;
  readonly mcpConfigFile: string | null;
  readonly wroteHooks: boolean;
  readonly importedSubagents: number;
  readonly importedCommands: number;
}

interface ParsedDocument {
  readonly frontmatter: ReadonlyMap<string, FrontmatterValue>;
  readonly body: string;
  readonly frontmatterError: string | null;
}

type FrontmatterValue =
  | { readonly type: "scalar"; readonly value: string }
  | { readonly type: "other" };

interface AgentMetadata {
  readonly name: string;
  readonly description: string;
  readonly permissionMode: string | null;
  readonly effort: string | null;
}

const MCP_CONFIG_FILE = ".mcp.json";
const DEFAULT_LAYOUT: NormalizedSourceAgentLayout = Object.freeze({
  configDirName: ".cursor",
  projectConfigFileName: ".cursor.json",
  projectDirEnvVar: "CURSOR_PROJECT_DIR",
  docFileName: "AGENTS.md",
  termVariants: Object.freeze([
    "cursor",
    "source agent",
    "source-agent",
    "source_agent",
    "sourceagent",
  ]),
  hooksSubdir: "hooks",
  migratedHooksSubdir: "hooks",
  commandSkillPrefix: "source-command",
});
const MAX_SKILL_NAME_LEN = 64;
const MAX_SKILL_DESCRIPTION_LEN = 1024;
const HOOK_EVENTS_TO_IMPORT = Object.freeze([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
] as const);
const HOOK_EVENTS_WITH_MATCHERS = new Set([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "SessionStart",
]);
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function normalizeSourceAgentLayout(
  layout: SourceAgentLayout = {},
): NormalizedSourceAgentLayout {
  return Object.freeze({
    configDirName: layout.configDirName ?? DEFAULT_LAYOUT.configDirName,
    projectConfigFileName:
      layout.projectConfigFileName ?? DEFAULT_LAYOUT.projectConfigFileName,
    projectDirEnvVar:
      layout.projectDirEnvVar ?? DEFAULT_LAYOUT.projectDirEnvVar,
    docFileName: layout.docFileName ?? DEFAULT_LAYOUT.docFileName,
    termVariants: Object.freeze([
      ...(layout.termVariants ?? DEFAULT_LAYOUT.termVariants),
    ]),
    hooksSubdir: layout.hooksSubdir ?? DEFAULT_LAYOUT.hooksSubdir,
    migratedHooksSubdir:
      layout.migratedHooksSubdir ?? DEFAULT_LAYOUT.migratedHooksSubdir,
    commandSkillPrefix:
      layout.commandSkillPrefix ?? DEFAULT_LAYOUT.commandSkillPrefix,
  });
}

export async function buildMcpConfigFromSource(
  opts: BuildMcpConfigOptions,
): Promise<AgenCMcpMigrationConfig> {
  const layout = normalizeSourceAgentLayout(opts.layout);
  const mcpServers = await readSourceMcpServers(
    opts.sourceRoot,
    opts.sourceAgentHome ?? null,
    layout,
  );
  if (mcpServers.size === 0) return {};

  const settings = jsonObject(opts.settings);
  const enabledServers = jsonStringVec(settings?.enabledMcpjsonServers);
  const disabledServers = new Set(
    jsonStringVec(settings?.disabledMcpjsonServers),
  );
  const servers = nullProtoRecord<AgenCMcpServerMigrationConfig>();

  for (const [serverName, serverConfig] of mcpServers) {
    if (!isSafeObjectKey(serverName)) continue;
    const converted = mcpServerConfig(
      serverName,
      jsonObject(serverConfig),
      enabledServers,
      disabledServers,
    );
    if (converted !== null) servers[serverName] = converted;
  }

  return Object.keys(servers).length === 0
    ? {}
    : Object.freeze({ mcp_servers: Object.freeze(servers) });
}

export function renderMcpConfigToml(config: AgenCMcpMigrationConfig): string {
  return renderTomlDocument((config as unknown as TomlTable) ?? {});
}

export async function importExternalAgentProject(
  opts: ImportExternalAgentProjectOptions,
): Promise<ImportExternalAgentProjectResult> {
  const layout = normalizeSourceAgentLayout(opts.layout);
  const sourceAgentHome =
    opts.sourceAgentHome ?? join(opts.sourceRoot, layout.configDirName);
  const mcpConfig = await buildMcpConfigFromSource({
    sourceRoot: opts.sourceRoot,
    sourceAgentHome,
    settings: opts.settings,
    layout,
  });
  const mcpToml = renderMcpConfigToml(mcpConfig);
  const targetMcpConfigFile =
    opts.targetMcpConfigFile ??
    join(opts.targetAgencHome, "mcp-servers.toml");
  let mcpConfigFile: string | null = null;
  if (mcpToml.trim().length > 0) {
    await mkdir(dirname(targetMcpConfigFile), { recursive: true });
    await writeFile(targetMcpConfigFile, mcpToml, "utf8");
    mcpConfigFile = targetMcpConfigFile;
  }

  const wroteHooks = await importHooks(
    sourceAgentHome,
    opts.targetHooksFile ?? join(opts.targetAgencHome, "hooks.json"),
    layout,
  );
  const importedSubagents = await importSubagents(
    opts.sourceAgentsDir ?? join(sourceAgentHome, "agents"),
    opts.targetAgentsDir ?? join(opts.targetAgencHome, "agents"),
    layout,
  );
  const importedCommands = await importCommands(
    opts.sourceCommandsDir ?? join(sourceAgentHome, "commands"),
    opts.targetSkillsDir ?? join(opts.targetAgencHome, "skills"),
    layout,
  );

  return Object.freeze({
    mcpConfig,
    mcpToml,
    mcpConfigFile,
    wroteHooks,
    importedSubagents,
    importedCommands,
  });
}

export async function hooksMigrationDescription(
  sourceAgentDir: string,
  targetHooks: string,
  layout: SourceAgentLayout = {},
): Promise<string | null> {
  const events = await hookMigrationEventNames(sourceAgentDir, targetHooks, layout);
  return events.length === 0
    ? null
    : `Migrate hooks from ${sourceAgentDir} to ${targetHooks}`;
}

export async function hookMigrationEventNames(
  sourceAgentDir: string,
  targetHooks: string,
  layout: SourceAgentLayout = {},
): Promise<string[]> {
  const parent = dirname(targetHooks);
  const migration = await hookMigration(sourceAgentDir, parent, layout);
  return Object.keys(migration).sort();
}

export async function importHooks(
  sourceAgentDir: string,
  targetHooks: string,
  layout: SourceAgentLayout = {},
): Promise<boolean> {
  const parent = dirname(targetHooks);
  if (parent === targetHooks) {
    throw new Error("hooks target path has no parent");
  }
  const normalizedLayout = normalizeSourceAgentLayout(layout);
  const migration = await hookMigration(sourceAgentDir, parent, normalizedLayout);
  if (Object.keys(migration).length === 0) return false;
  await mkdir(parent, { recursive: true });

  if (!(await isMissingOrEmptyTextFile(targetHooks))) return false;
  await copyHookScripts(sourceAgentDir, parent, normalizedLayout);
  await writeFile(
    targetHooks,
    `${JSON.stringify({ hooks: migration }, null, 2)}\n`,
    "utf8",
  );
  return true;
}

export async function countMissingSubagents(
  sourceAgents: string,
  targetAgents: string,
  layout: SourceAgentLayout = {},
): Promise<number> {
  return (await missingSubagentNames(sourceAgents, targetAgents, layout)).length;
}

export async function missingSubagentNames(
  sourceAgents: string,
  targetAgents: string,
  _layout: SourceAgentLayout = {},
): Promise<string[]> {
  const names: string[] = [];
  for (const sourceFile of await agentSourceFiles(sourceAgents)) {
    const document = await parseDocument(sourceFile);
    const metadata = agentMetadata(document);
    const target = subagentTargetFile(sourceFile, targetAgents);
    if (metadata !== null && !(await pathExists(target))) {
      names.push(metadata.name);
    }
  }
  return names;
}

export async function importSubagents(
  sourceAgents: string,
  targetAgents: string,
  layout: SourceAgentLayout = {},
): Promise<number> {
  if (!(await isDirectory(sourceAgents))) return 0;
  await mkdir(targetAgents, { recursive: true });
  let imported = 0;
  for (const sourceFile of await agentSourceFiles(sourceAgents)) {
    const target = subagentTargetFile(sourceFile, targetAgents);
    if (await pathExists(target)) continue;
    const document = await parseDocument(sourceFile);
    const metadata = agentMetadata(document);
    if (metadata === null) continue;
    await writeFile(
      target,
      renderAgentToml(document.body, metadata, layout),
      "utf8",
    );
    imported += 1;
  }
  return imported;
}

export async function countMissingCommands(
  sourceCommands: string,
  targetSkills: string,
  layout: SourceAgentLayout = {},
): Promise<number> {
  return (await missingCommandNames(sourceCommands, targetSkills, layout)).length;
}

export async function missingCommandNames(
  sourceCommands: string,
  targetSkills: string,
  layout: SourceAgentLayout = {},
): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await uniqueSupportedCommandSources(sourceCommands, layout)) {
    if (!(await pathExists(join(targetSkills, entry.name)))) {
      names.push(entry.name);
    }
  }
  return names;
}

export async function importCommands(
  sourceCommands: string,
  targetSkills: string,
  layout: SourceAgentLayout = {},
): Promise<number> {
  if (!(await isDirectory(sourceCommands))) return 0;
  await mkdir(targetSkills, { recursive: true });
  let imported = 0;
  for (const { sourceFile, name } of await uniqueSupportedCommandSources(
    sourceCommands,
    layout,
  )) {
    const document = await parseDocument(sourceFile);
    const targetDir = join(targetSkills, name);
    if (await pathExists(targetDir)) continue;
    const sourceName = commandSourceName(sourceCommands, sourceFile);
    const description = commandSkillDescription(document);
    if (description === null) continue;
    await mkdir(targetDir, { recursive: true });
    await writeFile(
      join(targetDir, "SKILL.md"),
      renderCommandSkill(
        document.body,
        name,
        description,
        sourceName,
        layout,
      ),
      "utf8",
    );
    imported += 1;
  }
  return imported;
}

async function readSourceMcpServers(
  sourceRoot: string,
  sourceAgentHome: string | null,
  layout: NormalizedSourceAgentLayout,
): Promise<Map<string, JsonValue>> {
  const servers = new Map<string, JsonValue>();
  for (const relativePath of [MCP_CONFIG_FILE, layout.projectConfigFileName]) {
    const sourceFile = join(sourceRoot, relativePath);
    if (!(await isFile(sourceFile))) continue;
    const parsed = await readJsonFile(sourceFile, "invalid MCP config");
    appendMcpServersFromValue(parsed, servers, "overwrite");
    if (relativePath === layout.projectConfigFileName) {
      await appendMatchingProjectServers(
        parsed,
        sourceRoot,
        servers,
        "overwrite",
      );
    }
  }

  if (sourceAgentHome !== null) {
    const sourceAgentRoot = dirname(sourceAgentHome);
    if (resolve(sourceAgentRoot) !== resolve(sourceRoot)) {
      const sourceFile = join(sourceAgentRoot, layout.projectConfigFileName);
      if (await isFile(sourceFile)) {
        const parsed = await readJsonFile(sourceFile, "invalid MCP config");
        await appendMatchingProjectServers(
          parsed,
          sourceRoot,
          servers,
          "preserve",
        );
      }
    }
  }
  return servers;
}

async function appendMatchingProjectServers(
  value: JsonValue,
  sourceRoot: string,
  servers: Map<string, JsonValue>,
  merge: "overwrite" | "preserve",
): Promise<void> {
  const projects = jsonObject(jsonObject(value)?.projects);
  if (projects === null) return;
  for (const [projectPath, projectConfig] of Object.entries(projects)) {
    if (await projectPathMatchesSourceRoot(projectPath, sourceRoot)) {
      appendMcpServersFromValue(projectConfig, servers, merge);
    }
  }
}

function appendMcpServersFromValue(
  value: JsonValue,
  servers: Map<string, JsonValue>,
  merge: "overwrite" | "preserve",
): void {
  const mcpServers = jsonObject(jsonObject(value)?.mcpServers);
  if (mcpServers === null) return;
  for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
    if (!isSafeObjectKey(serverName)) continue;
    if (merge === "overwrite" || !servers.has(serverName)) {
      servers.set(serverName, serverConfig);
    }
  }
}

async function projectPathMatchesSourceRoot(
  projectPath: string,
  sourceRoot: string,
): Promise<boolean> {
  if (resolve(projectPath) === resolve(sourceRoot)) return true;
  try {
    const [projectRealPath, sourceRealPath] = await Promise.all([
      realpathForCompare(projectPath),
      realpathForCompare(sourceRoot),
    ]);
    return projectRealPath === sourceRealPath;
  } catch {
    return false;
  }
}

async function realpathForCompare(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(path);
}

function mcpServerConfig(
  serverName: string,
  serverConfig: JsonRecord | null,
  enabledServers: readonly string[],
  disabledServers: ReadonlySet<string>,
): AgenCMcpServerMigrationConfig | null {
  if (serverConfig === null) return null;
  const transportType = jsonString(serverConfig.type);
  if (mcpServerIsDisabled(
    serverName,
    serverConfig,
    enabledServers,
    disabledServers,
  )) {
    return null;
  }

  const command = jsonString(serverConfig.command);
  if (command !== null) {
    if (!(transportType === null || transportType === "stdio")) return null;
    if (containsEnvPlaceholder(command)) return null;
    const out: { -readonly [K in keyof AgenCMcpServerMigrationConfig]: AgenCMcpServerMigrationConfig[K] } = {
      transport: "stdio",
      command,
    };
    const args = jsonStringVec(serverConfig.args);
    if (args.some(containsEnvPlaceholder)) return null;
    if (args.length > 0) out.args = args;
    const env = jsonObject(serverConfig.env);
    if (env !== null) {
      const envConfig = envServerConfig(env);
      if (envConfig === null) return null;
      if (Object.keys(envConfig).length > 0) out.env = envConfig;
    }
    return Object.freeze(out);
  }

  const url = jsonString(serverConfig.url);
  if (url !== null) {
    if (
      !(
        transportType === null ||
        transportType === "http" ||
        transportType === "streamable_http"
      )
    ) {
      return null;
    }
    if (containsEnvPlaceholder(url)) return null;
    const out: { -readonly [K in keyof AgenCMcpServerMigrationConfig]: AgenCMcpServerMigrationConfig[K] } = {
      transport: "http",
      endpoint: url,
    };
    const headers = jsonObject(serverConfig.headers);
    if (headers !== null) {
      const headerConfig = httpHeaderConfig(headers);
      if (headerConfig === null) return null;
      if (Object.keys(headerConfig).length > 0) out.headers = headerConfig;
    }
    return Object.freeze(out);
  }

  return null;
}

function mcpServerIsDisabled(
  serverName: string,
  serverConfig: JsonRecord,
  enabledServers: readonly string[],
  disabledServers: ReadonlySet<string>,
): boolean {
  return (
    serverConfig.enabled === false ||
    serverConfig.disabled === true ||
    (enabledServers.length > 0 && !enabledServers.includes(serverName)) ||
    disabledServers.has(serverName)
  );
}

function httpHeaderConfig(
  headers: JsonRecord,
): Record<string, string> | null {
  const out = nullProtoRecord<string>();
  for (const [key, value] of Object.entries(headers)) {
    if (!isSafeObjectKey(key)) continue;
    const headerValue = jsonString(value) ?? JSON.stringify(value);
    if (containsEnvPlaceholder(headerValue)) return null;
    out[key] = headerValue;
  }
  return out;
}

function envServerConfig(env: JsonRecord): Record<string, string> | null {
  const out = nullProtoRecord<string>();
  for (const [key, value] of Object.entries(env)) {
    if (!isSafeObjectKey(key)) continue;
    const envValue = jsonString(value) ?? JSON.stringify(value);
    if (parseEnvPlaceholder(envValue) === key) {
      continue;
    }
    if (containsEnvPlaceholder(envValue)) return null;
    out[key] = envValue;
  }
  return out;
}

function parseEnvPlaceholder(value: string): string | null {
  const match = /^\$\{([^}]+)\}$/.exec(value);
  if (!match) return null;
  const name = match[1]!.split(":-", 1)[0]!;
  if (!/^[_A-Za-z][_A-Za-z0-9]*$/.test(name)) return null;
  return name;
}

function containsEnvPlaceholder(value: string): boolean {
  return value.includes("${");
}

async function hookMigration(
  sourceAgentDir: string,
  targetConfigDir: string | null,
  layout: SourceAgentLayout = {},
): Promise<Record<string, JsonValue[]>> {
  const normalizedLayout = normalizeSourceAgentLayout(layout);
  const settingsFiles: JsonValue[] = [];
  let disableAllHooks: boolean | null = null;
  for (const settingsName of ["settings.json", "settings.local.json"]) {
    const settingsFile = join(sourceAgentDir, settingsName);
    if (!(await isFile(settingsFile))) continue;
    const settings = await readJsonFile(settingsFile, "invalid hooks settings");
    const disabled = jsonObject(settings)?.disableAllHooks;
    if (typeof disabled === "boolean") disableAllHooks = disabled;
    settingsFiles.push(settings);
  }
  if (disableAllHooks === true) return {};

  const migration = nullProtoRecord<JsonValue[]>();
  for (const settings of settingsFiles) {
    appendConvertibleHookGroups(
      settings,
      migration,
      targetConfigDir,
      normalizedLayout,
    );
  }
  return migration;
}

function appendConvertibleHookGroups(
  settings: JsonValue,
  hooksPayload: Record<string, JsonValue[]>,
  targetConfigDir: string | null,
  layout: NormalizedSourceAgentLayout,
): void {
  const hooksConfig = jsonObject(jsonObject(settings)?.hooks);
  if (hooksConfig === null) return;

  for (const eventName of HOOK_EVENTS_TO_IMPORT) {
    if (!HOOK_EVENT_NAMES.includes(eventName)) continue;
    const groups = jsonArray(hooksConfig[eventName]);
    if (groups === null) continue;
    for (const group of groups) {
      const groupObject = jsonObject(group);
      if (groupObject === null) continue;
      if (
        "if" in groupObject ||
        Object.keys(groupObject).some((key) => key !== "matcher" && key !== "hooks")
      ) {
        continue;
      }
      const hookCommands: JsonValue[] = [];
      const hooks = jsonArray(groupObject.hooks) ?? [];
      for (const hook of hooks) {
        const hookObject = jsonObject(hook);
        if (hookObject === null) continue;
        const hookType = jsonString(hookObject.type) ?? "command";
        if (hookType !== "command") continue;
        if (
          Object.keys(hookObject).some(
            (key) =>
              ![
                "type",
                "command",
                "timeout",
                "timeoutSec",
                "statusMessage",
                "async",
              ].includes(key),
          )
        ) {
          continue;
        }
        if (hookObject.async === true) continue;
        if (
          ["asyncRewake", "shell", "once"].some((field) => field in hookObject)
        ) {
          continue;
        }
        const command = jsonString(hookObject.command)?.trim();
        if (!command) continue;

        const commandPayload: Record<string, JsonValue> = {
          type: "command",
          command: rewriteHookCommand(command, targetConfigDir, layout),
        };
        const timeoutSeconds = jsonU64(
          hookObject.timeout ?? hookObject.timeoutSec,
        );
        if (timeoutSeconds !== null) {
          commandPayload.timeout_ms = timeoutSeconds * 1000;
        }
        const statusMessage = jsonString(hookObject.statusMessage);
        if (statusMessage !== null) {
          commandPayload.statusMessage = rewriteSourceTerms(statusMessage, layout);
        }
        hookCommands.push(commandPayload);
      }
      if (hookCommands.length === 0) continue;

      const groupPayload: Record<string, JsonValue> = {
        hooks: hookCommands,
      };
      const matcher = jsonString(groupObject.matcher);
      if (HOOK_EVENTS_WITH_MATCHERS.has(eventName) && matcher !== null) {
        groupPayload.matcher = matcher;
      }
      hooksPayload[eventName] ??= [];
      hooksPayload[eventName]!.push(groupPayload);
    }
  }
}

function rewriteHookCommand(
  command: string,
  targetConfigDir: string | null,
  layout: NormalizedSourceAgentLayout,
): string {
  if (targetConfigDir === null) return command;
  if (looksLikeWindowsHookCommand(command, layout)) return command;
  const targetHooksDir = join(targetConfigDir, layout.migratedHooksSubdir);
  const sourceHooksPath = `${layout.configDirName}/${layout.hooksSubdir}/`;
  const singleQuoted = replaceQuotedHookPaths(
    command,
    "'",
    sourceHooksPath,
    targetHooksDir,
  );
  const doubleQuoted = replaceQuotedHookPaths(
    singleQuoted,
    '"',
    sourceHooksPath,
    targetHooksDir,
  );
  return replaceUnquotedHookPaths(
    doubleQuoted,
    sourceHooksPath,
    targetHooksDir,
  );
}

function replaceQuotedHookPaths(
  command: string,
  quote: string,
  sourceHooksPath: string,
  targetHooksDir: string,
): string {
  let rewritten = command;
  let searchStart = 0;
  while (searchStart < rewritten.length) {
    const start = rewritten.indexOf(quote, searchStart);
    if (start === -1) break;
    const contentStart = start + quote.length;
    const end = rewritten.indexOf(quote, contentStart);
    if (end === -1) break;
    const content = rewritten.slice(contentStart, end);
    const sourceHooksStart = content.indexOf(sourceHooksPath);
    if (sourceHooksStart === -1) {
      searchStart = end + quote.length;
      continue;
    }
    const suffix = content.slice(sourceHooksStart + sourceHooksPath.length);
    const replacement = targetHookPathReplacement(
      targetHooksDir,
      content,
      sourceHooksStart,
      suffix,
    );
    if (replacement === null) {
      searchStart = end + quote.length;
      continue;
    }
    rewritten =
      rewritten.slice(0, start) +
      replacement +
      rewritten.slice(end + quote.length);
    searchStart = start + replacement.length;
  }
  return rewritten;
}

function replaceUnquotedHookPaths(
  command: string,
  sourceHooksPath: string,
  targetHooksDir: string,
): string {
  let rewritten = command;
  let searchStart = 0;
  while (searchStart < rewritten.length) {
    const sourceHooksStart = findUnquotedSourceHookPath(
      rewritten,
      sourceHooksPath,
      searchStart,
    );
    if (sourceHooksStart === -1) break;
    const pathStart = shellPathStart(rewritten, sourceHooksStart);
    const pathEnd = shellPathEnd(
      rewritten,
      sourceHooksStart + sourceHooksPath.length,
    );
    if (isAssignmentValueStart(rewritten, pathStart)) {
      searchStart = sourceHooksStart + sourceHooksPath.length;
      continue;
    }
    const path = rewritten.slice(pathStart, pathEnd);
    const suffix = rewritten.slice(
      sourceHooksStart + sourceHooksPath.length,
      pathEnd,
    );
    const replacement = targetHookPathReplacement(
      targetHooksDir,
      path,
      sourceHooksStart - pathStart,
      suffix,
    );
    if (replacement === null) {
      searchStart = sourceHooksStart + sourceHooksPath.length;
      continue;
    }
    rewritten =
      rewritten.slice(0, pathStart) +
      replacement +
      rewritten.slice(pathEnd);
    searchStart = pathStart + replacement.length;
  }
  return rewritten;
}

function findUnquotedSourceHookPath(
  command: string,
  sourceHooksPath: string,
  start: number,
): number {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  for (let index = start; index < command.length; index += 1) {
    const ch = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (!inSingleQuote && ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (
      !inSingleQuote &&
      !inDoubleQuote &&
      command.startsWith(sourceHooksPath, index)
    ) {
      return index;
    }
  }
  return -1;
}

function targetHookPathReplacement(
  targetHooksDir: string,
  path: string,
  sourceHooksStart: number,
  suffix: string,
): string | null {
  if (
    !isPureShellPathContent(path, sourceHooksStart) ||
    !isStaticHookPathSuffix(suffix) ||
    !isSafeRelativeHookSuffix(suffix)
  ) {
    return null;
  }
  return shellSingleQuote(join(targetHooksDir, suffix));
}

function isPureShellPathContent(path: string, sourceHooksStart: number): boolean {
  const prefix = path.slice(0, sourceHooksStart);
  return (
    (prefix.length === 0 || prefix === "./" || prefix.endsWith("/")) &&
    ![...prefix].some(isShellPathBoundary)
  );
}

function shellPathStart(command: string, end: number): number {
  for (let index = end - 1; index >= 0; index -= 1) {
    if (isShellPathBoundary(command[index]!)) return index + 1;
  }
  return 0;
}

function shellPathEnd(command: string, start: number): number {
  let escaped = false;
  for (let index = start; index < command.length; index += 1) {
    const ch = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (isShellPathBoundary(ch)) return index;
  }
  return command.length;
}

function isShellPathBoundary(ch: string): boolean {
  return /\s/.test(ch) || ["=", ";", "|", "&", "<", ">", "(", ")"].includes(ch);
}

function isAssignmentValueStart(command: string, pathStart: number): boolean {
  return command[pathStart - 1] === "=";
}

function isStaticHookPathSuffix(suffix: string): boolean {
  return (
    suffix.length > 0 &&
    !/[\\$`*?[{}]/.test(suffix)
  );
}

function isSafeRelativeHookSuffix(suffix: string): boolean {
  if (suffix.startsWith("/") || suffix.startsWith("\\")) return false;
  return !suffix.split(/[\\/]+/).some((part) => part === "..");
}

function looksLikeWindowsHookCommand(
  command: string,
  layout: NormalizedSourceAgentLayout,
): boolean {
  const sourceHooksBackslashPath = `${layout.configDirName}\\${layout.hooksSubdir}\\`;
  return (
    command.includes(sourceHooksBackslashPath) ||
    command.includes(`%${layout.projectDirEnvVar}%`) ||
    command.includes(`$env:${layout.projectDirEnvVar}`)
  );
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function copyHookScripts(
  sourceAgentDir: string,
  targetConfigDir: string,
  layout: NormalizedSourceAgentLayout,
): Promise<void> {
  const sourceHooks = join(sourceAgentDir, layout.hooksSubdir);
  if (!(await isDirectory(sourceHooks))) return;
  const targetHooks = join(targetConfigDir, layout.migratedHooksSubdir);
  await copyDirRecursiveSkipExisting(sourceHooks, targetHooks);
}

async function copyDirRecursiveSkipExisting(
  source: string,
  target: string,
): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursiveSkipExisting(sourcePath, targetPath);
    } else if (entry.isFile() && !(await pathExists(targetPath))) {
      await copyFile(sourcePath, targetPath);
    }
  }
}

async function agentSourceFiles(sourceAgents: string): Promise<string[]> {
  if (!(await isDirectory(sourceAgents))) return [];
  const files: string[] = [];
  for (const entry of await readdir(sourceAgents, { withFileTypes: true })) {
    const path = join(sourceAgents, entry.name);
    if (
      entry.isFile() &&
      extname(path) === ".md" &&
      basename(path, ".md") !== "README"
    ) {
      files.push(path);
    }
  }
  files.sort();
  return files;
}

function subagentTargetFile(sourceFile: string, targetAgents: string): string {
  return join(targetAgents, `${basename(sourceFile, extname(sourceFile))}.toml`);
}

async function commandSourceFiles(sourceCommands: string): Promise<string[]> {
  const files: string[] = [];
  await collectMarkdownFiles(sourceCommands, files);
  files.sort();
  return files;
}

async function uniqueSupportedCommandSources(
  sourceCommands: string,
  layout: SourceAgentLayout,
): Promise<Array<{ readonly sourceFile: string; readonly name: string }>> {
  const byName = new Map<string, string[]>();
  for (const sourceFile of await commandSourceFiles(sourceCommands)) {
    const document = await parseDocument(sourceFile);
    const name = commandSkillNameIfSupported(
      sourceCommands,
      sourceFile,
      document,
      layout,
    );
    if (name === null) continue;
    const files = byName.get(name) ?? [];
    files.push(sourceFile);
    byName.set(name, files);
  }

  return [...byName.entries()]
    .filter(([, files]) => files.length === 1)
    .map(([name, files]) => ({ sourceFile: files[0]!, name }));
}

async function collectMarkdownFiles(dir: string, files: string[]): Promise<void> {
  if (!(await isDirectory(dir))) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectMarkdownFiles(path, files);
    } else if (entry.isFile() && extname(path) === ".md") {
      files.push(path);
    }
  }
}

async function parseDocument(sourceFile: string): Promise<ParsedDocument> {
  return parseDocumentContent(await readFile(sourceFile, "utf8"));
}

function parseDocumentContent(content: string): ParsedDocument {
  const rest = content.startsWith("---\n")
    ? content.slice(4)
    : content.startsWith("---\r\n")
      ? content.slice(5)
      : null;
  if (rest === null) {
    return { frontmatter: new Map(), body: content, frontmatterError: null };
  }
  const end = frontmatterEnd(rest);
  if (end === null) {
    return { frontmatter: new Map(), body: content, frontmatterError: null };
  }

  const rawFrontmatter = rest.slice(0, end.frontmatterEnd);
  const body = rest.slice(end.bodyStart);
  const [frontmatter, frontmatterError] = parseFrontmatter(rawFrontmatter);
  return { frontmatter, body, frontmatterError };
}

function frontmatterEnd(rest: string): { frontmatterEnd: number; bodyStart: number } | null {
  const delimiters = [
    "\r\n---\r\n",
    "\r\n---\n",
    "\n---\r\n",
    "\n---\n",
    "\r\n---",
    "\n---",
  ];
  const matches = delimiters
    .map((delimiter) => {
      const index = rest.indexOf(delimiter);
      return index === -1
        ? null
        : { frontmatterEnd: index, bodyStart: index + delimiter.length };
    })
    .filter((match): match is { frontmatterEnd: number; bodyStart: number } => match !== null)
    .sort((left, right) => left.frontmatterEnd - right.frontmatterEnd);
  return matches[0] ?? null;
}

function parseFrontmatter(
  rawFrontmatter: string,
): [ReadonlyMap<string, FrontmatterValue>, string | null] {
  let parsed: unknown;
  try {
    parsed = loadYaml(rawFrontmatter);
  } catch (error) {
    return [new Map(), error instanceof Error ? error.message : String(error)];
  }
  if (!isYamlRecord(parsed)) {
    return [new Map(), "frontmatter is not a YAML mapping"];
  }
  const frontmatter = new Map<string, FrontmatterValue>();
  for (const [key, value] of Object.entries(parsed)) {
    const normalizedKey = key.trim();
    if (normalizedKey.length === 0) continue;
    frontmatter.set(normalizedKey, frontmatterValueFromYaml(value));
  }
  return [frontmatter, null];
}

function frontmatterValueFromYaml(value: unknown): FrontmatterValue {
  switch (typeof value) {
    case "string":
      return { type: "scalar", value: value.trim() };
    case "boolean":
    case "number":
      return { type: "scalar", value: String(value) };
    default:
      return { type: "other" };
  }
}

function agentMetadata(document: ParsedDocument): AgentMetadata | null {
  if (document.frontmatterError !== null || document.body.trim().length === 0) {
    return null;
  }
  const name = frontmatterString(document.frontmatter, "name");
  const description = frontmatterString(document.frontmatter, "description");
  if (name === null || description === null) return null;
  return {
    name,
    description,
    permissionMode: frontmatterString(document.frontmatter, "permissionMode"),
    effort: frontmatterString(document.frontmatter, "effort"),
  };
}

function renderAgentToml(
  body: string,
  metadata: AgentMetadata,
  layout: SourceAgentLayout,
): string {
  const normalizedLayout = normalizeSourceAgentLayout(layout);
  const document: Record<string, TomlTable[string]> = {
    name: metadata.name,
    description: rewriteSourceTerms(metadata.description, normalizedLayout),
    developer_instructions: renderAgentBody(body, normalizedLayout),
  };
  const effort =
    metadata.effort === null ? null : mapAgentReasoningEffort(metadata.effort);
  if (effort !== null) document.model_reasoning_effort = effort;
  const sandboxMode =
    metadata.permissionMode === null
      ? null
      : mapAgentPermissionMode(metadata.permissionMode);
  if (sandboxMode !== null) document.sandbox_mode = sandboxMode;
  return renderTomlDocument(document);
}

function renderAgentBody(
  body: string,
  layout: NormalizedSourceAgentLayout,
): string {
  const rewritten = rewriteSourceTerms(body.trim(), layout);
  return rewritten.length === 0
    ? "No subagent instructions were found."
    : rewritten;
}

function commandSkillName(
  sourceCommands: string,
  sourceFile: string,
  layout: SourceAgentLayout,
): string {
  const normalizedLayout = normalizeSourceAgentLayout(layout);
  return slugifyName(
    `${normalizedLayout.commandSkillPrefix}-${commandSourceName(sourceCommands, sourceFile)}`,
  );
}

function commandSkillNameIfSupported(
  sourceCommands: string,
  sourceFile: string,
  document: ParsedDocument,
  layout: SourceAgentLayout,
): string | null {
  if (basename(sourceFile, extname(sourceFile)) === "README") return null;
  const description = commandSkillDescription(document);
  if (description === null) return null;
  const name = commandSkillName(sourceCommands, sourceFile, layout);
  if ([...name].length > MAX_SKILL_NAME_LEN) return null;
  if ([...description].length > MAX_SKILL_DESCRIPTION_LEN) return null;
  if (hasUnsupportedCommandTemplateFeatures(document.body)) return null;
  return name;
}

function commandSkillDescription(document: ParsedDocument): string | null {
  return frontmatterString(document.frontmatter, "description");
}

function commandSourceName(sourceCommands: string, sourceFile: string): string {
  return relative(sourceCommands, sourceFile)
    .replace(/\.[^/.]+$/, "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .join("-");
}

function renderCommandSkill(
  body: string,
  name: string,
  description: string,
  sourceName: string,
  layout: SourceAgentLayout,
): string {
  const normalizedLayout = normalizeSourceAgentLayout(layout);
  const templateBody = rewriteSourceTerms(body.trim(), normalizedLayout);
  const renderedBody =
    templateBody.length === 0
      ? "No command template body was found."
      : templateBody;
  return `---\nname: ${yamlString(name)}\ndescription: ${yamlString(
    rewriteSourceTerms(description, normalizedLayout),
  )}\n---\n\n# ${name}\n\nUse this skill when the user asks to run the migrated source command \`${sourceName}\`.\n\n## Command Template\n\n${renderedBody}\n`;
}

function hasUnsupportedCommandTemplateFeatures(template: string): boolean {
  return (
    template.includes("$ARGUMENTS") ||
    containsNumberedArgumentPlaceholder(template) ||
    (template.includes("{{") && template.includes("}}")) ||
    template.includes("!`") ||
    template.includes("! `") ||
    template.split(/\s+/).some((token) => /^@.+/.test(token))
  );
}

function containsNumberedArgumentPlaceholder(template: string): boolean {
  return /\$[0-9]/.test(template);
}

function frontmatterString(
  frontmatter: ReadonlyMap<string, FrontmatterValue>,
  key: string,
): string | null {
  const value = frontmatter.get(key);
  if (value?.type !== "scalar") return null;
  const trimmed = value.value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function mapAgentReasoningEffort(effort: string): string | null {
  const mapped = effort === "max" ? "xhigh" : effort;
  return ["none", "minimal", "low", "medium", "high", "xhigh"].includes(mapped)
    ? mapped
    : null;
}

function mapAgentPermissionMode(permissionMode: string): string | null {
  switch (permissionMode) {
    case "acceptEdits":
      return "workspace-write";
    case "readOnly":
      return "read-only";
    default:
      return null;
  }
}

function jsonStringVec(value: JsonValue | undefined): string[] {
  const array = jsonArray(value);
  if (array !== null) return array.map(jsonString).filter((v): v is string => v !== null);
  const scalar = jsonString(value);
  return scalar === null ? [] : [scalar];
}

function jsonString(value: JsonValue | undefined): string | null {
  switch (typeof value) {
    case "string":
      return value;
    case "boolean":
    case "number":
      return String(value);
    default:
      return null;
  }
}

function jsonU64(value: JsonValue | undefined): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return null;
}

function jsonArray(value: JsonValue | undefined): readonly JsonValue[] | null {
  return Array.isArray(value) ? value : null;
}

function jsonObject(value: JsonValue | undefined | null): JsonRecord | null {
  return value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function isYamlRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function slugifyName(value: string): string {
  let slug = "";
  let lastWasDash = false;
  for (const ch of value) {
    if (/[A-Za-z0-9]/.test(ch)) {
      slug += ch.toLowerCase();
      lastWasDash = false;
    } else if (!lastWasDash) {
      slug += "-";
      lastWasDash = true;
    }
  }
  const trimmed = slug.replace(/^-+|-+$/g, "");
  return trimmed.length === 0 ? "migrated" : trimmed;
}

function rewriteSourceTerms(
  content: string,
  layout: NormalizedSourceAgentLayout,
): string {
  let rewritten = replaceCaseInsensitiveWithBoundaries(
    content,
    layout.docFileName,
    "AGENC.md",
  );
  for (const term of layout.termVariants) {
    rewritten = replaceCaseInsensitiveWithBoundaries(rewritten, term, "AgenC");
  }
  return rewritten;
}

function replaceCaseInsensitiveWithBoundaries(
  input: string,
  needle: string,
  replacement: string,
): string {
  if (needle.length === 0) return input;
  const needleLower = needle.toLowerCase();
  const haystackLower = input.toLowerCase();
  let output = "";
  let lastEmitted = 0;
  let searchStart = 0;
  while (searchStart < input.length) {
    const start = haystackLower.indexOf(needleLower, searchStart);
    if (start === -1) break;
    const end = start + needle.length;
    if (
      (start === 0 || !isWordByte(input.charCodeAt(start - 1))) &&
      (end === input.length || !isWordByte(input.charCodeAt(end)))
    ) {
      output += input.slice(lastEmitted, start);
      output += replacement;
      lastEmitted = end;
    }
    searchStart = start + 1;
  }
  return lastEmitted === 0 ? input : output + input.slice(lastEmitted);
}

function isWordByte(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

async function readJsonFile(path: string, label: string): Promise<JsonValue> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as JsonValue;
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function isMissingOrEmptyTextFile(path: string): Promise<boolean> {
  if (!(await pathExists(path))) return true;
  if (!(await isFile(path))) return false;
  return (await readFile(path, "utf8")).trim().length === 0;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function nullProtoRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function isSafeObjectKey(key: string): boolean {
  return !UNSAFE_OBJECT_KEYS.has(key);
}
