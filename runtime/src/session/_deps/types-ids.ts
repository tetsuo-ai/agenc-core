/**
 * Per-dir branded ID stubs for `runtime/src/session/**`.
 *
 * Mirrors `runtime/src/types/ids.ts` so session callers keep the
 * branded `AgentId` / `SessionId` types after the openclaude umbrella
 * `src/types/` directory is removed.
 */

export type SessionId = string & { readonly __brand: "SessionId" };
export type AgentId = string & { readonly __brand: "AgentId" };

export function asSessionId(id: string): SessionId {
  return id as SessionId;
}

export function asAgentId(id: string): AgentId {
  return id as AgentId;
}
