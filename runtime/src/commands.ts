import type * as React from "react";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { buildDefaultRegistry } from "./commands/registry.js";
import type {
  CommandRegistry as SlashCommandRegistry,
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
import { isRecord } from "./utils/record.js";

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

function projectSlashCommand(
  cmd: SlashCommand,
  registry?: SlashCommandRegistry,
): Command {
  return {
    type: "local",
    name: cmd.name,
    get description() {
      return cmd.description;
    },
    aliases: cmd.aliases ? [...cmd.aliases] : undefined,
    isEnabled: cmd.isEnabled,
    kind: cmd.kind,
    source: cmd.source,
    loadedFrom: cmd.loadedFrom,
    pluginInfo: cmd.pluginInfo,
    get immediate() {
      return cmd.immediate;
    },
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
            registry ?? buildDefaultRegistry(),
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

const commandProviders = new Set<
  (cwd: string) => Promise<readonly Command[]> | readonly Command[]
>();
const localSkillServicesByRoot = new Map<
  string,
  ReturnType<typeof createLocalSkillsServices>
>();

function builtInCommands(registry?: SlashCommandRegistry): readonly Command[] {
  return registry === undefined
    ? (projectedCommandCache ??= buildDefaultRegistry().list().map(command =>
        projectSlashCommand(command),
      ))
    : registry.list().map(command => projectSlashCommand(command, registry));
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

// Loader-based command source. The previous variant accepted a string
// modulePath and called `await import(modulePath)`, which esbuild cannot
// statically discover and silently externalizes. The replacement
// accepts a literal-import loader so the bundler sees the specifier at
// build time.
async function callCommandSource(
  loadModule: () => Promise<Record<string, unknown>>,
  exportName: string,
  ...args: readonly unknown[]
): Promise<Command[]> {
  try {
    const loaded = await loadModule();
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
  const loadSkills = () =>
    import("./skills/loadSkillsDir.js") as unknown as Promise<Record<string, unknown>>;
  const loadBundledSkills = () =>
    import("./skills/bundledSkills.js") as unknown as Promise<Record<string, unknown>>;
  const loadBuiltinPlugins = () =>
    import("./plugins/builtinPlugins.js") as unknown as Promise<Record<string, unknown>>;

  const [
    skillDirCommands,
    dynamicSkills,
    bundledSkills,
    builtinPluginSkills,
    pluginCommands,
    pluginSkills,
  ] = await Promise.all([
    callCommandSource(loadSkills, "getSkillDirCommands", cwd),
    callCommandSource(loadSkills, "getDynamicSkills"),
    callCommandSource(loadBundledSkills, "getBundledSkills"),
    callCommandSource(loadBuiltinPlugins, "getBuiltinPluginSkillCommands"),
    loadPluginCommands({ cwd, config }),
    loadPluginSkills({ cwd, config }),
  ]);
  // The workflow-commands source previously loaded
  // ./tools/WorkflowTool/createWorkflowCommand.js — that module was
  // removed during the runtime migration, so the dynamic import always
  // failed and returned []. Dropped from the loader list now that esbuild
  // needs literal specifiers; if the workflow source returns, add a
  // literal-import loader and a corresponding bundle entry.
  const workflowCommands: readonly Command[] = [];

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

export function getCommandsSync(registry?: SlashCommandRegistry): Command[] {
  return [...builtInCommands(registry)];
}

export function listTuiCommandList(registry?: SlashCommandRegistry): readonly Command[] {
  return getCommandsSync(registry).filter(
    cmd => cmd.userInvocable !== false && cmd.isHidden !== true && isCommandEnabled(cmd),
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
  return isRecord(config)
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
      getCommandName(command) === commandName,
  ) ?? commands.find(
    command =>
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

export function builtInCommandNames(): Set<string> {
  return new Set(
    getCommandsSync().flatMap(command => [
      command.name,
      ...(command.aliases ?? []),
    ]),
  );
}

const commandByName = (name: string): Command | undefined =>
  builtInCommands().find(command => command.name === name);

const REMOTE_SAFE_COMMAND_NAMES = new Set([
  "exit",
  "clear",
  "help",
  "status",
  "model",
  "provider",
]);

const BRIDGE_SAFE_COMMAND_NAMES = new Set([
  "clear",
  "diff",
  "help",
  "model",
  "provider",
  "status",
]);

function commandsForNames(names: ReadonlySet<string>): Set<Command> {
  return new Set(
    [...names]
      .map(commandByName)
      .filter((command): command is Command => command !== undefined),
  );
}

class LazyCommandSet extends Set<Command> {
  private materialized: Set<Command> | null = null;

  constructor(private readonly names: ReadonlySet<string>) {
    super();
  }

  private commands(): Set<Command> {
    this.materialized ??= commandsForNames(this.names);
    return this.materialized;
  }

  override has(command: Command): boolean {
    return this.commands().has(command);
  }

  override get size(): number {
    return this.commands().size;
  }

  override [Symbol.iterator](): SetIterator<Command> {
    return this.commands()[Symbol.iterator]();
  }

  override values(): SetIterator<Command> {
    return this.commands().values();
  }

  override entries(): SetIterator<[Command, Command]> {
    return this.commands().entries();
  }

  override forEach(
    callbackfn: (value: Command, value2: Command, set: Set<Command>) => void,
    thisArg?: unknown,
  ): void {
    this.commands().forEach((value, value2) => {
      callbackfn.call(thisArg, value, value2, this);
    });
  }
}

export const REMOTE_SAFE_COMMANDS: Set<Command> = new LazyCommandSet(
  REMOTE_SAFE_COMMAND_NAMES,
);

export const BRIDGE_SAFE_COMMANDS: Set<Command> = new LazyCommandSet(
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
