/**
 * Slash-command dispatcher for the `agenc` CLI entry point.
 *
 * Thin wrapper over the canonical dispatcher in
 * `../commands/dispatcher.ts`. The CLI entry point calls
 * `runSlashCommand(input, ctx)` once per slash-intent line; the wrapper
 * builds the default command registry, parses the input, and routes
 * through `dispatchSlashCommand`. Bridge-safety (for IPC / daemon
 * forwarding) is enforced through `isBridgeSafeCommand`.
 *
 * @module
 */

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
 * dispatch a slash command. `skip` means the line did not parse as a
 * dispatchable slash command under the canonical grammar. Callers that
 * are probing arbitrary user input can fall through to the normal turn;
 * callers that already know the line is slash-intent can reject it as
 * invalid syntax. Every other variant carries the full dispatcher
 * outcome so the CLI can render the result.
 */
export type SlashCommandRunResult =
  | { readonly kind: "skip" }
  | { readonly kind: "passthrough"; readonly input: string }
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
 *   - Mistyped filesystem path fallback → `{ kind: "passthrough" }`.
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
  if (outcome.passthroughInput !== undefined) {
    return { kind: "passthrough", input: outcome.passthroughInput };
  }

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
