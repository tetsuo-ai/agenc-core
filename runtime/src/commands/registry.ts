/**
 * Minimal slash-command registry.
 *
 * The runtime stabilization command surface is deliberately small. Commands
 * that are not registered here are not user-invocable through the TUI slash
 * palette or the daemon slash dispatcher.
 */

import type {
  CommandRegistry as CommandRegistryInterface,
  SlashCommand,
  SlashCommandSurface,
} from "./types.js";
import { helpCommand } from "./help.js";
import { statusCommand } from "./status.js";
import { costCommand } from "./cost.js";
import { diffCommand } from "./diff.js";
import { exitCommand } from "./exit.js";
import { clearCommand } from "./clear.js";
import { permissionsCommand } from "./permissions.js";
import { configCommand } from "./config.js";
import hooksCommand from "./hooks.js";
import { planCommand } from "./plan.js";
import { modelCommand } from "./model.js";
import { providerCommand } from "./provider.js";
import { mcpCommand } from "./mcp.js";
import { skillsCommand } from "./skills.js";
import { agentsCommand } from "./agent-management.js";
import { tasksCommand } from "./tasks.js";
import { resumeCommand } from "./resume.js";
import { memorySlashCommand } from "./memory/slash.js";
import { pluginsCommand } from "./plugins.js";
import { protocolCommands } from "./protocol.js";
import { compactCommand, contextCommand } from "./session-compact.js";
import { remoteCommand } from "./remote.js";

/**
 * Concrete in-memory implementation of `CommandRegistry`.
 *
 * Collision policy:
 * - command names must be unique;
 * - aliases must not shadow command names;
 * - alias-to-alias collisions keep the first registration and warn.
 */
export class CommandRegistry implements CommandRegistryInterface {
  private byName = new Map<string, SlashCommand>();
  private byAlias = new Map<string, SlashCommand>();

  register(cmd: SlashCommand): void {
    CommandRegistry.registerInto(this.byName, this.byAlias, cmd);
  }

  find(nameOrAlias: string): SlashCommand | undefined {
    const key = nameOrAlias.toLowerCase();
    return this.byName.get(key) ?? this.byAlias.get(key);
  }

  has(nameOrAlias: string): boolean {
    const key = nameOrAlias.toLowerCase();
    return this.byName.has(key) || this.byAlias.has(key);
  }

  list(): readonly SlashCommand[] {
    return [...this.byName.values()];
  }

  static fromCommands(cmds: readonly SlashCommand[]): CommandRegistry {
    const reg = new CommandRegistry();
    for (const c of cmds) {
      reg.register(c);
    }
    return reg;
  }

  private static registerInto(
    byName: Map<string, SlashCommand>,
    byAlias: Map<string, SlashCommand>,
    cmd: SlashCommand,
  ): void {
    const nameKey = cmd.name.toLowerCase();
    if (byName.has(nameKey)) {
      throw new Error(
        `CommandRegistry: duplicate command name "${cmd.name}"`,
      );
    }
    if (byAlias.has(nameKey)) {
      throw new Error(
        `CommandRegistry: command name "${cmd.name}" collides with existing alias`,
      );
    }

    const aliasKeys: string[] = [];
    for (const alias of cmd.aliases ?? []) {
      const aKey = alias.toLowerCase();
      if (byName.has(aKey)) {
        throw new Error(
          `CommandRegistry: alias "${alias}" (of /${cmd.name}) collides with existing command name`,
        );
      }
      if (byAlias.has(aKey)) {
        console.warn(
          `CommandRegistry: alias "${alias}" (of /${cmd.name}) already registered by another command; dropping`,
        );
        continue;
      }
      aliasKeys.push(aKey);
    }

    byName.set(nameKey, cmd);
    for (const aKey of aliasKeys) {
      byAlias.set(aKey, cmd);
    }
  }
}

export interface BuildDefaultRegistryOptions {
  readonly surface?: SlashCommandSurface;
}

function commandSupportsSurface(
  command: SlashCommand,
  surface: SlashCommandSurface | undefined,
): boolean {
  if (surface === undefined) return true;
  return command.supportedSurfaces?.includes(surface) ?? true;
}

/**
 * Build the default user-invocable slash registry.
 *
 * Presentation order matches the runtime stabilization minimal surface:
 * /help, /status, /cost, /model, /provider, /permissions, /plan, /agents,
 * /tasks, /config, /hooks, /skills, /mcp, /plugins, /memory, /resume,
 * /clear, /compact, /context, /diff, protocol commands, /exit.
 */
export function buildDefaultRegistry(
  options: BuildDefaultRegistryOptions = {},
): CommandRegistry {
  return CommandRegistry.fromCommands([
    helpCommand,
    statusCommand,
    costCommand,
    modelCommand,
    providerCommand,
    permissionsCommand,
    planCommand,
    agentsCommand,
    tasksCommand,
    configCommand,
    hooksCommand,
    skillsCommand,
    mcpCommand,
    remoteCommand,
    pluginsCommand,
    memorySlashCommand,
    resumeCommand,
    clearCommand,
    compactCommand,
    contextCommand,
    diffCommand,
    ...protocolCommands,
    exitCommand,
  ].filter((command) => commandSupportsSurface(command, options.surface)));
}
