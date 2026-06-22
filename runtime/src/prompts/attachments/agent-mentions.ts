/**
 * Agent-mention attachment producer.
 *
 * Hand-port of reference `processAgentMentions()`
 * (`src/utils/attachments.ts:1967-1994`). Scans the latest user input
 * for `@agent-<type>` mentions and emits one `agent_mention` attachment
 * per unique reference that resolves to an active agent definition.
 *
 * Supports both formats AgenC accepts at `:2822-2848`:
 *   1. `@agent-<type>` (compatibility/manual typing)
 *   2. `@"<type> (agent)"` (autocomplete-selected)
 *
 * Mentions of unknown agent types are dropped — matches AgenC's
 * registry-gated emit at `:1980-1990`. The active set is read off the
 * session via `agentDefinitions.activeAgents`, the same surface
 * `agent-listing-delta` consults.
 *
 * @module
 */

import type { AgentMentionAttachment } from "./types.js";
import type { AttachmentProducer } from "./orchestrator.js";
import { extractAgentMentionTypes } from "../../utils/agentMentions.js";

export { extractAgentMentionTypes as extractAgentMentions } from "../../utils/agentMentions.js";

/**
 * Loose duck-type for the session-key shape produced by AgenC's runtime
 * context. Mirrors `agent-listing-delta.ts` — same field, same shape.
 */
interface SessionLikeForAgentMentions {
  readonly agentDefinitions?: {
    readonly activeAgents?: readonly unknown[];
  };
}

function readActiveAgentTypes(sessionKey: object): ReadonlySet<string> {
  const session = sessionKey as SessionLikeForAgentMentions;
  const raw = session.agentDefinitions?.activeAgents;
  if (!Array.isArray(raw)) return new Set();
  const out = new Set<string>();
  for (const candidate of raw) {
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      typeof (candidate as { agentType?: unknown }).agentType === "string"
    ) {
      const type = (candidate as { agentType: string }).agentType;
      if (type.length > 0) out.add(type);
    }
  }
  return out;
}

export const agentMentionsProducer: AttachmentProducer = async (opts) => {
  const types = extractAgentMentionTypes(opts.userInput);
  if (types.length === 0) return [];
  const known = readActiveAgentTypes(opts.sessionKey);
  // Empty registry = headless / pre-bootstrap. Match AgenC's
  // permissive behavior in that case (any mention emits) so unit tests
  // and bare-options invocations don't silently drop. When the registry
  // is populated, gate emits to known agents.
  const out: AgentMentionAttachment[] = [];
  for (const agentType of types) {
    if (known.size > 0 && !known.has(agentType)) continue;
    out.push({ kind: "agent_mention", agentType });
  }
  return out;
};
