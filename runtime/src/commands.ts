import type * as React from "react";

import { buildDefaultRegistry } from "./commands/registry.js";
import type { SlashCommand } from "./commands/types.js";

export type LocalCommandResult =
  | { type: "text"; value: string }
  | { type: "compact"; compactionResult?: unknown; displayText?: string }
  | { type: "skip" };

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
  argNames?: string[];
  allowedTools?: string[];
  model?: string;
  source?: string;
  disableNonInteractive?: boolean;
  disableModelInvocation?: boolean;
  hasUserSpecifiedDescription?: boolean;
  whenToUse?: string;
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

function dispatcherLoadError(cmd: SlashCommand): Error {
  return new Error(
    `Command load() invoked for AgenC command "${cmd.name}"; ` +
      "AgenC commands execute through the runtime dispatcher.",
  );
}

export function projectSlashCommand(cmd: SlashCommand): Command {
  return {
    type: "local",
    name: cmd.name,
    description: cmd.description,
    aliases: cmd.aliases ? [...cmd.aliases] : undefined,
    immediate: cmd.immediate,
    userInvocable: cmd.userInvocable,
    supportsNonInteractive: true,
    load: async () => {
      throw dispatcherLoadError(cmd);
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

function builtInCommands(): readonly Command[] {
  projectedCommandCache ??= buildDefaultRegistry().list().map(projectSlashCommand);
  return projectedCommandCache;
}

export function registerCommandProvider(
  provider: (cwd: string) => Promise<readonly Command[]> | readonly Command[],
): () => void {
  commandProviders.add(provider);
  return () => {
    commandProviders.delete(provider);
  };
}

export function getCommandsSync(): Command[] {
  return [...builtInCommands()];
}

export async function getCommands(cwd: string): Promise<Command[]> {
  const dynamicCommands = await Promise.all(
    [...commandProviders].map(async provider => [...(await provider(cwd))]),
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

export const builtInCommandNames = new Set(
  getCommandsSync().flatMap(command => [
    command.name,
    ...(command.aliases ?? []),
  ]),
);

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

export async function getSkillToolCommands(cwd: string): Promise<Command[]> {
  const allCommands = await getCommands(cwd);
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

export async function getSlashCommandToolSkills(cwd: string): Promise<Command[]> {
  try {
    const allCommands = await getCommands(cwd);
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
