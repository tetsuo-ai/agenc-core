/**
 * `canUseTool` permission hook (Cut 5.7).
 *
 * A single async function the dispatcher calls before invoking each
 * tool. The default implementation chains the existing AgenC
 * permission stack:
 *
 *   1. tool's own `Tool.checkPermissions()` (if defined)
 *   2. configured allow/deny rule patterns
 *   3. user-supplied async hook (e.g. interactive approval)
 *
 * Cut 7 will collapse the gateway-side `policy/engine.ts` +
 * `gateway/approvals.ts` + `policy/mcp-governance.ts` triplication
 * behind this single seam. For now this module ships the type shape
 * and a default permissive implementation so the rest of Cut 5 can
 * compile and call it.
 *
 * @module
 */

import type { LLMToolCall } from "./types.js";

export type PermissionResult =
  | {
      readonly behavior: "allow";
      readonly updatedInput?: Record<string, unknown>;
      readonly reason?: string;
    }
  | {
      readonly behavior: "ask";
      readonly message: string;
      readonly suggestions?: readonly RuleSuggestion[];
    }
  | {
      readonly behavior: "deny";
      readonly message: string;
      readonly reason?: string;
    };

interface RuleSuggestion {
  readonly description: string;
  readonly rule: string;
}

interface CanUseToolContext {
  readonly sessionId?: string;
  readonly chainId?: string;
  readonly depth?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type CanUseToolFn = (
  toolCall: LLMToolCall,
  context: CanUseToolContext,
) => Promise<PermissionResult>;

/**
 * Default no-op canUseTool that allows everything. Runtime callers
 * (chat-executor, sub-agent) supply their own at construction time;
 * this only fires when nobody plumbs a real implementation through.
 */
/**
 * Compose multiple canUseTool functions into one. The first non-allow
 * decision wins. Useful for stacking the built-in policy check on top
 * of a user-provided interactive approver.
 */
