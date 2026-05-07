import type * as React from "react";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { buildDefaultRegistry } from "./commands/registry.js";
import memoryLocalCommand from "./commands/memory/index.js";
import type {
  SlashCommand,
  SlashCommandAppStateBridge,
  SlashCommandContext,
  SlashCommandResult,
} from "./commands/types.js";
import {
  createLocalSkillsServices,
  type LocalSkillMetadata,
} from "./skills/local-loader.js";
import {
  loadPluginCommands,
  loadPluginSkills,
} from "./plugins/registration/load-plugin-commands.js";
import { clearPluginRegistrationCaches } from "./plugins/registration/manager.js";
import type { AgenCConfig } from "./config/schema.js";

export type LocalCommandResult =
  | { type: "text"; value: string }
  | { type: "compact"; compactionResult?: unknown; displayText?: string }
  | { type: "skip" };

type PluginConfigSurface = Pick<AgenCConfig, "plugins" | "enabledPlugins">;

export type CommandResultDisplay = "skip" | "system" | "user";

export type LocalJSXCommandOnDone = (
  result?: string,
  options?: {
    display?: CommandResultDisplay;
    shouldQuery?: boolean;
    metaMessages?: string[];
    nextInput?: string;
    submitNextInput?: boolean;
  },
) => void;

export type ResumeEntrypoint =
  | "cli_flag"
  | "slash_command_picker"
  | "slash_command_session_id"
  | "slash_command_title"
  | "fork";

export type LocalJSXCommandContext = {
  getAppState?: () => unknown;
  setAppState?: (updater: (prev: never) => never) => void;
  setMessages?: (updater: (prev: unknown[]) => unknown[]) => void;
  options?: Record<string, unknown>;
  resume?: (
    sessionId: string,
    log: unknown,
    entrypoint: ResumeEntrypoint,
  ) => Promise<void>;
  [key: string]: unknown;
};

export type PromptCommand = {
  type: "prompt";
  progressMessage: string;
  contentLength: number;
  argNames?: readonly string[];
  allowedTools?: readonly string[];
  model?: string;
  source?: string;
  disableNonInteractive?: boolean;
  disableModelInvocation?: boolean;
  hasUserSpecifiedDescription?: boolean;
  whenToUse?: string;
  context?: string;
  agent?: string;
  effort?: string;
  shell?: "bash" | "powershell";
  getPromptForCommand?: (
    args: string,
    context: unknown,
  ) => Promise<unknown[]>;
};

export type LocalCommand = {
  type: "local";
  supportsNonInteractive?: boolean;
  load: () => Promise<{
    call: (
      args: string,
      context: LocalJSXCommandContext,
    ) => Promise<LocalCommandResult>;
  }>;
};

export type LocalJSXCommand = {
  type: "local-jsx";
  load: () => Promise<{
    call: (
      onDone: LocalJSXCommandOnDone,
      context: LocalJSXCommandContext,
      args: string,
    ) => Promise<React.ReactNode>;
  }>;
};

export type CommandBase = {
  description: string;
  hasUserSpecifiedDescription?: boolean;
  isEnabled?: () => boolean;
  isHidden?: boolean;
  name: string;
  aliases?: string[];
  isMcp?: boolean;
  argumentHint?: string;
  whenToUse?: string;
  version?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  loadedFrom?: string;
  kind?: string;
  source?: string;
  pluginInfo?: {
    pluginManifest?: {
      name?: string;
    };
  };
  availability?: readonly string[];
  immediate?: boolean;
  isSensitive?: boolean;
  userFacingName?: () => string;
};

export type Command = CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function legacyString(
  legacyContext: LocalJSXCommandContext,
  key: string,
): string | undefined {
  const value = legacyContext[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function legacySlashContext(
  args: string,
  legacyContext: LocalJSXCommandContext,
): SlashCommandContext | null {
  const session = legacyContext.session;
  if (!isRecord(session) || !isRecord(session.services)) return null;

  const sessionConfiguration = isRecord(session.sessionConfiguration)
    ? session.sessionConfiguration
    : {};
  const cwd =
    legacyString(legacyContext, "cwd") ??
    (typeof sessionConfiguration.cwd === "string"
      ? sessionConfiguration.cwd
      : process.cwd());
  const services = session.services as Record<string, unknown>;
  const configStore =
    legacyContext.configStore ?? services.configStore;
  const getAppState = legacyContext.getAppState;
  const setAppState = legacyContext.setAppState;
  const appStateBridge = isRecord(legacyContext.appState)
    ? (legacyContext.appState as SlashCommandAppStateBridge)
    : undefined;
  const appState =
    appStateBridge !== undefined ||
    typeof getAppState === "function" ||
    typeof setAppState === "function"
      ? {
          ...(appStateBridge ?? {}),
          ...(typeof getAppState === "function" &&
          appStateBridge?.getAppState === undefined
            ? { getAppState: getAppState as () => unknown }
            : {}),
          ...(typeof setAppState === "function" &&
          appStateBridge?.setAppState === undefined
            ? {
                setAppState: setAppState as unknown as (
                  updater: (prev: unknown) => unknown,
                ) => void,
              }
            : {}),
        }
      : undefined;

  return {
    session: session as unknown as SlashCommandContext["session"],
    argsRaw: args,
    cwd,
    home: legacyString(legacyContext, "home") ?? process.env.HOME ?? cwd,
    ...(legacyString(legacyContext, "agencHome")
      ? { agencHome: legacyString(legacyContext, "agencHome") }
      : {}),
    ...(configStore ? { configStore: configStore as SlashCommandContext["configStore"] } : {}),
    ...(appState ? { appState } : {}),
  };
}

function localResultFromSlashResult(result: SlashCommandResult): LocalCommandResult {
  switch (result.kind) {
    case "text":
      return { type: "text", value: result.text };
    case "compact":
      return { type: "compact", displayText: result.text };
    case "skip":
      return { type: "skip" };
    case "prompt":
      throw new Error(
        "This slash command produced a follow-up prompt, which the legacy local-command adapter cannot submit.",
      );
    case "exit":
      return { type: "text", value: `Exit requested with code ${result.code}.` };
    case "error":
      return { type: "text", value: result.message };
  }
}

export function projectSlashCommand(cmd: SlashCommand): Command {
  return {
    type: "local",
    name: cmd.name,
    description: cmd.description,
    aliases: cmd.aliases ? [...cmd.aliases] : undefined,
    isEnabled: cmd.isEnabled,
    immediate: cmd.immediate,
    userInvocable: cmd.userInvocable,
    supportsNonInteractive: cmd.supportsNonInteractive ?? false,
    load: async () => {
      const { dispatchSlashCommand } = await import("./commands/dispatcher.js");
      return {
        call: async (
          args: string,
          legacyContext: LocalJSXCommandContext,
        ): Promise<LocalCommandResult> => {
          const ctx = legacySlashContext(args, legacyContext);
          if (!ctx) {
            return {
              type: "text",
              value:
                `/${cmd.name} is handled by the AgenC runtime dispatcher ` +
                "and requires a live session context.",
            };
          }
          const outcome = await dispatchSlashCommand(
            { name: cmd.name, argsRaw: args, isMcp: false },
            ctx,
            buildDefaultRegistry(),
          );
          return localResultFromSlashResult(outcome.result);
        },
      };
    },
  };
}

export function getCommandName(cmd: CommandBase): string {
  return cmd.userFacingName?.() ?? cmd.name;
}

export function isCommandEnabled(cmd: CommandBase): boolean {
  return cmd.isEnabled?.() ?? true;
}

let projectedCommandCache: Command[] | null = null;
const LOCAL_JSX_COMMAND_OVERRIDES = new Map<string, Command>([
  [memoryLocalCommand.name, memoryLocalCommand],
]);
const commandProviders = new Set<
  (cwd: string) => Promise<readonly Command[]> | readonly Command[]
>();
const localSkillServicesByRoot = new Map<
  string,
  ReturnType<typeof createLocalSkillsServices>
>();

function builtInCommands(): readonly Command[] {
  projectedCommandCache ??= buildDefaultRegistry().list().map(projectSlashCommand);
  return projectedCommandCache.map(
    command => LOCAL_JSX_COMMAND_OVERRIDES.get(command.name) ?? command,
  );
}

export function registerCommandProvider(
  provider: (cwd: string) => Promise<readonly Command[]> | readonly Command[],
): () => void {
  commandProviders.add(provider);
  return () => {
    commandProviders.delete(provider);
  };
}

function localSkillsKey(cwd: string): string {
  const agencHome = process.env.AGENC_HOME ?? join(homedir(), ".agenc");
  return `${resolve(cwd)}\u0000${resolve(agencHome)}`;
}

function localSkillServices(cwd: string): ReturnType<typeof createLocalSkillsServices> {
  const key = localSkillsKey(cwd);
  let services = localSkillServicesByRoot.get(key);
  if (!services) {
    const [workspaceRoot, agencHome] = key.split("\u0000") as [string, string];
    services = createLocalSkillsServices({ workspaceRoot, agencHome });
    localSkillServicesByRoot.set(key, services);
  }
  return services;
}

function projectLocalSkill(
  skill: LocalSkillMetadata,
  services: ReturnType<typeof createLocalSkillsServices>,
): Command {
  return {
    type: "prompt",
    name: skill.name,
    description: skill.description,
    aliases: skill.aliases ? [...skill.aliases] : undefined,
    progressMessage: "running",
    contentLength: skill.contentLength,
    argNames: skill.argNames,
    allowedTools: skill.allowedTools,
    model: skill.model,
    source: skill.source,
    loadedFrom: skill.loadedFrom,
    hasUserSpecifiedDescription: skill.hasUserSpecifiedDescription,
    disableModelInvocation: skill.disableModelInvocation,
    userInvocable: skill.userInvocable,
    argumentHint: skill.argumentHint,
    whenToUse: skill.whenToUse,
    version: skill.version,
    context: skill.context,
    agent: skill.agent,
    effort: skill.effort,
    shell: skill.shell,
    userFacingName: () => skill.displayName ?? skill.name,
    getPromptForCommand: async (args, context) => {
      void context;
      const rendered = await services.skillsManager.renderSkill?.({
        name: skill.name,
        args,
      });
      const content = rendered?.content ?? "";
      return [{ type: "text", text: content }];
    },
  };
}

async function loadLocalSkillCommands(
  cwd: string,
  config: unknown = {},
): Promise<readonly Command[]> {
  try {
    const services = localSkillServices(cwd);
    const outcome = await services.skillsManager.skillsForConfig(config, null);
    return (outcome.availableSkills ?? []).map(skill =>
      projectLocalSkill(skill as LocalSkillMetadata, services),
    );
  } catch {
    return [];
  }
}

function commandArray(value: unknown): Command[] {
  return Array.isArray(value) ? (value as Command[]) : [];
}

async function callCommandSource(
  modulePath: string,
  exportName: string,
  ...args: readonly unknown[]
): Promise<Command[]> {
  try {
    const loaded = await import(modulePath) as Record<string, unknown>;
    const fn = loaded[exportName];
    if (typeof fn !== "function") return [];
    return commandArray(await fn(...args));
  } catch {
    return [];
  }
}

async function loadProductionCommandSources(
  cwd: string,
  config?: PluginConfigSurface,
): Promise<readonly Command[]> {
  const skillsModulePath = "./skills/loadSkillsDir.js";
  const bundledSkillsModulePath = "./skills/bundledSkills.js";
  const builtinPluginsModulePath = "./plugins/builtinPlugins.js";
  const workflowCommandsModulePath =
    "./tools/WorkflowTool/createWorkflowCommand.js";

  const [
    skillDirCommands,
    dynamicSkills,
    bundledSkills,
    builtinPluginSkills,
    pluginCommands,
    pluginSkills,
    workflowCommands,
  ] = await Promise.all([
    callCommandSource(skillsModulePath, "getSkillDirCommands", cwd),
    callCommandSource(skillsModulePath, "getDynamicSkills"),
    callCommandSource(bundledSkillsModulePath, "getBundledSkills"),
    callCommandSource(builtinPluginsModulePath, "getBuiltinPluginSkillCommands"),
    loadPluginCommands({ cwd, config }),
    loadPluginSkills({ cwd, config }),
    callCommandSource(workflowCommandsModulePath, "getWorkflowCommands", cwd),
  ]);

  return [
    ...bundledSkills,
    ...builtinPluginSkills,
    ...skillDirCommands,
    ...dynamicSkills,
    ...workflowCommands,
    ...pluginCommands,
    ...pluginSkills,
  ];
}

export function getCommandsSync(): Command[] {
  return [...builtInCommands()];
}

export function listTuiCommandList(): readonly Command[] {
  return getCommandsSync().filter(
    cmd => cmd.userInvocable !== false && isCommandEnabled(cmd),
  );
}

export async function getCommands(
  cwd: string,
  config: unknown = {},
): Promise<Command[]> {
  const pluginConfig = pluginConfigSurface(config);
  const dynamicCommands = await Promise.all(
    [
      loadLocalSkillCommands(cwd, config),
      loadProductionCommandSources(cwd, pluginConfig),
      ...[...commandProviders].map(async provider => [...(await provider(cwd))]),
    ],
  );
  const commands = [...dynamicCommands.flat(), ...builtInCommands()];
  const seen = new Set<string>();
  return commands.filter(command => {
    if (!isCommandEnabled(command)) return false;
    const key = command.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pluginConfigSurface(config: unknown): PluginConfigSurface | undefined {
  return typeof config === "object" && config !== null && !Array.isArray(config)
    ? config as PluginConfigSurface
    : undefined;
}

export function findCommand(
  commandName: string,
  commands: readonly Command[],
): Command | undefined {
  return commands.find(
    command =>
      command.name === commandName ||
      getCommandName(command) === commandName ||
      command.aliases?.includes(commandName),
  );
}

export function hasCommand(
  commandName: string,
  commands: readonly Command[],
): boolean {
  return findCommand(commandName, commands) !== undefined;
}

export function getCommand(
  commandName: string,
  commands: readonly Command[],
): Command {
  const command = findCommand(commandName, commands);
  if (!command) {
    throw new ReferenceError(
      `Command ${commandName} not found. Available commands: ${commands
        .map(command => {
          const name = getCommandName(command);
          return command.aliases
            ? `${name} (aliases: ${command.aliases.join(", ")})`
            : name;
        })
        .sort((a, b) => a.localeCompare(b))
        .join(", ")}`,
    );
  }
  return command;
}

const builtInCommandNameSet = new Set(
  getCommandsSync().flatMap(command => [
    command.name,
    ...(command.aliases ?? []),
  ]),
);

export function builtInCommandNames(): Set<string> {
  return builtInCommandNameSet;
}

const commandByName = (name: string): Command | undefined =>
  builtInCommands().find(command => command.name === name);

export const INTERNAL_ONLY_COMMANDS: Command[] = [];

const REMOTE_SAFE_COMMAND_NAMES = new Set([
  "exit",
  "clear",
  "help",
  "plan",
  "keybindings",
  "copy",
  "status",
  "cost",
  "usage",
]);

const BRIDGE_SAFE_COMMAND_NAMES = new Set([
  "compact",
  "clear",
  "cost",
  "release-notes",
  "files",
]);

function commandsForNames(names: ReadonlySet<string>): Set<Command> {
  return new Set(
    [...names]
      .map(commandByName)
      .filter((command): command is Command => command !== undefined),
  );
}

export const REMOTE_SAFE_COMMANDS: Set<Command> = commandsForNames(
  REMOTE_SAFE_COMMAND_NAMES,
);

export const BRIDGE_SAFE_COMMANDS: Set<Command> = commandsForNames(
  BRIDGE_SAFE_COMMAND_NAMES,
);

function commandMatchesNameSet(
  command: Command,
  names: ReadonlySet<string>,
): boolean {
  return (
    names.has(command.name) ||
    names.has(getCommandName(command)) ||
    (command.aliases ?? []).some(alias => names.has(alias))
  );
}

export function filterCommandsForRemoteMode(commands: Command[]): Command[] {
  return commands.filter(command =>
    commandMatchesNameSet(command, REMOTE_SAFE_COMMAND_NAMES),
  );
}

export function isBridgeSafeCommand(cmd: Command): boolean {
  if (cmd.type === "local-jsx") return false;
  if (cmd.type === "prompt") return true;
  return commandMatchesNameSet(cmd, BRIDGE_SAFE_COMMAND_NAMES);
}

export async function getSkillToolCommands(
  cwd: string,
  config: unknown = {},
): Promise<Command[]> {
  const allCommands = await getCommands(cwd, config);
  return allCommands.filter(
    command =>
      command.type === "prompt" &&
      !command.disableModelInvocation &&
      command.source !== "builtin" &&
      (command.loadedFrom === "bundled" ||
        command.loadedFrom === "skills" ||
        command.loadedFrom === "commands_DEPRECATED" ||
        command.hasUserSpecifiedDescription ||
        command.whenToUse),
  );
}

getSkillToolCommands.cache = {
  clear() {},
};

export async function getSlashCommandToolSkills(
  cwd: string,
  config: unknown = {},
): Promise<Command[]> {
  try {
    const allCommands = await getCommands(cwd, config);
    return allCommands.filter(
      command =>
        command.type === "prompt" &&
        command.source !== "builtin" &&
        (command.hasUserSpecifiedDescription || command.whenToUse) &&
        (command.loadedFrom === "skills" ||
          command.loadedFrom === "plugin" ||
          command.loadedFrom === "bundled" ||
          command.disableModelInvocation),
    );
  } catch {
    return [];
  }
}

getSlashCommandToolSkills.cache = {
  clear() {},
};

export function getMcpSkillCommands(
  mcpCommands: readonly Command[],
): readonly Command[] {
  return mcpCommands.filter(
    command =>
      command.type === "prompt" &&
      command.loadedFrom === "mcp" &&
      !command.disableModelInvocation,
  );
}

export function clearCommandMemoizationCaches(): void {
  for (const services of localSkillServicesByRoot.values()) {
    services.skillsManager.clearSkillCaches?.();
  }
  localSkillServicesByRoot.clear();
  const skillsModulePath: string = "./skills/loadSkillsDir.js";
  void import(skillsModulePath).then(module => {
    module.clearSkillCaches?.();
  }).catch(() => undefined);
  clearPluginRegistrationCaches();
  getSkillToolCommands.cache.clear();
  getSlashCommandToolSkills.cache.clear();
}

export function clearCommandsCache(): void {
  clearCommandMemoizationCaches();
}

export function formatDescriptionWithSource(cmd: Command): string {
  if (cmd.type !== "prompt") return cmd.description ?? "";
  if (cmd.kind === "workflow") return `${cmd.description ?? ""} (workflow)`;
  if (cmd.source === "plugin") {
    const pluginName = cmd.pluginInfo?.pluginManifest?.name;
    return pluginName
      ? `(${pluginName}) ${cmd.description ?? ""}`
      : `${cmd.description ?? ""} (plugin)`;
  }
  if (cmd.source === "bundled") return `${cmd.description ?? ""} (bundled)`;
  if (!cmd.source || cmd.source === "builtin" || cmd.source === "mcp") {
    return cmd.description ?? "";
  }
  return `${cmd.description ?? ""} (${cmd.source})`;
}
