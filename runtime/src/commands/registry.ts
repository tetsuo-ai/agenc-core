/**
 * Command registry (T11 Wave 1 agent-F).
 *
 * Holds the set of `SlashCommand` entries the dispatcher can route to.
 * Ports the minimum openclaude `hasCommand` / `getCommand` / `findCommand`
 * lookup behavior (`src/commands.js`) without pulling in plugin marketplace,
 * skill loading, MCP wiring, or hook registration — those land in later
 * waves.
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
import { enterWorktree } from "./enter-worktree.js";
import { exitWorktree } from "./exit-worktree.js";

/**
 * Concrete in-memory implementation of `CommandRegistry`. The registry
 * is immutable after construction from the dispatcher's point of view;
 * callers can still `register` new commands in setup code (W2/W3), but
 * the dispatcher treats the registry as read-only during a turn.
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
   * Return every registered command, sorted by canonical name
   * (ascending, locale-aware) for deterministic `/help` output.
   */
  list(): readonly SlashCommand[] {
    return [...this.byName.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
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
 * Adapter for `/enter-worktree`.
 *
 * The existing `enterWorktree` returns `EnterWorktreeOutcome`, which the
 * dispatcher does not know how to render. Wave 3 replaces this with a
 * real adapter that threads the resulting handle through
 * `PendingWorktreeState`. For W1-F we expose a placeholder that:
 *   - parses a single `<slug>` argument
 *   - calls `enterWorktree({ session, slug })`
 *   - returns the outcome as pretty JSON text
 *
 * TODO(T11-W3): replace with a real adapter that updates session cwd
 * and pending-worktree state.
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
      return { kind: "text", text: JSON.stringify(outcome, null, 2) };
    } catch (err) {
      return {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

/**
 * Adapter for `/exit-worktree`. Placeholder — see enterWorktreeCommand
 * TODO above. W3 will rewrite this to consume the session's pending
 * worktree handle instead of requiring the handle inline.
 */
const exitWorktreeCommand: SlashCommand = {
  name: "exit-worktree",
  description: "Exit (keep or remove) the active agent worktree",
  execute: async (_ctx) => {
    // Until W3 threads the pending worktree state through
    // SlashCommandContext, the dispatcher cannot invoke the real
    // `exitWorktree(handle, baseCommit)` signature safely. We surface
    // the limitation rather than pretend to run.
    // TODO(T11-W3): supply handle + baseCommit from the session.
    void exitWorktree; // keep the symbol referenced for W3 wiring.
    return {
      kind: "error",
      message:
        "/exit-worktree requires the W3 session-bound adapter; run from the CLI for now",
    };
  },
};

/**
 * Build the default registry.
 *
 * W1-E shipped the command modules for `help` and `status` (the only
 * command files on disk at that point); Wave 2 added the bulk of the
 * user-facing commands (init, diff, exit, clear, context, keybindings,
 * resume, fork, plan, permissions, config, model, provider, compact)
 * and Wave 3 wires the registry into the CLI binary.
 *
 * Worktree commands are included as thin adapters so the bin entry
 * can migrate off the bespoke `bin/slash.ts` path without a second
 * cutover.
 */
export function buildDefaultRegistry(): CommandRegistry {
  return CommandRegistry.fromCommands([
    // Wave 1
    helpCommand,
    statusCommand,
    initCommand,
    diffCommand,
    exitCommand,
    clearCommand,
    contextCommand,
    keybindingsCommand,
    resumeCommand,
    forkCommand,
    // Wave 2-C
    planCommand,
    // Wave 2-D
    permissionsCommand,
    configCommand,
    // Wave 2-E
    modelCommand,
    providerCommand,
    compactCommand,
    // Pre-existing worktree adapters
    enterWorktreeCommand,
    exitWorktreeCommand,
  ]);
}
