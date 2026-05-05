import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import type { Command } from "../../commands.js";
import type { LoadedPlugin, LoadedPluginCommand } from "../loader.js";
import type { PluginCommandMetadata } from "../manifest-schema.js";
import { isRecord } from "../manifest-schema.js";
import {
  collectMarkdownFiles,
  coerceString,
  descriptionFromMarkdown,
  loadRuntimePlugins,
  markdownStem,
  parseBoolean,
  pathIsDirectory,
  readMarkdownFile,
  splitFrontmatter,
  splitList,
  substituteArguments,
  substitutePluginTemplate,
  type ParsedMarkdownFile,
  type PluginRuntimeLoadOptions,
} from "./common.js";

export interface PluginCommandRegistrationOptions extends PluginRuntimeLoadOptions {
  readonly plugins?: readonly LoadedPlugin[];
  readonly sessionId?: string;
}

interface PluginMarkdownCommand {
  readonly plugin: LoadedPlugin;
  readonly file: ParsedMarkdownFile;
  readonly metadata?: PluginCommandMetadata;
  readonly declaredName?: string;
  readonly isSkillMode: boolean;
}

let pluginCommandCache: Promise<readonly Command[]> | null = null;
let pluginSkillCache: Promise<readonly Command[]> | null = null;

function isSkillFile(filePath: string): boolean {
  return basename(filePath).toLowerCase() === "skill.md";
}

function commandNameFromFile(
  file: ParsedMarkdownFile,
  pluginName: string,
): string {
  const namespace = namespaceFromCommandPath(file.filePath, file.baseDir);
  const name = markdownStem(file.filePath);
  return [pluginName, ...namespace, name].join(":");
}

function skillNameFromFile(
  file: ParsedMarkdownFile,
  pluginName: string,
): string {
  const skillDir = dirname(file.filePath);
  const parentDir = dirname(skillDir);
  const rel = relative(file.baseDir, parentDir);
  const namespace =
    !rel || rel === "." || rel.startsWith("..")
      ? []
      : rel.split(sep).filter((part) => part.length > 0);
  return [pluginName, ...namespace, basename(skillDir)].join(":");
}

function namespaceFromCommandPath(filePath: string, baseDir: string): readonly string[] {
  const rel = relative(baseDir, dirname(filePath));
  if (!rel || rel === "." || rel.startsWith("..")) return [];
  return rel.split(sep).filter((part) => part.length > 0);
}

function commandDisplayName(commandName: string, frontmatter: Record<string, unknown>): string {
  return coerceString(frontmatter.name) ?? commandName;
}

function metadataFrontmatter(
  frontmatter: Record<string, unknown>,
  metadata: PluginCommandMetadata | undefined,
): Record<string, unknown> {
  if (!metadata) return frontmatter;
  return {
    ...frontmatter,
    ...(metadata.description !== undefined ? { description: metadata.description } : {}),
    ...(metadata.argumentHint !== undefined ? { "argument-hint": metadata.argumentHint } : {}),
    ...(metadata.model !== undefined ? { model: metadata.model } : {}),
    ...(metadata.allowedTools !== undefined ? { "allowed-tools": [...metadata.allowedTools] } : {}),
  };
}

function normalizedToolList(
  plugin: LoadedPlugin,
  value: unknown,
): readonly string[] | undefined {
  const tools = splitToolList(value)
    .map((tool) => substitutePluginTemplate(tool, plugin))
    .filter((tool) => tool.length > 0);
  return tools.length > 0 ? tools : undefined;
}

function splitToolList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(coerceString)
      .filter((entry): entry is string => entry !== undefined);
  }
  const raw = coerceString(value);
  if (!raw) return [];
  return raw
    .split(/[,\n]/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function sessionIdFromContext(
  context: unknown,
  fallback: string | undefined,
): string | undefined {
  if (fallback !== undefined) return fallback;
  if (!isRecord(context)) return undefined;
  const direct = context.sessionId ?? context.session_id;
  return typeof direct === "string" ? direct : undefined;
}

function maybeShell(value: unknown): "bash" | "powershell" | undefined {
  return value === "bash" || value === "powershell" ? value : undefined;
}

function createPluginCommand(
  entry: PluginMarkdownCommand,
  options: PluginCommandRegistrationOptions,
): Command | null {
  const { plugin, file, metadata, isSkillMode } = entry;
  const frontmatter = metadataFrontmatter(file.frontmatter, metadata);
  const commandName =
    entry.declaredName ??
    (isSkillFile(file.filePath)
      ? skillNameFromFile(file, plugin.name)
      : commandNameFromFile(file, plugin.name));
  const description =
    coerceString(frontmatter.description) ??
    descriptionFromMarkdown(file.markdown) ??
    (isSkillMode ? `Plugin skill ${commandName}` : `Plugin command ${commandName}`);
  const rawAllowedTools =
    frontmatter["allowed-tools"] ??
    frontmatter.allowedTools ??
    metadata?.allowedTools;
  const argNames = splitList(frontmatter.arguments ?? frontmatter.argNames);
  const userInvocable =
    frontmatter["user-invocable"] === undefined
      ? true
      : parseBoolean(frontmatter["user-invocable"], true);
  const model = coerceString(frontmatter.model);
  const progressMessage = isSkillMode || isSkillFile(file.filePath)
    ? "loading"
    : "running";
  const skillBaseDir = dirname(file.filePath);

  return {
    type: "prompt",
    name: commandName,
    description,
    aliases: splitList(frontmatter.aliases),
    argumentHint: coerceString(frontmatter["argument-hint"] ?? frontmatter.argumentHint),
    argNames: argNames.length > 0 ? argNames : undefined,
    allowedTools: normalizedToolList(plugin, rawAllowedTools),
    whenToUse: coerceString(frontmatter.when_to_use ?? frontmatter.whenToUse),
    version: coerceString(frontmatter.version),
    model: model === "inherit" ? undefined : model,
    effort: coerceString(frontmatter.effort),
    disableModelInvocation: parseBoolean(frontmatter["disable-model-invocation"]),
    userInvocable,
    isHidden: !userInvocable,
    hasUserSpecifiedDescription: frontmatter.description !== undefined,
    contentLength: file.markdown.length,
    source: "plugin",
    loadedFrom: "plugin",
    pluginInfo: {
      pluginManifest: plugin.manifest,
    },
    progressMessage,
    shell: maybeShell(frontmatter.shell),
    userFacingName: () => commandDisplayName(commandName, frontmatter),
    getPromptForCommand: async (args, context) => {
      let content = isSkillMode || isSkillFile(file.filePath)
        ? `Base directory for this skill: ${skillBaseDir}\n\n${file.markdown}`
        : file.markdown;
      content = substituteArguments(content, args, argNames);
      content = substitutePluginTemplate(content, plugin, {
        sessionId: sessionIdFromContext(context, options.sessionId),
      });
      if (isSkillMode || isSkillFile(file.filePath)) {
        content = content.replace(/\$\{AGENC_SKILL_DIR\}/g, skillBaseDir);
      }
      return [{ type: "text", text: content }];
    },
  };
}

async function readCommandPath(
  plugin: LoadedPlugin,
  command: LoadedPluginCommand,
  loadedPaths: Set<string>,
): Promise<PluginMarkdownCommand[]> {
  if (command.content !== undefined) {
    const parsed = splitFrontmatter(command.content);
    return [{
      plugin,
      file: {
        filePath: `<inline:${plugin.name}:${command.name}>`,
        baseDir: plugin.root,
        frontmatter: parsed.frontmatter,
        markdown: parsed.markdown,
      },
      metadata: command.metadata,
      declaredName: `${plugin.name}:${command.name}`,
      isSkillMode: false,
    }];
  }
  if (command.path === undefined) return [];
  if (await pathIsDirectory(command.path)) {
    const commandPath = command.path;
    const files = await collectMarkdownFiles(command.path);
    return Promise.all(
      files.map(async (filePath) =>
        readFileAsCommand(plugin, filePath, commandPath, loadedPaths, command.metadata),
      ),
    ).then((entries) => entries.filter((entry): entry is PluginMarkdownCommand => entry !== null));
  }
  const baseDir = plugin.commandsPath && command.path.startsWith(`${plugin.commandsPath}${sep}`)
    ? plugin.commandsPath
    : dirname(command.path);
  const declaredName = command.name === markdownStem(command.path)
    ? undefined
    : `${plugin.name}:${command.name}`;
  return [
    await readFileAsCommand(
      plugin,
      command.path,
      baseDir,
      loadedPaths,
      command.metadata,
      declaredName,
    ),
  ].filter((entry): entry is PluginMarkdownCommand => entry !== null);
}

async function readFileAsCommand(
  plugin: LoadedPlugin,
  filePath: string,
  baseDir: string,
  loadedPaths: Set<string>,
  metadata: PluginCommandMetadata | undefined,
  declaredName?: string,
): Promise<PluginMarkdownCommand | null> {
  if (loadedPaths.has(filePath)) return null;
  loadedPaths.add(filePath);
  const file = await readMarkdownFile(filePath, baseDir);
  if (!file) return null;
  return {
    plugin,
    file,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(declaredName !== undefined ? { declaredName } : {}),
    isSkillMode: false,
  };
}

async function loadPluginCommandEntries(
  plugin: LoadedPlugin,
): Promise<readonly PluginMarkdownCommand[]> {
  const loadedPaths = new Set<string>();
  const groups = await Promise.all(
    plugin.commands.map((command) => readCommandPath(plugin, command, loadedPaths)),
  );
  return groups.flat();
}

async function loadSkillEntriesFromPath(
  plugin: LoadedPlugin,
  skillsPath: string,
  loadedPaths: Set<string>,
): Promise<readonly PluginMarkdownCommand[]> {
  const paths = skillsPath.toLowerCase().endsWith(".md")
    ? [skillsPath]
    : await collectMarkdownFiles(skillsPath);
  const entries = await Promise.all(
    paths
      .filter((filePath) => isSkillFile(filePath))
      .map(async (filePath): Promise<PluginMarkdownCommand | null> => {
        if (loadedPaths.has(filePath)) return null;
        loadedPaths.add(filePath);
        const baseDir = skillsPath.toLowerCase().endsWith(".md")
          ? dirname(skillsPath)
          : skillsPath;
        const file = await readMarkdownFile(filePath, baseDir);
        return file
          ? {
              plugin,
              file,
              isSkillMode: true,
            } satisfies PluginMarkdownCommand
          : null;
      }),
  );
  return entries.filter((entry): entry is PluginMarkdownCommand => entry !== null);
}

async function loadPluginSkillEntries(
  plugin: LoadedPlugin,
): Promise<readonly PluginMarkdownCommand[]> {
  const loadedPaths = new Set<string>();
  const paths = [...new Set(plugin.skillsPaths)];
  const groups = await Promise.all(
    paths.map((skillsPath) => loadSkillEntriesFromPath(plugin, skillsPath, loadedPaths)),
  );
  return groups.flat();
}

async function resolvePlugins(
  options: PluginCommandRegistrationOptions,
): Promise<readonly LoadedPlugin[]> {
  return options.plugins ?? await loadRuntimePlugins(options);
}

export async function loadPluginCommands(
  options: PluginCommandRegistrationOptions = {},
): Promise<readonly Command[]> {
  const plugins = await resolvePlugins(options);
  const groups = await Promise.all(plugins.map(loadPluginCommandEntries));
  return groups
    .flat()
    .map((entry) => createPluginCommand(entry, options))
    .filter((command): command is Command => command !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadPluginSkills(
  options: PluginCommandRegistrationOptions = {},
): Promise<readonly Command[]> {
  const plugins = await resolvePlugins(options);
  const groups = await Promise.all(plugins.map(loadPluginSkillEntries));
  return groups
    .flat()
    .map((entry) => createPluginCommand(entry, options))
    .filter((command): command is Command => command !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getPluginCommands(): Promise<readonly Command[]> {
  pluginCommandCache ??= loadPluginCommands();
  return pluginCommandCache;
}

export async function getPluginSkills(): Promise<readonly Command[]> {
  pluginSkillCache ??= loadPluginSkills();
  return pluginSkillCache;
}

export function clearPluginCommandCache(): void {
  pluginCommandCache = null;
}

export function clearPluginSkillsCache(): void {
  pluginSkillCache = null;
}

export function registerPluginCommandProvider(
  registerCommandProvider: (
    provider: (cwd: string) => Promise<readonly Command[]> | readonly Command[],
  ) => () => void,
  options: PluginCommandRegistrationOptions = {},
): () => void {
  return registerCommandProvider((cwd) => loadPluginCommands({ ...options, cwd }));
}

async function readTextIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function loadPluginSkillDirectory(
  plugin: LoadedPlugin,
  directory: string,
): Promise<readonly Command[]> {
  const directSkill = join(directory, "SKILL.md");
  const loadedPaths = new Set<string>();
  const raw = await readTextIfPresent(directSkill);
  if (raw !== null) {
    const parsed = splitFrontmatter(raw);
    const command = createPluginCommand(
      {
        plugin,
        file: {
          filePath: directSkill,
          baseDir: dirname(directSkill),
          frontmatter: parsed.frontmatter,
          markdown: parsed.markdown,
        },
        isSkillMode: true,
      },
      {},
    );
    return command ? [command] : [];
  }
  const entries = await loadSkillEntriesFromPath(plugin, directory, loadedPaths);
  return entries
    .map((entry) => createPluginCommand(entry, {}))
    .filter((command): command is Command => command !== null);
}
