/**
 * Shared contract for runtime slash commands.
 *
 * Every user-invocable command under `runtime/src/commands/` implements
 * the `SlashCommand` interface. The dispatcher iterates
 * a registry of these and routes by `name`/`aliases`.
 *
 * Design rules (agent-E scope):
 *   - `execute` MUST NOT throw — wrap failures in `{ kind: "error" }`.
 *   - `immediate: true` signals the dispatcher to bypass the turn loop
 *     (used for `/status`, `/exit`, etc. that don't need a round-trip
 *     through the LLM).
 *   - `userInvocable` defaults to true; set false for internal hooks.
 *   - `sensitive: true` masks `argsRaw` in the transcript.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import type { ConfigStore } from "../config/store.js";

/**
 * Optional bridge into the React-side AppState so slash commands can
 * synchronously update reactive UI state (status bar, etc.) without
 * waiting for a future turn boundary. Mirrors agenc's
 * `setAppState({ ...prev, mainLoopModel })` pattern at
 * `commands/model/model.tsx:59-63`.
 */
export interface SlashCommandAppStateBridge {
  /** Update the model slug shown in the status bar. */
  readonly setModel?: (model: string) => void;
}

/**
 * Context passed to every slash-command invocation. Fields are
 * readonly; commands may consult `session` or `configStore` but must
 * not mutate them in place (use session's documented mutators).
 */
export interface SlashCommandContext {
  readonly session: Session;
  /** Raw argument string after the command name (may be empty). */
  readonly argsRaw: string;
  /** Current working directory (honored over `process.cwd()` so tests can override). */
  readonly cwd: string;
  /** Config store (optional — commands that don't need config skip this). */
  readonly configStore?: ConfigStore;
  /** Resolved user home directory (e.g. `os.homedir()`). */
  readonly home: string;
  /** Resolved AgenC state directory (`AGENC_HOME` or `$HOME/.agenc`). */
  readonly agencHome?: string;
  /**
   * Bridge into React-side AppState. Populated by the dispatcher when
   * running in a TUI context; absent in headless/test contexts.
   */
  readonly appState?: SlashCommandAppStateBridge;
}

/** Discriminated union of outcomes a command can return. */
export type SlashCommandResult =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "compact"; readonly text: string }
  /** Re-inject `content` as a user prompt to the turn loop. */
  | { readonly kind: "prompt"; readonly content: string }
  /** No transcript append — dispatcher should emit nothing. */
  | { readonly kind: "skip" }
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "error"; readonly message: string };

/** Common command descriptor. */
export interface SlashCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  /** Bypass the turn loop (default false). */
  readonly immediate?: boolean;
  /** False for internal-only commands (default true). */
  readonly userInvocable?: boolean;
  /** Mask `argsRaw` in transcripts (default false). */
  readonly sensitive?: boolean;
  readonly execute: (ctx: SlashCommandContext) => Promise<SlashCommandResult>;
}

/**
 * Internal helper used by every command's `execute` — wraps the handler
 * so thrown exceptions become `{ kind: "error" }` per the design rule
 * above.
 */
export async function safeExecute(
  handler: () => Promise<SlashCommandResult>,
): Promise<SlashCommandResult> {
  try {
    return await handler();
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Lazy registry accessor. Runtime entry points install the live registry
 * via `setGlobalCommandRegistry`; until then `help.ts` falls back to a
 * "registry pending" message.
 */
export interface CommandRegistry {
  list(): readonly SlashCommand[];
  find(nameOrAlias: string): SlashCommand | undefined;
}

let globalRegistry: CommandRegistry | null = null;

export function setGlobalCommandRegistry(reg: CommandRegistry | null): void {
  globalRegistry = reg;
}

export function getGlobalCommandRegistry(): CommandRegistry | null {
  return globalRegistry;
}
