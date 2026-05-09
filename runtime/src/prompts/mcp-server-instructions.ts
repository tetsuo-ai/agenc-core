import type { AgenCConfig } from "../config/schema.js";
import type { Session } from "../session/session.js";
import type { McpServerInstructionsInput } from "./system-prompt.js";

/**
 * Resolve every connected MCP server that exposes textual `instructions`,
 * so the system-prompt assembler can surface them as a `# MCP Server
 * Instructions` block.
 *
 * Both the production turn driver (`runSingleTurn` in `bin/agenc.ts`,
 * via `prepareTurnRuntimeInputs`) and the /context display
 * (`session-compact.runContextUsage`) call this so the per-turn token
 * count shown to the operator matches what the model actually sees on
 * the next turn boundary.
 *
 * Lives in its own module so the /context command path doesn't have to
 * import the CLI bin entry — that file pulls in the full bootstrap graph
 * and would be heavy to load from a command module.
 */
export async function loadSessionMcpServerInstructions(
  session: Session,
  config: AgenCConfig,
): Promise<readonly McpServerInstructionsInput[]> {
  const servers = await session.services.mcpManager.effectiveServers(
    config,
    null,
  );
  return Array.from(servers.entries())
    .flatMap(([name, info]) => {
      const instructions = (info as { readonly instructions?: unknown })
        .instructions;
      if (
        typeof instructions !== "string" ||
        instructions.trim().length === 0
      ) {
        return [];
      }
      return [{ name, instructions: instructions.trim() }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
