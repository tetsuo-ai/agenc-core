/**
 * Command registry.
 *
 * Holds the set of `SlashCommand` entries the dispatcher can route to.
 * Ports the minimum AgenC `hasCommand` / `getCommand` / `findCommand`
 * lookup behavior (`src/commands.js`) without pulling in plugin marketplace,
 * skill loading, MCP wiring, or hook registration.
 *
 * Collision policy (documented in JSDoc on each method):
 *
 *   - register() throws if the incoming `cmd.name` collides with any
 *     already-registered command name.
 *   - register() throws if any of `cmd.aliases` collide with an existing
 *     command NAME (aliases must not shadow a real command).
 *   - register() warns (console.warn) and drops the alias if it collides
 *     with another registered command's ALIAS — first-registered wins.
 *
 * Lookup is case-insensitive (defensive — the parser already lowercases
 * names, but the registry must behave correctly if a caller hands it an
 * upper-case string by accident).
 *
 * @module
 */

import type {
  CommandRegistry as CommandRegistryInterface,
  SlashCommand,
} from "./types.js";
import helpCommand from "./help.js";
import statusCommand from "./status.js";
import initCommand from "./init.js";
import diffCommand from "./diff.js";
import exitCommand from "./exit.js";
import clearCommand from "./clear.js";
import contextCommand from "./context.js";
import keybindingsCommand from "./keybindings.js";
import resumeCommand from "./resume.js";
import forkCommand from "./fork.js";
import planCommand from "./plan.js";
import permissionsCommand from "./permissions.js";
import configCommand from "./config.js";
import modelCommand from "./model.js";
import providerCommand from "./provider.js";
import compactCommand from "./compact.js";
import copyCommand from "./copy.js";
import mcpCommand from "./mcp.js";
import skillsCommand from "./skills.js";
import memoryCommand from "./memory.js";
import { enterWorktree } from "./enter-worktree.js";
import { exitWorktree } from "./exit-worktree.js";

/**
 * Concrete in-memory implementation of `CommandRegistry`. The registry
 * is immutable after construction from the dispatcher's point of view;
 * callers can still `register` new commands in setup code, but the
 * dispatcher treats the registry as read-only during a turn.
 */
export class CommandRegistry implements CommandRegistryInterface {
  private readonly byName = new Map<string, SlashCommand>();
  private readonly byAlias = new Map<string, SlashCommand>();

  /**
   * Add a command to the registry.
   *
   * @throws Error — if `cmd.name` collides with an existing name or with
   *   an existing alias, or if any alias collides with an existing name.
   *   Alias-to-alias collisions do NOT throw; they emit a warning and
   *   the first registration wins.
   */
  register(cmd: SlashCommand): void {
    const nameKey = cmd.name.toLowerCase();
    if (this.byName.has(nameKey)) {
      throw new Error(
        `CommandRegistry: duplicate command name "${cmd.name}"`,
      );
    }
    if (this.byAlias.has(nameKey)) {
      throw new Error(
        `CommandRegistry: command name "${cmd.name}" collides with existing alias`,
      );
    }
    const aliasKeys: string[] = [];
    for (const alias of cmd.aliases ?? []) {
      const aKey = alias.toLowerCase();
      if (this.byName.has(aKey)) {
        throw new Error(
          `CommandRegistry: alias "${alias}" (of /${cmd.name}) collides with existing command name`,
        );
      }
      if (this.byAlias.has(aKey)) {
        // First-registered wins — document and skip.
        console.warn(
          `CommandRegistry: alias "${alias}" (of /${cmd.name}) already registered by another command; dropping`,
        );
        continue;
      }
      aliasKeys.push(aKey);
    }
    // Commit only after every precondition passes so partial-registration
    // cannot leave the registry in a half-updated state.
    this.byName.set(nameKey, cmd);
    for (const aKey of aliasKeys) {
      this.byAlias.set(aKey, cmd);
    }
  }

  /**
   * Find a command by its canonical name or any registered alias.
   * Lookup is case-insensitive.
   */
  find(nameOrAlias: string): SlashCommand | undefined {
    const key = nameOrAlias.toLowerCase();
    return this.byName.get(key) ?? this.byAlias.get(key);
  }

  /** True iff a command with this name/alias is registered. */
  has(nameOrAlias: string): boolean {
    const key = nameOrAlias.toLowerCase();
    return this.byName.has(key) || this.byAlias.has(key);
  }

  /**
   * Return every registered command in registration order.
   *
   * This is presentation order for `/help` and the slash palette, so it
   * must stay aligned with the curated command order in
   * `buildDefaultRegistry()` rather than being alpha-sorted.
   */
  list(): readonly SlashCommand[] {
    return [...this.byName.values()];
  }

  /** Convenience constructor — register every command in order. */
  static fromCommands(cmds: readonly SlashCommand[]): CommandRegistry {
    const reg = new CommandRegistry();
    for (const c of cmds) {
      reg.register(c);
    }
    return reg;
  }
}

/**
 * Adapter for `/enter-worktree <slug>`.
 *
 * Calls `enterWorktree({ session, slug })`, binds the resulting handle
 * into `session.pendingWorktreeState`, and updates the session cwd to
 * the worktree path via `setPendingWorktreeState`.
 */
const enterWorktreeCommand: SlashCommand = {
  name: "enter-worktree",
  description: "Enter (or resume) an isolated git worktree for agent work",
  execute: async (ctx) => {
    const slug = ctx.argsRaw.split(/\s+/)[0] ?? "";
    if (!slug) {
      return {
        kind: "error",
        message: "Usage: /enter-worktree <slug>",
      };
    }
    try {
      const outcome = await enterWorktree({
        session: ctx.session,
        slug,
      });
      if (outcome.kind === "rejected") {
        return { kind: "error", message: outcome.reason };
      }
      // outcome.kind === "entered"
      ctx.session.setPendingWorktreeState({
        handle: outcome.handle,
        baseCommit: outcome.baseCommit,
        originalCwd: ctx.cwd,
      });
      return {
        kind: "text",
        text: `Entered worktree '${slug}' at ${outcome.handle.path}${outcome.handle.created ? " (new)" : " (resumed)"}.`,
      };
    } catch (err) {
      return { kind: "error", message: String(err) };
    }
  },
};

/**
 * Adapter for `/exit-worktree [remove [--discard]]`.
 *
 * Reads the active worktree handle from `session.pendingWorktreeState`,
 * calls `exitWorktree`, and clears the pending state on success.
 *
 * Argument parsing:
 *   (no args)            → action="keep"
 *   "remove"             → action="remove", discardChanges=false
 *   "remove --discard"   → action="remove", discardChanges=true
 */
const exitWorktreeCommand: SlashCommand = {
  name: "exit-worktree",
  description: "Exit (keep or remove) the active agent worktree",
  execute: async (ctx) => {
    const state = ctx.session.pendingWorktreeState;
    if (!state) {
      return {
        kind: "error",
        message: "No active worktree. Use /enter-worktree <slug> first.",
      };
    }
    const args = ctx.argsRaw
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    let action: "keep" | "remove";
    let discardChanges: boolean;
    if (args.length === 0 || (args.length === 1 && args[0] === "keep")) {
      action = "keep";
      discardChanges = false;
    } else if (
      args[0] === "remove" &&
      (args.length === 1 || (args.length === 2 && args[1] === "--discard"))
    ) {
      action = "remove";
      discardChanges = args[1] === "--discard";
    } else {
      return {
        kind: "error",
        message: "Usage: /exit-worktree [keep|remove [--discard]]",
      };
    }
    try {
      const outcome = await exitWorktree({
        session: ctx.session,
        handle: state.handle,
        baseCommit: state.baseCommit,
        action,
        discardChanges,
      });
      if (outcome.kind === "refused") {
        return { kind: "error", message: outcome.reason };
      }
      // outcome.kind === "kept" | "removed"
      ctx.session.setPendingWorktreeState(null);
      return { kind: "text", text: outcome.message };
    } catch (err) {
      return { kind: "error", message: String(err) };
    }
  },
};

/**
 * Build the default registry.
 *
 * The registry owns presentation order for the user-facing command
 * surface and the CLI/TUI dispatch path.
 *
 * Worktree commands are included as thin adapters so the bin entry
 * can migrate off the bespoke `bin/slash.ts` path without a second
 * cutover.
 */
export function buildDefaultRegistry(): CommandRegistry {
  return CommandRegistry.fromCommands([
    // Presentation order mirrors AgenC-style picker prominence.
    modelCommand,
    providerCommand,
    permissionsCommand,
    configCommand,
    helpCommand,
    statusCommand,
    initCommand,
    compactCommand,
    copyCommand,
    mcpCommand,
    memoryCommand,
    skillsCommand,
    planCommand,
    resumeCommand,
    forkCommand,
    diffCommand,
    contextCommand,
    keybindingsCommand,
    // Pre-existing worktree adapters
    enterWorktreeCommand,
    exitWorktreeCommand,
    exitCommand,
    clearCommand,
  ]);
}
