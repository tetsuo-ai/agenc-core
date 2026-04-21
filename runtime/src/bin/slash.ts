/**
 * Slash-command dispatcher for the `agenc` CLI entry point.
 *
 * W3 wiring: this module is now a thin wrapper over the canonical
 * dispatcher in `../commands/dispatcher.ts`. The CLI binary calls
 * `runSlashCommand(input, ctx)` once per input line; the wrapper
 * builds the default command registry, parses the input, and routes
 * through `dispatchSlashCommand`. Bridge-safety (for IPC / daemon
 * forwarding) is enforced through `isBridgeSafeCommand`.
 *
 * Legacy surface (`parseSlashCommand`, `handleSlashCommand`,
 * `PendingWorktreeState`, `SlashCommand`, `SlashHandleResult`) is
 * preserved for the pre-existing worktree entry tests + callers that
 * still depend on the bespoke shape. New callers should use
 * `runSlashCommand` + `SlashCommandRunContext` instead.
 *
 * @module
 */

import { enterWorktree } from "../commands/enter-worktree.js";
import { exitWorktree } from "../commands/exit-worktree.js";
import {
  dispatchSlashCommand,
  isBridgeSafeCommand,
  parseSlashCommand as parseDispatcherInput,
  type DispatchOutcome,
} from "../commands/dispatcher.js";
import {
  buildDefaultRegistry,
  type CommandRegistry,
} from "../commands/registry.js";
import {
  getGlobalCommandRegistry,
  setGlobalCommandRegistry,
  type SlashCommandContext,
  type SlashCommandResult,
} from "../commands/types.js";
import type { WorktreeHandle } from "../agents/worktree.js";
import type { Session } from "../session/session.js";

// ---------------------------------------------------------------------------
// W3 thin-wrapper surface
// ---------------------------------------------------------------------------

/**
 * Context carried to every slash-command run through `runSlashCommand`.
 * Mirrors `SlashCommandContext` but with `argsRaw` intentionally absent —
 * the wrapper fills it in from the parsed input line. Callers supply the
 * session + cwd + home + (optional) configStore once per turn.
 */
export type SlashCommandRunContext = Omit<SlashCommandContext, "argsRaw">;

/**
 * Discriminated union describing what happened when the CLI tried to
 * dispatch a slash command. `skip` means the input was not a slash
 * command at all (or did not parse under I-68); the caller should
 * forward the input as a normal user prompt. Every other variant
 * carries the full dispatcher outcome so the CLI can render the result.
 */
export type SlashCommandRunResult =
  | { readonly kind: "skip" }
  | {
      readonly kind: "dispatched";
      readonly outcome: DispatchOutcome;
      readonly result: SlashCommandResult;
    }
  | { readonly kind: "unknown"; readonly message: string }
  | { readonly kind: "blocked_by_bridge"; readonly message: string };

export interface RunSlashCommandOpts {
  /**
   * Gate for daemon-bridged / IPC invocation paths. When `true`, any
   * command NOT on the `BRIDGE_SAFE` allowlist is rejected with
   * `blocked_by_bridge` before dispatch. Defaults to `false` (local
   * CLI — every command is allowed).
   */
  readonly bridge?: boolean;
}

/**
 * Lazily constructed default registry, shared across every call to
 * `runSlashCommand`. We also publish it through
 * `setGlobalCommandRegistry` so commands that read the global slot
 * (notably `/help`, which lists every registered command) see the
 * live set rather than the "registry pending" fallback.
 */
let cachedRegistry: CommandRegistry | null = null;
function getOrBuildRegistry(): CommandRegistry {
  if (cachedRegistry !== null) return cachedRegistry;
  cachedRegistry = buildDefaultRegistry();
  if (getGlobalCommandRegistry() === null) {
    setGlobalCommandRegistry(cachedRegistry);
  }
  return cachedRegistry;
}

/**
 * Thin wrapper over `dispatchSlashCommand` + `buildDefaultRegistry`.
 *
 *   - Non-slash input → `{ kind: "skip" }`. Caller forwards as user prompt.
 *   - I-68 fence violation → `{ kind: "skip" }` (same as non-slash).
 *   - Bridge-gated call to a non-bridge-safe command →
 *     `{ kind: "blocked_by_bridge" }`.
 *   - Unknown command (dispatcher returned `error` for unknown) →
 *     `{ kind: "unknown" }` for readable CLI routing.
 *   - Anything else → `{ kind: "dispatched", outcome, result }`.
 */
export async function runSlashCommand(
  input: string,
  ctx: SlashCommandRunContext,
  opts: RunSlashCommandOpts = {},
): Promise<SlashCommandRunResult> {
  const parsed = parseDispatcherInput(input);
  if (!parsed) return { kind: "skip" };

  // Bridge gate — only consult the allowlist when the caller says this
  // dispatch is arriving from a bridged / IPC path. Local CLI bypasses.
  if (opts.bridge === true && !isBridgeSafeCommand(parsed.name)) {
    return {
      kind: "blocked_by_bridge",
      message: `/${parsed.name} is not allowed over the daemon bridge (needs direct CLI confirmation)`,
    };
  }

  const registry = getOrBuildRegistry();
  const fullCtx: SlashCommandContext = {
    ...ctx,
    argsRaw: parsed.argsRaw,
  };
  const outcome = await dispatchSlashCommand(parsed, fullCtx, registry);

  // Distinguish unknown-command errors from other error kinds so the CLI
  // can render them differently (unknown commands are usually user typos,
  // not real failures).
  if (
    outcome.result.kind === "error" &&
    outcome.result.message.startsWith("Unknown command:")
  ) {
    return { kind: "unknown", message: outcome.result.message };
  }

  return { kind: "dispatched", outcome, result: outcome.result };
}

// Re-exports so the CLI (and future bridge adapters) can read the gate
// + the canonical parser from this single entry point.
export { isBridgeSafeCommand, parseDispatcherInput as parseSlashCommandLine };

// ---------------------------------------------------------------------------
// Legacy worktree surface (preserved for existing callers/tests)
// ---------------------------------------------------------------------------

export type SlashCommand =
  | { readonly kind: "enter_worktree"; readonly slug: string }
  | {
      readonly kind: "exit_worktree";
      readonly action: "keep" | "remove";
      readonly discardChanges: boolean;
    };

export interface PendingWorktreeState {
  readonly handle: WorktreeHandle;
  readonly baseCommit: string | null;
  readonly enteredFromCwd: string;
}

export interface SlashHandleResult {
  /** True when the line matched a slash command (LLM turn should be skipped). */
  readonly matched: boolean;
  /** Exit code hint — 0 on success, non-zero on rejection. */
  readonly exitCode: number;
  /** Plain-text summary to emit on stdout/stderr. */
  readonly message: string;
  /** Updated pending-worktree state (or the unchanged input when no state change). */
  readonly pendingWorktree: PendingWorktreeState | null;
  /** Updated cwd — callers `process.chdir` to this if different. */
  readonly cwd: string;
}

const ENTER_RE = /^\/enter-worktree\s+(\S+)\s*$/;
const EXIT_RE = /^\/exit-worktree\s+(keep|remove)(?:\s+(--discard))?\s*$/;

/**
 * Legacy worktree-specific parser. Returns `null` unless the input
 * matches `/enter-worktree <slug>` or `/exit-worktree <keep|remove>
 * [--discard]`. New callers should use `runSlashCommand` instead; the
 * W3 CLI binary keeps this around to route `/enter-worktree` and
 * `/exit-worktree` through the session-bound worktree handler until
 * the adapter ships in a later tranche.
 */
export function parseSlashCommand(line: string): SlashCommand | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return null;

  const enter = trimmed.match(ENTER_RE);
  if (enter) {
    return { kind: "enter_worktree", slug: enter[1]! };
  }

  const exit = trimmed.match(EXIT_RE);
  if (exit) {
    const action = exit[1] as "keep" | "remove";
    const discard = exit[2] === "--discard";
    return { kind: "exit_worktree", action, discardChanges: discard };
  }

  return null;
}

export interface HandleSlashOpts {
  readonly session: Session;
  readonly command: SlashCommand;
  readonly originalCwd: string;
  readonly pendingWorktree: PendingWorktreeState | null;
  /** Override `enterWorktree` for tests. */
  readonly enterWorktreeFn?: typeof enterWorktree;
  /** Override `exitWorktree` for tests. */
  readonly exitWorktreeFn?: typeof exitWorktree;
}

/**
 * Legacy worktree handler. Preserves the session-bound worktree flow
 * until the W3 dispatcher-side adapter lands. Does NOT call
 * `process.chdir` — returns the new cwd in the result so the caller
 * can decide how to apply it.
 */
export async function handleSlashCommand(
  opts: HandleSlashOpts,
): Promise<SlashHandleResult> {
  const enterFn = opts.enterWorktreeFn ?? enterWorktree;
  const exitFn = opts.exitWorktreeFn ?? exitWorktree;

  switch (opts.command.kind) {
    case "enter_worktree": {
      const outcome = await enterFn({
        session: opts.session,
        slug: opts.command.slug,
      });
      if (outcome.kind === "rejected") {
        return {
          matched: true,
          exitCode: 1,
          message: `enter-worktree rejected: ${outcome.reason}`,
          pendingWorktree: opts.pendingWorktree,
          cwd: opts.pendingWorktree?.handle.path ?? opts.originalCwd,
        };
      }
      const pending: PendingWorktreeState = {
        handle: outcome.handle,
        baseCommit: outcome.baseCommit,
        enteredFromCwd: opts.originalCwd,
      };
      return {
        matched: true,
        exitCode: 0,
        message: `entered worktree ${outcome.handle.path} (branch=${outcome.handle.branch}, created=${outcome.handle.created})`,
        pendingWorktree: pending,
        cwd: outcome.handle.path,
      };
    }

    case "exit_worktree": {
      const active = opts.pendingWorktree;
      if (!active) {
        return {
          matched: true,
          exitCode: 1,
          message:
            "exit-worktree rejected: no active worktree in this session",
          pendingWorktree: null,
          cwd: opts.originalCwd,
        };
      }
      const outcome = await exitFn({
        session: opts.session,
        handle: active.handle,
        baseCommit: active.baseCommit,
        action: opts.command.action,
        ...(opts.command.discardChanges
          ? { discardChanges: true }
          : {}),
      });

      if (outcome.kind === "refused") {
        return {
          matched: true,
          exitCode: outcome.errorCode > 0 ? outcome.errorCode : 1,
          message: `exit-worktree refused: ${outcome.reason}`,
          pendingWorktree: active,
          cwd: active.handle.path,
        };
      }
      if (outcome.kind === "kept") {
        // Keep: preserve the worktree + stay bound to its cwd.
        return {
          matched: true,
          exitCode: 0,
          message: outcome.message,
          pendingWorktree: active,
          cwd: active.handle.path,
        };
      }
      // Removed: drop the pending handle + restore the original cwd.
      return {
        matched: true,
        exitCode: 0,
        message: outcome.message,
        pendingWorktree: null,
        cwd: active.enteredFromCwd,
      };
    }
  }
}
