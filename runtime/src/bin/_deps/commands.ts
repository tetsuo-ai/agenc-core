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

export function parseSlashCommand(input: string): ParsedSlashLine | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
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
  _ctx: SlashCommandContext,
  _registry: CommandRegistry,
): Promise<DispatchOutcome> {
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
