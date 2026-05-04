/**
 * Command-list adapter for the AgenC TUI.
 *
 * The upstream-derived `<Messages>` and `<PromptInput>` components
 * consume a `Command[]` shape for
 * slash-command autocomplete and ghost-text rendering. AgenC owns its
 * own slash-command registry under `../../commands/` with a different
 * shape (`SlashCommand`).
 *
 * This adapter projects the AgenC registry into the upstream `Command`
 * shape so the TUI autocomplete surface lights up with real entries.
 *
 * Execution path: when the user submits a slash command, the AgenC
 * dispatcher (`commands/dispatcher.ts`) runs it. The projected commands
 * also expose a legacy `load().call()` adapter for remaining upstream
 * mirror consumers that still execute through processSlashCommand.
 *
 * @module
 */
import { getCommandsSync, type Command } from "../../commands.js";

/**
 * Project the AgenC registry into the command-list shape consumed by
 * the TUI. Runtime execution stays in `commands/dispatcher.ts`.
 */
export function loadUpstreamCommandList(): readonly Command[] {
  return getCommandsSync().filter(cmd => cmd.userInvocable !== false);
}
