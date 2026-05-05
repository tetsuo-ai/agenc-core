import { basename, dirname, resolve } from "node:path";

import {
  AGENT_COLORS,
  type AgentColorName,
} from "../../tools/AgentTool/agentColorManager.js";
import { loadAgentMemoryPrompt } from "../../tools/AgentTool/agentMemory.js";
import type {
  AgentMemoryScope,
  EffortValue,
  PluginAgentDefinition,
} from "../../tools/AgentTool/loadAgentsDir.js";
import type { LoadedPlugin } from "../loader.js";
import {
  collectMarkdownFiles,
  coerceString,
  loadRuntimePlugins,
  markdownStem,
  namespaceFromPath,
  parseBoolean,
  pathIsDirectory,
  readMarkdownFile,
  splitList,
  substitutePluginTemplate,
  type ParsedMarkdownFile,
  type PluginRuntimeLoadOptions,
} from "./common.js";

export interface PluginAgentRegistrationOptions extends PluginRuntimeLoadOptions {
  readonly plugins?: readonly LoadedPlugin[];
}

const VALID_MEMORY_SCOPES: readonly AgentMemoryScope[] = ["user", "project", "local"];
const VALID_EFFORTS = new Set(["none", "low", "medium", "high", "max", "xhigh"]);

let pluginAgentCache: Promise<readonly PluginAgentDefinition[]> | null = null;
const activePluginAgentsByCwd = new Map<string, readonly PluginAgentDefinition[]>();

function activeKey(cwd: string | undefined): string {
  return resolve(cwd ?? process.cwd());
}

export function setActivePluginAgentSnapshot(
  cwd: string,
  agents: readonly PluginAgentDefinition[],
): void {
  activePluginAgentsByCwd.set(activeKey(cwd), [...agents]);
}

function parseTools(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const tools = splitList(value);
  return tools.includes("*") ? undefined : tools;
}

function parseEffort(value: unknown): EffortValue | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  const text = coerceString(value);
  if (!text) return undefined;
  const numeric = Number(text);
  if (Number.isInteger(numeric)) return numeric;
  return VALID_EFFORTS.has(text) ? text as EffortValue : undefined;
}

function parsePositiveInt(value: unknown): number | undefined {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number(value.trim())
      : Number.NaN;
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function parseMemoryScope(value: unknown): AgentMemoryScope | undefined {
  return typeof value === "string" &&
    (VALID_MEMORY_SCOPES as readonly string[]).includes(value)
    ? value as AgentMemoryScope
    : undefined;
}

function parseColor(value: unknown): AgentColorName | undefined {
  return typeof value === "string" && (AGENT_COLORS as readonly string[]).includes(value)
    ? value as AgentColorName
    : undefined;
}

function isAutoMemoryEnabled(): boolean {
  return process.env.AGENC_DISABLE_AUTO_MEMORY !== "1" &&
    process.env.AGENC_SIMPLE !== "1" &&
    process.env.AGENC_SIMPLE !== "true";
}

function agentName(plugin: LoadedPlugin, file: ParsedMarkdownFile): string {
  const frontmatterName = coerceString(file.frontmatter.name);
  const baseName = frontmatterName ?? markdownStem(file.filePath);
  return [plugin.name, ...namespaceFromPath(file.filePath, file.baseDir), baseName]
    .join(":");
}

function createPluginAgent(
  plugin: LoadedPlugin,
  file: ParsedMarkdownFile,
): PluginAgentDefinition | null {
  const agentType = agentName(plugin, file);
  const whenToUse =
    coerceString(file.frontmatter.description) ??
    coerceString(file.frontmatter["when-to-use"]) ??
    `Agent from ${plugin.name} plugin`;
  const memory = parseMemoryScope(file.frontmatter.memory);
  const systemPrompt = substitutePluginTemplate(file.markdown.trim(), plugin);
  const tools = parseTools(file.frontmatter.tools);
  const disallowedTools =
    file.frontmatter.disallowedTools !== undefined
      ? parseTools(file.frontmatter.disallowedTools)
      : undefined;
  const skills = splitList(file.frontmatter.skills);
  const model = coerceString(file.frontmatter.model);
  const effort = parseEffort(file.frontmatter.effort);
  const maxTurns = parsePositiveInt(file.frontmatter.maxTurns);
  const background = parseBoolean(file.frontmatter.background);
  const isolation = file.frontmatter.isolation === "worktree" ? "worktree" : undefined;

  return {
    agentType,
    whenToUse,
    source: "plugin",
    filename: basename(file.filePath, ".md"),
    baseDir: file.baseDir,
    plugin: plugin.source,
    getSystemPrompt: () => {
      if (!memory || !isAutoMemoryEnabled()) return systemPrompt;
      return `${systemPrompt}\n\n${loadAgentMemoryPrompt(agentType, memory)}`;
    },
    ...(tools !== undefined ? { tools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(parseColor(file.frontmatter.color) !== undefined
      ? { color: parseColor(file.frontmatter.color) }
      : {}),
    ...(model !== undefined ? { model: model.toLowerCase() === "inherit" ? "inherit" : model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(background ? { background } : {}),
    ...(memory !== undefined ? { memory } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}

async function loadAgentFile(
  plugin: LoadedPlugin,
  path: string,
  baseDir: string,
  loadedPaths: Set<string>,
): Promise<PluginAgentDefinition | null> {
  if (loadedPaths.has(path)) return null;
  loadedPaths.add(path);
  const file = await readMarkdownFile(path, baseDir);
  return file ? createPluginAgent(plugin, file) : null;
}

async function loadAgentsFromPath(
  plugin: LoadedPlugin,
  path: string,
  loadedPaths: Set<string>,
): Promise<readonly PluginAgentDefinition[]> {
  if (await pathIsDirectory(path)) {
    const files = await collectMarkdownFiles(path);
    const agents = await Promise.all(
      files.map((filePath) => loadAgentFile(plugin, filePath, path, loadedPaths)),
    );
    return agents.filter((agent): agent is PluginAgentDefinition => agent !== null);
  }
  if (!path.toLowerCase().endsWith(".md")) return [];
  const agent = await loadAgentFile(plugin, path, dirname(path), loadedPaths);
  return agent ? [agent] : [];
}

async function loadAgentsForPlugin(
  plugin: LoadedPlugin,
): Promise<readonly PluginAgentDefinition[]> {
  const loadedPaths = new Set<string>();
  const paths = [...new Set(plugin.agentsPaths)];
  const groups = await Promise.all(
    paths.map((path) => loadAgentsFromPath(plugin, path, loadedPaths)),
  );
  return groups.flat();
}

async function resolvePlugins(
  options: PluginAgentRegistrationOptions,
): Promise<readonly LoadedPlugin[]> {
  return options.plugins ?? await loadRuntimePlugins(options);
}

export async function loadPluginAgents(
  options: PluginAgentRegistrationOptions = {},
): Promise<readonly PluginAgentDefinition[]> {
  if (options.plugins === undefined) {
    const active = activePluginAgentsByCwd.get(activeKey(options.cwd));
    if (active !== undefined) return active;
  }
  const plugins = await resolvePlugins(options);
  const groups = await Promise.all(plugins.map(loadAgentsForPlugin));
  return groups.flat().sort((a, b) => a.agentType.localeCompare(b.agentType));
}

export async function getPluginAgents(): Promise<readonly PluginAgentDefinition[]> {
  pluginAgentCache ??= loadPluginAgents();
  return pluginAgentCache;
}

export function clearPluginAgentCache(): void {
  pluginAgentCache = null;
}
