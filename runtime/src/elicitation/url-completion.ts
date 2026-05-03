/**
 * Keeps MCP URL completion notifications distinct from user-entered accept
 * responses inside the AgenC TUI bridge.
 *
 * MCP completion notifications already resolve the runtime-side pending
 * request. Daemon-backed TUI sessions still need to remove the local prompt,
 * but must not send a second elicitation response back to the daemon.
 *
 * @module
 */

import type { McpElicitationResponse } from "./types.js";

const completionResponses = new WeakSet<McpElicitationResponse>();

export function createMcpUrlCompletionResponse(): McpElicitationResponse {
  const response: McpElicitationResponse = { action: "accept" };
  completionResponses.add(response);
  return response;
}

export function isMcpUrlCompletionResponse(
  response: McpElicitationResponse | null | undefined,
): boolean {
  return response !== null &&
    response !== undefined &&
    completionResponses.has(response);
}
