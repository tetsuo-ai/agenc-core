/**
 * Slash commands handler.
 *
 * Intercepts `/`-prefixed messages before they reach the LLM. Commands
 * provide users with direct control over the agent through messaging-native
 * interactions. Unknown commands are passed through to the LLM as regular
 * messages.
 *
 * @module
 */

import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";

// ============================================================================
// Types
// ============================================================================

/** Context passed to slash command handlers. */
export interface SlashCommandContext {
  /** The raw argument string after the command name. */
  readonly args: string;
  /** Parsed argument tokens (split on whitespace). */
  readonly argv: readonly string[];
  /** The session ID. */
  readonly sessionId: string;
  /** The sender ID. */
  readonly senderId: string;
  /** The channel name. */
  readonly channel: string;
  /** Reply callback — sends a response in the same channel. */
  readonly reply: (content: string) => Promise<void>;
  /** Structured reply callback for first-party clients. */
  readonly replyResult: (
    result: SlashCommandExecutionResult,
  ) => Promise<void>;
}

/** Handler function signature for a slash command. */
export type SlashCommandHandler = (ctx: SlashCommandContext) => Promise<void>;

export type SlashCommandClient = "shell" | "console" | "web";

export type SlashCommandCategory =
  | "session"
  | "workflow"
  | "coding"
  | "agents"
  | "tasks"
  | "extensions"
  | "policy"
  | "runtime"
  | "utility";

export type SlashCommandViewKind =
  | "text"
  | "session"
  | "workflow"
  | "agents"
  | "tasks"
  | "files"
  | "grep"
  | "git"
  | "diff"
  | "review"
  | "verify"
  | "extensions"
  | "policy"
  | "runtime";

export interface SlashCommandMetadata {
  readonly aliases?: readonly string[];
  readonly category?: SlashCommandCategory;
  readonly clients?: readonly SlashCommandClient[];
  readonly rolloutFeature?:
    | "shellProfiles"
    | "codingCommands"
    | "shellExtensions"
    | "watchCockpit"
    | "multiAgent";
  readonly viewKind?: SlashCommandViewKind;
  readonly deprecatedAliases?: readonly string[];
}

/** Definition of a slash command. */
export interface SlashCommandDef {
  /** Command name without the slash (e.g. 'status', 'model'). */
  readonly name: string;
  /** Short description for /help output. */
  readonly description: string;
  /** Optional argument pattern description (e.g. '<name>'). */
  readonly args?: string;
  /** Whether this command is available in all channels. */
  readonly global: boolean;
  /** Optional metadata used by first-party clients to build command catalogs. */
  readonly metadata?: SlashCommandMetadata;
  /** Handler function. */
  readonly handler: SlashCommandHandler;
}

export interface SlashCommandCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly args?: string;
  readonly global: boolean;
  readonly aliases: readonly string[];
  readonly category: SlashCommandCategory;
  readonly clients: readonly SlashCommandClient[];
  readonly rolloutFeature?:
    | "shellProfiles"
    | "codingCommands"
    | "shellExtensions"
    | "watchCockpit"
    | "multiAgent";
  readonly viewKind: SlashCommandViewKind;
  readonly deprecatedAliases: readonly string[];
  readonly available?: boolean;
  readonly availabilityReason?: string;
  readonly effectiveProfile?: string;
  readonly heldBackBy?:
    | "shellProfiles"
    | "codingCommands"
    | "shellExtensions"
    | "watchCockpit"
    | "multiAgent";
}

export interface SlashCommandExecutionResult<Data = unknown> {
  readonly text: string;
  readonly viewKind?: SlashCommandViewKind;
  readonly data?: Data;
}

export interface SlashCommandDispatchResult<Data = unknown> {
  readonly handled: boolean;
  readonly commandName?: string;
  readonly result?: SlashCommandExecutionResult<Data>;
}

type SlashCommandExecutionContext = Pick<
  SlashCommandContext,
  "sessionId" | "senderId" | "channel" | "reply"
> & {
  readonly replyResult?: (
    result: SlashCommandExecutionResult,
  ) => Promise<void>;
};

/** Result of parsing a message for slash commands. */
export interface ParsedCommand {
  /** Whether the message is a slash command. */
  readonly isCommand: boolean;
  /** The command name (without slash), if parsed. */
  readonly name?: string;
  /** The raw argument string after the command name. */
  readonly args?: string;
  /** Parsed argument tokens. */
  readonly argv?: readonly string[];
}

// ============================================================================
// Parser
// ============================================================================

/** Max command name length (alphanumeric + hyphens, 1-32 chars). */
const MAX_COMMAND_LENGTH = 32;
const COMMAND_PATTERN = /^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+(.*))?$/;

/**
 * Parse a message string to check if it's a slash command.
 *
 * A valid slash command starts with `/` followed by a letter and optional
 * alphanumeric/dash/underscore characters (max 32 chars), optionally
 * followed by arguments.
 */
export function parseCommand(message: string): ParsedCommand {
  const trimmed = message.trim();
  if (trimmed === "/") {
    return {
      isCommand: true,
      name: "help",
      args: "",
      argv: [],
    };
  }
  const match = COMMAND_PATTERN.exec(trimmed);

  if (!match) {
    return { isCommand: false };
  }

  const name = match[1].toLowerCase();
  if (name.length > MAX_COMMAND_LENGTH) {
    return { isCommand: false };
  }

  const args = match[2]?.trim() ?? "";
  const argv = args ? args.split(/\s+/) : [];

  return { isCommand: true, name, args, argv };
}

// ============================================================================
// SlashCommandRegistry
// ============================================================================

export interface SlashCommandRegistryConfig {
  readonly logger?: Logger;
}

/**
 * Registry for slash commands.
 *
 * Manages command definitions and dispatch. Built-in commands can be
 * registered via `createDefaultCommands()`. Additional commands can be
 * added by plugins.
 */
export class SlashCommandRegistry {
  private readonly commands = new Map<string, SlashCommandDef>();
  private readonly aliases = new Map<string, string>();
  private readonly logger: Logger;

  constructor(config?: SlashCommandRegistryConfig) {
    this.logger = config?.logger ?? silentLogger;
  }

  /** Register a slash command. Overwrites if name already exists. */
  register(command: SlashCommandDef): void {
    const existing = this.commands.get(command.name);
    if (existing) {
      this.unregister(command.name);
    }
    this.commands.set(command.name, command);
    for (const alias of command.metadata?.aliases ?? []) {
      this.aliases.set(alias, command.name);
    }
    for (const alias of command.metadata?.deprecatedAliases ?? []) {
      this.aliases.set(alias, command.name);
    }
    this.logger.debug(`Command registered: /${command.name}`);
  }

  /** Unregister a command by name. */
  unregister(name: string): boolean {
    const removed = this.commands.delete(name);
    if (removed) {
      for (const [alias, target] of this.aliases.entries()) {
        if (target === name) {
          this.aliases.delete(alias);
        }
      }
      this.logger.debug(`Command unregistered: /${name}`);
    }
    return removed;
  }

  /** Get a command definition by name. */
  get(name: string): SlashCommandDef | undefined {
    const canonical = this.aliases.get(name) ?? name;
    return this.commands.get(canonical);
  }

  /** Check if a command is registered. */
  has(name: string): boolean {
    return this.commands.has(name) || this.aliases.has(name);
  }

  /** Get all registered command definitions sorted by name. */
  getCommands(): ReadonlyArray<SlashCommandDef> {
    return Array.from(this.commands.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /** List all command names. */
  listNames(): string[] {
    return Array.from(this.commands.keys());
  }

  /** Number of registered commands. */
  get size(): number {
    return this.commands.size;
  }

  /** Parse a message string for a slash command. */
  parse(content: string): ParsedCommand {
    return parseCommand(content);
  }

  /**
   * Execute a previously parsed command.
   *
   * Returns true if the command was handled, false if unknown.
   */
  async execute(
    parsed: ParsedCommand,
    context: SlashCommandExecutionContext,
  ): Promise<boolean> {
    const detailed = await this.executeDetailed(parsed, context);
    return detailed.handled;
  }

  async executeDetailed(
    parsed: ParsedCommand,
    context: SlashCommandExecutionContext,
  ): Promise<SlashCommandDispatchResult> {
    if (!parsed.isCommand || !parsed.name) {
      return { handled: false };
    }

    const command = this.get(parsed.name);
    if (!command) {
      this.logger.debug(`Unknown command: /${parsed.name}, passing through`);
      return { handled: false };
    }

    let explicitResult: SlashCommandExecutionResult | undefined;
    const replies: string[] = [];
    const ctx: SlashCommandContext = {
      args: parsed.args ?? "",
      argv: parsed.argv ?? [],
      sessionId: context.sessionId,
      senderId: context.senderId,
      channel: context.channel,
      reply: async (content) => {
        replies.push(content);
        await context.reply(content);
      },
      replyResult: async (result) => {
        explicitResult = result;
        if (context.replyResult) {
          await context.replyResult(result);
          return;
        }
        await context.reply(result.text);
      },
    };

    try {
      await command.handler(ctx);
      this.logger.debug(`Command executed: /${parsed.name}`);
    } catch (err) {
      this.logger.error(`Command /${parsed.name} failed:`, err);
      await context.reply(
        `Error: /${parsed.name} failed — ${(err as Error).message}`,
      );
    }

    return {
      handled: true,
      commandName: command.name,
      result:
        explicitResult ??
        (replies.length > 0
          ? {
              text: replies.join("\n\n").trim(),
              viewKind: command.metadata?.viewKind ?? "text",
            }
          : undefined),
    };
  }

  getCatalog(): ReadonlyArray<SlashCommandCatalogEntry> {
    return this.getCommands().map((command) => ({
      name: command.name,
      description: command.description,
      ...(command.args ? { args: command.args } : {}),
      global: command.global,
      aliases: command.metadata?.aliases ?? [],
      category: command.metadata?.category ?? "utility",
      clients: command.metadata?.clients ?? ["shell", "console", "web"],
      ...(command.metadata?.rolloutFeature
        ? { rolloutFeature: command.metadata.rolloutFeature }
        : {}),
      viewKind: command.metadata?.viewKind ?? "text",
      deprecatedAliases: command.metadata?.deprecatedAliases ?? [],
    }));
  }

  /**
   * Dispatch a message to the appropriate command handler.
   *
   * Convenience method that combines parse + execute.
   * Returns true if the message was handled as a command, false if it should
   * be passed through to the LLM (not a command or unknown command).
   */
  async dispatch(
    message: string,
    sessionId: string,
    senderId: string,
    channel: string,
    reply: (content: string) => Promise<void>,
  ): Promise<boolean> {
    const detailed = await this.dispatchDetailed(
      message,
      sessionId,
      senderId,
      channel,
      reply,
    );
    return detailed.handled;
  }

  async dispatchDetailed(
    message: string,
    sessionId: string,
    senderId: string,
    channel: string,
    reply: (content: string) => Promise<void>,
  ): Promise<SlashCommandDispatchResult> {
    const parsed = this.parse(message);
    return this.executeDetailed(parsed, {
      sessionId,
      senderId,
      channel,
      reply,
      replyResult: async (result) => {
        await reply(result.text);
      },
    });
  }
}

// ============================================================================
// Default commands factory
// ============================================================================

/**
 * Create the 14 built-in slash command definitions.
 *
 * Returns an array of SlashCommandDef that can be registered on a
 * SlashCommandRegistry. This factory enables constructing a registry
 * without defaults, or getting defaults without a registry.
 */
export function createDefaultCommands(): SlashCommandDef[] {
  return [
    {
      name: "help",
      description: "Show available commands",
      global: true,
      metadata: {
        category: "utility",
        clients: ["shell", "console", "web"],
        viewKind: "text",
      },
      handler: async (ctx) => {
        // Help needs access to a registry, so this is a placeholder.
        // The gateway wires up the real help handler with registry access.
        await ctx.reply("Use /help to see available commands.");
      },
    },
  ];
}
