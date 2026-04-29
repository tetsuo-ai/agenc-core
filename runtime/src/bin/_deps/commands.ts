/**
 * Per-dir slash-command surface for `runtime/src/bin/**`.
 *
 * Bridges the bin entry to the canonical T11 slash-command system in
 * `runtime/src/commands/**`. The shim:
 *   - keeps the permissive `parseSlashCommand` shape that the bin
 *     wrapper relies on (the wrapper does not need the dispatcher's
 *     `(MCP)` marker)
 *   - performs the filesystem-passthrough check before dispatch so a
 *     mistyped path like `/notes.txt` or `/README` still becomes a
 *     normal user prompt rather than an unknown-command error
 *   - delegates real command dispatch to the canonical
 *     `dispatchSlashCommand` + the registry built by
 *     `buildDefaultRegistry()` so every restored T11 command (`/help`,
 *     `/exit`, `/permissions`, …) actually executes
 *   - re-exports the canonical bridge-safe allowlist
 *   - wires the global registry slot through the canonical
 *     `setGlobalCommandRegistry` so `/help` (which reads the global
 *     slot) sees the real list
 */

import {
  dispatchSlashCommand as realDispatch,
  isBridgeSafeCommand as realIsBridgeSafe,
  type DispatchOutcome as RealDispatchOutcome,
  type ParsedSlashCommand as RealParsedSlashCommand,
} from "../../commands/dispatcher.js";
import {
  buildDefaultRegistry as realBuildRegistry,
  CommandRegistry as RealCommandRegistry,
} from "../../commands/registry.js";
import {
  getGlobalCommandRegistry as realGetGlobal,
  setGlobalCommandRegistry as realSetGlobal,
  type SlashCommandContext as RealSlashCommandContext,
  type SlashCommandResult as RealSlashCommandResult,
} from "../../commands/types.js";

// ---------------------------------------------------------------------------
// Re-exported types (the bin wrapper imports through this seam only)
// ---------------------------------------------------------------------------

export type DispatchOutcome = RealDispatchOutcome & {
  /**
   * Bin-only marker emitted when the dispatcher decided to forward the
   * raw input as a user prompt instead of executing a command (mistyped
   * filesystem path). The canonical dispatcher's `result.kind === "skip"`
   * already signals this; the bin wrapper consumes `passthroughInput`
   * for backward compatibility with the lean shim contract.
   */
  passthroughInput?: string;
};
export type CommandRegistry = RealCommandRegistry;
export type SlashCommandContext = RealSlashCommandContext;
export type SlashCommandResult = RealSlashCommandResult;

// ---------------------------------------------------------------------------
// Permissive parser (kept identical to the lean shim shape)
// ---------------------------------------------------------------------------

export interface ParsedSlashLine {
  readonly name: string;
  readonly argsRaw: string;
}

/**
 * Permissive slash-line parser. Returns `null` when the input is not a
 * dispatchable slash command:
 *   - non-slash input (no leading `/`) → `null`
 *   - empty body after `/` → `null`
 *   - I-68 fence: when a slash line is followed by another non-empty
 *     line, the parse is rejected → `null`
 *   - otherwise the first whitespace-separated token is the command
 *     name and the rest is `argsRaw`.
 *
 * The parser intentionally accepts names the canonical dispatcher's
 * strict regex would reject (e.g. `/notes.txt`) so the dispatch step
 * can surface them as filesystem passthroughs.
 */
export function parseSlashCommand(input: string): ParsedSlashLine | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return null;

  // I-68: enforce single-line slash input. A trailing newline is fine,
  // but any non-whitespace follow-up content rejects the parse.
  const newlineIdx = trimmed.indexOf("\n");
  if (newlineIdx !== -1) {
    const tail = trimmed.slice(newlineIdx + 1);
    if (tail.trim().length > 0) {
      return null;
    }
  }

  const head =
    newlineIdx !== -1 ? trimmed.slice(0, newlineIdx) : trimmed;
  const body = head.slice(1);
  const space = body.search(/\s/);
  if (space === -1) {
    return body.length === 0 ? null : { name: body, argsRaw: "" };
  }
  return {
    name: body.slice(0, space),
    argsRaw: body.slice(space + 1).trim(),
  };
}

// ---------------------------------------------------------------------------
// Bridge-safe allowlist — delegated to the canonical dispatcher.
// ---------------------------------------------------------------------------

export function isBridgeSafeCommand(name: string): boolean {
  return realIsBridgeSafe(name);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Names accepted by the canonical dispatcher (strict shape). */
const COMMAND_NAME_SHAPE = /^[a-z][a-z0-9_-]*$/;

export async function dispatchSlashCommand(
  parsed: ParsedSlashLine,
  ctx: SlashCommandContext,
  registry: CommandRegistry,
): Promise<DispatchOutcome> {
  // Filesystem-path passthrough: if an unknown slash-prefixed token
  // resolves to an existing file or directory in the caller's `cwd`,
  // treat the line as a normal user prompt rather than a command. Known
  // command names win over files, so a local `./help` cannot shadow
  // `/help`.
  if (parsed.name.length > 0 && registry.find(parsed.name) === undefined) {
    const cwd =
      typeof (ctx as { cwd?: unknown })?.cwd === "string"
        ? ((ctx as { cwd?: string }).cwd ?? "")
        : "";
    if (cwd) {
      try {
        const { existsSync } = await import("node:fs");
        const { join: joinPath } = await import("node:path");
        if (existsSync(joinPath(cwd, parsed.name))) {
          const passthroughLine =
            parsed.argsRaw.length > 0
              ? `/${parsed.name} ${parsed.argsRaw}`
              : `/${parsed.name}`;
          return {
            result: { kind: "skip" },
            immediate: false,
            trace: {
              name: parsed.name,
              aliasUsed: parsed.name,
              argsRaw: parsed.argsRaw,
              sensitive: false,
              immediate: false,
              isMcp: false,
              resultKind: "skip",
            },
            passthroughInput: passthroughLine,
          };
        }
      } catch {
        /* best effort — fall through to the real dispatcher */
      }
    }
  }

  // Names that don't fit the canonical command shape but didn't resolve
  // to a filesystem entry: surface as an explicit unknown-command
  // error so the CLI can render a readable message. The canonical
  // dispatcher would reject these at the parser, so we synthesize a
  // matching outcome here.
  if (!COMMAND_NAME_SHAPE.test(parsed.name)) {
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
        isMcp: false,
        resultKind: "error",
      },
    };
  }

  const parsedFull: RealParsedSlashCommand = {
    name: parsed.name,
    argsRaw: parsed.argsRaw,
    isMcp: false,
  };
  return realDispatch(parsedFull, ctx, registry);
}

// ---------------------------------------------------------------------------
// Registry — lazily built once and shared with the global slot so /help
// (and any future "list registered commands" surface) sees the real set.
// ---------------------------------------------------------------------------

let cachedRegistry: CommandRegistry | null = null;
export function buildDefaultRegistry(): CommandRegistry {
  if (cachedRegistry !== null) return cachedRegistry;
  cachedRegistry = realBuildRegistry();
  return cachedRegistry;
}

export function getGlobalCommandRegistry(): CommandRegistry | null {
  return realGetGlobal() as CommandRegistry | null;
}

export function setGlobalCommandRegistry(
  registry: CommandRegistry | null,
): void {
  realSetGlobal(registry);
}
