/**
 * Local stub for openclaude `commands/types.ts` and `commands/registry.ts`.
 *
 * The composer only needs three pieces of the slash-command surface:
 *
 *  - `getGlobalCommandRegistry()` — returns whatever the live runtime
 *    has installed via `setGlobalCommandRegistry`. The gut TUI never
 *    has a registry installed during the cleanup window, so this just
 *    returns the locally-tracked value (initially null).
 *  - `buildDefaultRegistry()` — a fallback used when no live registry
 *    is installed. The shim returns an empty registry so the palette
 *    silently shows no slash commands instead of crashing.
 *  - `SlashCommandResult` is a type-only import elsewhere in the tui;
 *    re-exported here so callers can switch to the local path.
 */

export interface SlashCommandLike {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description?: string;
  readonly immediate?: boolean;
  readonly userInvocable?: boolean;
}

export interface CommandRegistry {
  list(): readonly SlashCommandLike[];
  find?(nameOrAlias: string): SlashCommandLike | undefined;
}

export type SlashCommandResult =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "compact"; readonly text: string }
  | { readonly kind: "prompt"; readonly content: string }
  | { readonly kind: "skip" }
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "error"; readonly message: string };

let globalRegistry: CommandRegistry | null = null;

export function setGlobalCommandRegistry(reg: CommandRegistry | null): void {
  globalRegistry = reg;
}

export function getGlobalCommandRegistry(): CommandRegistry | null {
  return globalRegistry;
}

class EmptyCommandRegistry implements CommandRegistry {
  list(): readonly SlashCommandLike[] {
    return [];
  }
  find(_nameOrAlias: string): SlashCommandLike | undefined {
    return undefined;
  }
}

export function buildDefaultRegistry(): CommandRegistry {
  return new EmptyCommandRegistry();
}
