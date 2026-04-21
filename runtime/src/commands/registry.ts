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
import { setCwd } from "../utils/Shell.js";
import type { ExitWorktreeAction } from "./exit-worktree.js";
import type { PendingWorktreeState } from "../session/pending-worktree.js";

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

function formatEnterWorktree(
  state: PendingWorktreeState,
): string {
  const action = state.handle.created ? "Entered" : "Resumed";
  const lines = [
    `${action} worktree at ${state.handle.path}`,
    `Branch: ${state.handle.branch}`,
  ];
  if (state.baseCommit !== null) {
    lines.push(`Base commit: ${state.baseCommit}`);
  }
  return lines.join("\n");
}

function formatExitWorktree(
  message: string,
  originalCwd: string,
): string {
  return `${message}\nRestored cwd: ${originalCwd}`;
}

function parseEnterWorktreeArgs(argsRaw: string): { slug: string } | { error: string } {
  const parts = argsRaw.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length !== 1) {
    return { error: "Usage: /enter-worktree <slug>" };
  }
  return { slug: parts[0]! };
}

function parseExitWorktreeArgs(
  argsRaw: string,
):
  | { action: ExitWorktreeAction; discardChanges: boolean }
  | { error: string } {
  const parts = argsRaw.split(/\s+/).filter((part) => part.length > 0);
  let action: ExitWorktreeAction = "keep";
  let actionExplicit = false;
  let discardChanges = false;

  for (const part of parts) {
    if (part === "keep" || part === "remove") {
      if (actionExplicit) {
        return {
          error:
            "Usage: /exit-worktree [keep|remove] [--discard-changes]",
        };
      }
      action = part;
      actionExplicit = true;
      continue;
    }
    if (part === "--discard-changes") {
      discardChanges = true;
      continue;
    }
    return {
      error: "Usage: /exit-worktree [keep|remove] [--discard-changes]",
    };
  }

  if (action === "keep" && discardChanges) {
    return {
      error:
        "--discard-changes is only valid with /exit-worktree remove",
    };
  }

  return { action, discardChanges };
}

function switchCwd(path: string): void {
  process.chdir(path);
  setCwd(path);
}

/**
 * Adapter for `/enter-worktree`.
 */
const enterWorktreeCommand: SlashCommand = {
  name: "enter-worktree",
  description: "Enter (or resume) an isolated git worktree for agent work",
  execute: async (ctx) => {
    const parsed = parseEnterWorktreeArgs(ctx.argsRaw);
    if ("error" in parsed) {
      return {
        kind: "error",
        message: parsed.error,
      };
    }
    if (ctx.session.pendingWorktreeState !== null) {
      return {
        kind: "error",
        message: `Already inside worktree ${ctx.session.pendingWorktreeState.handle.path}; exit it first`,
      };
    }
    try {
      const outcome = await enterWorktree({
        session: ctx.session,
        slug: parsed.slug,
      });
      if (outcome.kind === "rejected") {
        return { kind: "error", message: outcome.reason };
      }
      const state: PendingWorktreeState = {
        handle: outcome.handle,
        baseCommit: outcome.baseCommit,
        originalCwd: ctx.cwd,
      };
      switchCwd(outcome.handle.path);
      ctx.session.setPendingWorktreeState(state);
      return { kind: "text", text: formatEnterWorktree(state) };
    } catch (err) {
      return {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

/**
 * Adapter for `/exit-worktree`.
 */
const exitWorktreeCommand: SlashCommand = {
  name: "exit-worktree",
  description: "Exit (keep or remove) the active agent worktree",
  execute: async (ctx) => {
    const parsed = parseExitWorktreeArgs(ctx.argsRaw);
    if ("error" in parsed) {
      return {
        kind: "error",
        message: parsed.error,
      };
    }
    const pending = ctx.session.pendingWorktreeState;
    if (pending === null) {
      return {
        kind: "error",
        message: "No active worktree is bound to this session",
      };
    }
    try {
      const outcome = await exitWorktree({
        session: ctx.session,
        handle: pending.handle,
        baseCommit: pending.baseCommit,
        action: parsed.action,
        ...(parsed.discardChanges ? { discardChanges: true } : {}),
      });
      if (outcome.kind === "refused") {
        return { kind: "error", message: outcome.reason };
      }
      switchCwd(pending.originalCwd);
      ctx.session.setPendingWorktreeState(null);
      return {
        kind: "text",
        text: formatExitWorktree(outcome.message, pending.originalCwd),
      };
    } catch (err) {
      return {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
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
