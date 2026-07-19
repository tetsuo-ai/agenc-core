/**
 * Slash-command dispatcher.
 *
 * Parses raw user input into a `ParsedSlashCommand`, looks up the target
 * command in a `CommandRegistry`, and executes it with an opinionated
 * wrapper that enforces the runtime command contract:
 *
 *   - I-68 — multi-line input never dispatches. A slash command must be
 *     a single non-empty logical line; any subsequent non-whitespace line
 *     fails the parse. Enforced in `parseSlashCommand`.
 *   - Unknown-command handling checks whether `<cwd>/<name>` resolves to
 *     a filesystem entry the user may have mistyped and, if so, returns
 *     `{ kind: "skip" }` with a hint. Otherwise returns an error result.
 *   - `userInvocable: false` commands cannot be dispatched directly.
 *   - `execute` never throws — we catch exceptions and wrap them.
 *   - `sensitive: true` args are masked in any trace record the dispatcher
 *     emits (the dispatcher does not persist a transcript directly; the
 *     caller consumes the `TraceRecord` from `DispatchOutcome`).
 *
 * Port notes: parse + unknown-command fallback logic is kept here so the
 * TUI, daemon wrapper, and tests use one dispatch path.
 *
 * @module
 */

import { stat } from "node:fs/promises";
import * as path from "node:path";

import type {
  CommandRegistry,
  SlashCommand,
  SlashCommandContext,
  SlashCommandResult,
} from "./types.js";

/** Result of parsing raw user input. */
export interface ParsedSlashCommand {
  /** Command name, lowercase, without the leading slash. */
  readonly name: string;
  /** Raw argument string (after the name + whitespace), trimmed. */
  readonly argsRaw: string;
  /** True when `(MCP)` marker follows the name (e.g. `/tool(MCP) args`). */
  readonly isMcp: boolean;
}

/** First-line command shape: `/name(MCP)? [args]`. Skill names may contain namespaces. */
const FIRST_LINE_RE = /^\/([a-z][a-z0-9_:-]*)(\(MCP\))?(?:\s+(.*))?$/;

/**
 * Extract the first line of `input` (everything up to the first `\n`).
 * Trailing `\r` (CRLF) is stripped.
 */
export function extractFirstLine(input: string): string {
  const newlineIdx = input.indexOf("\n");
  const firstRaw = newlineIdx === -1 ? input : input.slice(0, newlineIdx);
  return firstRaw.endsWith("\r") ? firstRaw.slice(0, -1) : firstRaw;
}

/**
 * Parse raw user input into a slash command, or return null if the input
 * is not a slash command under the runtime command contract.
 *
 * I-68 fence: only the first line may carry the command; any subsequent
 * line with non-whitespace content rejects the parse (returns null).
 *
 * @example
 *   parseSlashCommand("/help")               // => { name: "help", argsRaw: "", isMcp: false }
 *   parseSlashCommand("/model gpt-5")        // => { name: "model", argsRaw: "gpt-5", isMcp: false }
 *   parseSlashCommand("/mcp(MCP) list")      // => { name: "mcp",   argsRaw: "list",  isMcp: true }
 *   parseSlashCommand("/model\ngpt-5")       // => null  (I-68)
 *   parseSlashCommand("/")                   // => null  (empty name)
 *   parseSlashCommand("/Model")              // => null  (uppercase rejected)
 */
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  if (!input) return null;

  // I-68: split on \n and require every subsequent line to be whitespace-
  // only. We use a raw split (not regex with \s which would eat the \n
  // separator) so we can inspect per-line content for CR/LF/mixed cases.
  const lines = input.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim().length > 0) return null;
  }

  // Strip trailing \r from the first raw line (CRLF input) and trim
  // surrounding whitespace.
  let first = lines[0]!;
  if (first.endsWith("\r")) first = first.slice(0, -1);
  first = first.trim();
  if (!first.startsWith("/")) return null;

  const match = first.match(FIRST_LINE_RE);
  if (!match) return null;

  const name = match[1]!;
  const isMcp = match[2] === "(MCP)";
  const argsRaw = (match[3] ?? "").trim();

  return { name, argsRaw, isMcp };
}

/**
 * Mask sensitive argument strings for inclusion in traces / transcripts.
 * Used by `dispatchSlashCommand` when `command.sensitive === true` so
 * credentials / tokens provided as `argsRaw` never leak into logs.
 */
export function maskSensitiveArgs(argsRaw: string): string {
  if (argsRaw.length === 0) return "";
  return "***redacted***";
}

/** One record the dispatcher emits for every invocation. */
export interface DispatchTraceRecord {
  readonly name: string;
  readonly aliasUsed: string;
  readonly argsRaw: string;
  readonly sensitive: boolean;
  readonly immediate: boolean;
  readonly isMcp: boolean;
  readonly resultKind: SlashCommandResult["kind"];
}

/** Extended dispatch outcome returned by `dispatchSlashCommand`. */
export interface DispatchOutcome {
  readonly result: SlashCommandResult;
  /** True when `command.immediate` was set — caller may skip the turn loop. */
  readonly immediate: boolean;
  /** Trace record with args masked when `sensitive: true`. */
  readonly trace: DispatchTraceRecord;
  /** The resolved command, when found. */
  readonly command?: SlashCommand;
}

/**
 * Dispatch a parsed slash command through the registry.
 *
 * Behavior summary:
 *   - Looks up by name or alias (case-preserving; parser already
 *     lowercases, but `registry.find` is defensive).
 *   - Unknown command: attempts `fs.stat(cwd/name)`. If the path exists,
 *     we return `{ kind: "skip" }` so the caller treats the line as a
 *     mistyped file reference (and not a hard command error). Otherwise
 *     returns `{ kind: "error", message: "Unknown command: /<name>" }`.
 *   - `userInvocable: false` → error (model-only skill).
 *   - Any exception thrown by `execute` is caught and surfaced as
 *     `{ kind: "error" }` — the command contract forbids throwing.
 */
export async function dispatchSlashCommand(
  parsed: ParsedSlashCommand,
  ctx: SlashCommandContext,
  registry: CommandRegistry,
): Promise<DispatchOutcome> {
  const command = registry.find(parsed.name);

  if (!command) {
    const hint = await buildMistypedPathHint(ctx.cwd, parsed.name);
    if (hint !== null) {
      return {
        result: {
          kind: "skip",
        },
        immediate: false,
        trace: {
          name: parsed.name,
          aliasUsed: parsed.name,
          argsRaw: parsed.argsRaw,
          sensitive: false,
          immediate: false,
          isMcp: parsed.isMcp,
          resultKind: "skip",
        },
      };
    }
    const message = `Unknown command: /${parsed.name}`;
    return {
      result: { kind: "error", message },
      immediate: false,
      trace: {
        name: parsed.name,
        aliasUsed: parsed.name,
        argsRaw: parsed.argsRaw,
        sensitive: false,
        immediate: false,
        isMcp: parsed.isMcp,
        resultKind: "error",
      },
    };
  }

  // Model-only skill — block direct user dispatch.
  if (command.userInvocable === false) {
    const message = `/${command.name} is not user-invocable; ask the model to use this instead`;
    return {
      result: { kind: "error", message },
      immediate: false,
      command,
      trace: {
        name: command.name,
        aliasUsed: parsed.name,
        argsRaw: command.sensitive === true
          ? maskSensitiveArgs(parsed.argsRaw)
          : parsed.argsRaw,
        sensitive: command.sensitive === true,
        immediate: command.immediate === true,
        isMcp: parsed.isMcp,
        resultKind: "error",
      },
    };
  }

  if (command.isEnabled?.() === false) {
    const message = `/${command.name} is disabled in this environment`;
    return {
      result: { kind: "error", message },
      immediate: false,
      command,
      trace: {
        name: command.name,
        aliasUsed: parsed.name,
        argsRaw: command.sensitive === true
          ? maskSensitiveArgs(parsed.argsRaw)
          : parsed.argsRaw,
        sensitive: command.sensitive === true,
        immediate: command.immediate === true,
        isMcp: parsed.isMcp,
        resultKind: "error",
      },
    };
  }

  // Build the per-invocation context: preserve the caller's ctx but
  // bind argsRaw from the parsed value.
  const invocationCtx: SlashCommandContext = {
    ...ctx,
    argsRaw: parsed.argsRaw,
    commandRegistry: registry,
  };

  let result: SlashCommandResult;
  try {
    result = await command.execute(invocationCtx);
  } catch (err) {
    result = {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const maskedArgs = command.sensitive === true
    ? maskSensitiveArgs(parsed.argsRaw)
    : parsed.argsRaw;

  return {
    result,
    immediate: command.immediate === true,
    command,
    trace: {
      name: command.name,
      aliasUsed: parsed.name,
      argsRaw: maskedArgs,
      sensitive: command.sensitive === true,
      immediate: command.immediate === true,
      isMcp: parsed.isMcp,
      resultKind: result.kind,
    },
  };
}

/**
 * Heuristic from AgenC — if the would-be command name is also a
 * valid path in the cwd, treat the input as a mistyped file reference
 * rather than an unknown command. This intentionally also checks names
 * that fit the normal command regex: `/notes` should pass through when
 * `./notes` exists and no command named `notes` is registered.
 *
 * Returns a short hint string on match, null otherwise.
 */
async function buildMistypedPathHint(
  cwd: string,
  name: string,
): Promise<string | null> {
  try {
    const target = path.resolve(cwd, name);
    await stat(target);
    return `did you mean the file ${target}?`;
  } catch {
    return null;
  }
}

/**
 * Bridge-safe allowlist for remote-origin / daemon-bridged CLI
 * invocations. A "bridge-safe" command is one the daemon can run on
 * behalf of a CLI client without requiring human confirmation: it does
 * not mutate shell state, rewrite config, fork the turn, or exit the
 * process.
 *
 * Commands NOT on this list MUST prompt the user before the bridge
 * forwards them (e.g. `/exit`, `/compact`, `/permissions`, `/config`).
 */
const BRIDGE_SAFE: ReadonlySet<string> = new Set([
  "status",
  "help",
  "hello",
  "model",
  "provider",
  "clear",
  "diff",
]);

/**
 * Bridge-unsafe commands (listed explicitly to make the contract
 * readable; not consulted at runtime — anything outside BRIDGE_SAFE is
 * treated as unsafe).
 */
// Kept alongside BRIDGE_SAFE to document the contract. Do not export as
// a negation — checks MUST go through `isBridgeSafeCommand`.
// (status / help / hello / model / provider / clear / diff) are safe;
// everything else in the minimal surface requires user confirmation at
// the bridge.

export function isBridgeSafeCommand(name: string): boolean {
  return BRIDGE_SAFE.has(name);
}
