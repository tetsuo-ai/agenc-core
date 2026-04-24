/**
 * TUI-facing bridge to the canonical slash-command registry.
 *
 * The composer only consumes the presentation subset of the command
 * contract, but it must read the same registry that `/help` and the
 * CLI/TUI submit path dispatch through. A local fallback registry makes
 * the slash palette lie about what is actually available.
 */

import {
  buildDefaultRegistry as buildCanonicalDefaultRegistry,
  type CommandRegistry,
} from "../../commands/registry.js";
import {
  getGlobalCommandRegistry as getCanonicalGlobalCommandRegistry,
  setGlobalCommandRegistry as setCanonicalGlobalCommandRegistry,
  type SlashCommand as SlashCommandLike,
  type SlashCommandResult,
} from "../../commands/types.js";

export type {
  CommandRegistry,
  SlashCommandLike,
  SlashCommandResult,
};

export function setGlobalCommandRegistry(reg: CommandRegistry | null): void {
  setCanonicalGlobalCommandRegistry(reg);
}

export function getGlobalCommandRegistry(): CommandRegistry | null {
  return getCanonicalGlobalCommandRegistry() as CommandRegistry | null;
}

export function buildDefaultRegistry(): CommandRegistry {
  const registry = buildCanonicalDefaultRegistry();
  if (getGlobalCommandRegistry() === null) {
    setGlobalCommandRegistry(registry);
  }
  return registry;
}
