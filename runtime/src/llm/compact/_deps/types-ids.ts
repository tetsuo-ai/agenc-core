/**
 * Per-dir branded ID stubs for `runtime/src/llm/compact/**`.
 *
 * Mirrors the openclaude `runtime/src/types/ids.ts` shape so the
 * compact tree keeps its branded `AgentId` / `SessionId` types after
 * the AgenC umbrella `src/types/` directory is removed.
 */

export type SessionId = string & { readonly __brand: "SessionId" };
export type AgentId = string & { readonly __brand: "AgentId" };

export function asSessionId(id: string): SessionId {
  return id as SessionId;
}

export function asAgentId(id: string): AgentId {
  return id as AgentId;
}

const AGENT_ID_PATTERN = /^a(?:.+-)?[0-9a-f]{16}$/;

export function toAgentId(s: string): AgentId | null {
  return AGENT_ID_PATTERN.test(s) ? (s as AgentId) : null;
}
