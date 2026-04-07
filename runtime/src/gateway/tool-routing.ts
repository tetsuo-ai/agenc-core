/**
 * Tool routing — claude_code-shaped static allowed tools (Cut 4.2).
 *
 * Replaces the previous 1,848-LOC `ToolRouter` machinery whose entire
 * job was per-phase narrowing of the tool set during planner-driven
 * turns. claude_code exposes a single static tool list per query, so
 * the runtime no longer maintains per-cluster routing caches, schema
 * cost ledgers, or invalidation signals.
 *
 * The `ToolRoutingDecision` shape is preserved as a type so existing
 * trace serialization, channel-wiring callbacks, and chat-executor
 * routing summaries keep their structural shape during the transition.
 * Every live producer now returns `undefined`.
 *
 * @module
 */

export interface ToolRoutingDecision {
  readonly routedToolNames: readonly string[];
  readonly expandedToolNames: readonly string[];
  readonly diagnostics: {
    readonly cacheHit: boolean;
    readonly clusterKey: string;
    readonly confidence: number;
    readonly invalidatedReason?: string;
    readonly totalToolCount: number;
    readonly routedToolCount: number;
    readonly expandedToolCount: number;
    readonly schemaCharsFull: number;
    readonly schemaCharsRouted: number;
    readonly schemaCharsExpanded: number;
    readonly schemaCharsSaved: number;
  };
}

/**
 * Resolve the static allowed-tool name set for a session. The previous
 * router consulted a long set of cluster heuristics; static allowed
 * tools are now derived from the gateway's permission rules + tool
 * registry, and this helper exists only as a stable single source of
 * truth callers can resolve tool names through.
 */
export function resolveAllowedTools(
  allowedToolNames: readonly string[] | undefined,
): readonly string[] {
  return allowedToolNames ? Array.from(new Set(allowedToolNames)) : [];
}
