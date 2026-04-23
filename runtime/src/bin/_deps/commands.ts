/**
 * Per-dir slash-command surface for `runtime/src/bin/**`.
 *
 * The lean rebuild does not yet own a slash-command system; the gut
 * dispatcher / registry / types live in the openclaude-port
 * `runtime/src/commands/**`. This shim provides a permissive surface
 * that mirrors the names `bin/slash.ts` consumes so the bin entry
 * point can build without crossing into openclaude.
 *
 * Behavior is intentionally degraded: every command parses to `null`
 * (treated as a non-slash line by the wrapper) and the registry is a
 * placeholder. Real slash-command behavior will be reintroduced in a
 * later tranche.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DispatchOutcome = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CommandRegistry = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SlashCommandContext = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SlashCommandResult = any;

interface ParsedSlashLine {
  readonly name: string;
  readonly argsRaw: string;
}

/**
 * Permissive slash-line parser. Returns `null` when the input is not a
 * dispatchable slash command, mirroring the openclaude dispatcher
 * contract:
 *   - non-slash input (no leading `/`) → `null`
 *   - empty body after `/` → `null`
 *   - I-68 fence: when a slash line is followed by another non-empty
 *     line, the parse is rejected → `null`
 *   - otherwise the first whitespace-separated token is the command
 *     name and the rest is `argsRaw`.
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

const BRIDGE_SAFE = new Set<string>();

export function isBridgeSafeCommand(_name: string): boolean {
  return BRIDGE_SAFE.has(_name);
}

export async function dispatchSlashCommand(
  parsed: ParsedSlashLine,
  ctx: SlashCommandContext,
  _registry: CommandRegistry,
): Promise<DispatchOutcome> {
  // Filesystem-path passthrough: if the slash-prefixed token resolves
  // to an existing file or directory in the caller's `cwd`, treat the
  // line as a normal user prompt rather than a command. Mirrors the
  // openclaude dispatcher's `/notes.txt → passthrough` behavior so
  // mistyped paths don't surface as "Unknown command".
  const argsRaw =
    typeof (ctx as { argsRaw?: unknown })?.argsRaw === "string"
      ? ((ctx as { argsRaw?: string }).argsRaw ?? "")
      : "";
  if (argsRaw.length === 0 && parsed.name.length > 0) {
    const cwd =
      typeof (ctx as { cwd?: unknown })?.cwd === "string"
        ? ((ctx as { cwd?: string }).cwd ?? "")
        : "";
    if (cwd && (parsed.name.includes(".") || parsed.name.includes("/"))) {
      try {
        const { existsSync } = await import("node:fs");
        const { join: joinPath } = await import("node:path");
        if (existsSync(joinPath(cwd, parsed.name))) {
          return {
            result: { kind: "skip" },
            passthroughInput: `/${parsed.name}`,
          };
        }
      } catch {
        /* best effort — fall through to the unknown-command branch */
      }
    }
  }

  return {
    result: {
      kind: "error",
      message: `Unknown command: /${parsed.name}`,
    },
    passthroughInput: undefined,
  };
}

export function buildDefaultRegistry(): CommandRegistry {
  return { commands: new Map<string, unknown>() };
}

let globalRegistry: CommandRegistry | null = null;

export function getGlobalCommandRegistry(): CommandRegistry | null {
  return globalRegistry;
}

export function setGlobalCommandRegistry(
  registry: CommandRegistry | null,
): void {
  globalRegistry = registry;
}
