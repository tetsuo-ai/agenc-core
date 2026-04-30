/**
 * Upstream `Command[]` adapter for the AgenC TUI.
 *
 * The upstream-derived `<Messages>` and `<PromptInput>` components
 * consume a `Command[]` shape (see `../upstream/types/command.ts`) for
 * slash-command autocomplete and ghost-text rendering. AgenC owns its
 * own slash-command registry under `../../commands/` with a different
 * shape (`SlashCommand`).
 *
 * This adapter projects the AgenC registry into the upstream `Command`
 * shape so the TUI autocomplete surface lights up with real entries.
 *
 * Execution path: when the user submits a slash command, the AgenC
 * dispatcher (`commands/dispatcher.ts`) runs it. The upstream `load()`
 * execution path is NOT wired and must not be invoked — the adapter
 * installs a `load()` that throws if anyone calls it.
 *
 * @module
 */
import type { Command } from "../upstream/commands.js";
import type { SlashCommand } from "../../commands/types.js";
import { buildDefaultRegistry } from "../../commands/registry.js";

/**
 * Project a single AgenC `SlashCommand` into the upstream `Command`
 * shape. Uses the `local` discriminator since AgenC commands resolve
 * to text/prompt/exit/etc. results, not React JSX panels.
 *
 * `load()` throws on call: AgenC commands must execute through the
 * runtime dispatcher, not upstream's load path.
 */
function projectSlashCommand(cmd: SlashCommand): Command {
  return {
    type: "local",
    name: cmd.name,
    description: cmd.description,
    aliases: cmd.aliases ? [...cmd.aliases] : undefined,
    supportsNonInteractive: true,
    load: async () => {
      throw new Error(
        `Upstream command load() invoked for AgenC command "${cmd.name}"; ` +
          "AgenC commands execute through the runtime dispatcher, not the upstream load path.",
      );
    },
  };
}

/**
 * Build the upstream-shaped command list for the TUI.
 *
 * - Calls `buildDefaultRegistry()` once per call (caller is expected to
 *   memoize across renders; the registry itself is cheap to construct
 *   but the projection allocates new objects each call).
 * - Filters out commands marked `userInvocable === false` so internal-only
 *   entries do not surface in autocomplete.
 * - Preserves the registration order from `buildDefaultRegistry`.
 */
export function loadUpstreamCommandList(): readonly Command[] {
  const registry = buildDefaultRegistry();
  const result: Command[] = [];
  for (const cmd of registry.list()) {
    if (cmd.userInvocable === false) {
      continue;
    }
    result.push(projectSlashCommand(cmd));
  }
  return result;
}
