/**
 * MCP-instructions delta attachment producer.
 *
 * Hand-port of openclaude `getMcpInstructionsDeltaAttachment`
 * (`src/utils/attachments.ts:1560-1586`) and the underlying diff in
 * `getMcpInstructionsDelta` (`src/utils/mcpInstructionsDelta.ts:55`).
 *
 * Fires when the set of connected MCP servers exposing `instructions`
 * has changed since the last announcement. MCP server `instructions`
 * are immutable for the lifetime of a connection (set once at the
 * `InitializeResult` handshake), so the diff key is the server name.
 *
 * AgenC divergence from openclaude: the prior-announced map is tracked
 * directly on `AttachmentTrackingState.lastMcpInstructionsMap` (server
 * name → instruction block) instead of being reconstructed from prior
 * `mcp_instructions_delta` attachments in the message history.
 *
 * STATUS — MCP instructions surface gap:
 *
 * AgenC's `MCPManager` (runtime/src/mcp-client/manager.ts) currently
 * exposes `getConnectedServers(): string[]` — server names only — and
 * does not surface the `InitializeResult.instructions` blob from the
 * stdio/sse transport. There is no public method to read instructions
 * per server today.
 *
 * This producer reads instructions defensively through an extended
 * `getServerInstructions(name): string | undefined` accessor on the
 * manager (probed via duck-typing), and through the per-bridge
 * `instructions` field if exposed. When neither is available — the
 * current state of AgenC — the producer iterates the server list,
 * finds no instructions, and emits nothing.
 *
 * To activate: extend `MCPManager` with a public method that returns
 * each connected server's `InitializeResult.instructions`. The producer
 * picks it up automatically without further wiring.
 *
 * @module
 */

import type { AttachmentProducer } from "./orchestrator.js";

interface SessionLikeForMcpInstructions {
  readonly services?: {
    readonly mcpManager?: McpManagerLikeForInstructions;
  };
}

interface McpManagerLikeForInstructions {
  /** AgenC public surface today (returns server names). */
  getConnectedServers?(): readonly string[];
  /**
   * Forward-looking accessor — not yet present on AgenC's `MCPManager`.
   * When the MCP client surfaces `InitializeResult.instructions`, this
   * accessor is the agreed seam: return the instructions blob for
   * `name`, or `undefined` when the server has none.
   */
  getServerInstructions?(name: string): string | undefined;
}

function readConnectedInstructions(
  sessionKey: object,
): ReadonlyMap<string, string> {
  const session = sessionKey as SessionLikeForMcpInstructions;
  const manager = session.services?.mcpManager;
  if (manager === undefined) return new Map();
  const names = manager.getConnectedServers?.() ?? [];
  const out = new Map<string, string>();
  if (manager.getServerInstructions === undefined) return out;
  for (const name of names) {
    const instructions = manager.getServerInstructions(name);
    if (typeof instructions === "string" && instructions.length > 0) {
      out.set(name, instructions);
    }
  }
  return out;
}

export const mcpInstructionsDeltaProducer: AttachmentProducer = async (
  opts,
  trackingState,
) => {
  const currentMap = readConnectedInstructions(opts.sessionKey);
  const prior = trackingState.lastMcpInstructionsMap;

  if (prior === undefined) {
    // First turn — seed without emitting. Initial connections are
    // already announced through the system prompt's MCP section.
    trackingState.lastMcpInstructionsMap = currentMap;
    return [];
  }

  const added: { name: string; block: string }[] = [];
  for (const [name, block] of currentMap) {
    if (!prior.has(name)) added.push({ name, block });
  }
  const removed: string[] = [];
  for (const name of prior.keys()) {
    if (!currentMap.has(name)) removed.push(name);
  }

  if (added.length === 0 && removed.length === 0) return [];

  added.sort((a, b) => a.name.localeCompare(b.name));
  removed.sort((a, b) => a.localeCompare(b));

  trackingState.lastMcpInstructionsMap = currentMap;

  return [
    {
      kind: "mcp_instructions_delta",
      addedNames: added.map((a) => a.name),
      addedBlocks: added.map((a) => a.block),
      removedNames: removed,
    },
  ];
};
