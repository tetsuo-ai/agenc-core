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

/** Match `@"<type> (agent)"` autocomplete form. */
const QUOTED_AGENT_RE = /(^|\s)@"([\w:.@-]+) \(agent\)"/g;
/** Match `@agent-<type>` compatibility form. */
const UNQUOTED_AGENT_RE = /(^|\s)@(agent-[\w:.@-]+)/g;

/**
 * Extract the set of unique agent identifiers (already prefixed
 * `agent-...` for the unquoted form, bare type for the quoted form) from
 * a text input. Returns an empty list when input is null/empty.
 */
export function extractAgentMentions(input: string | null): string[] {
  if (input === null || input.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];

  let m: RegExpExecArray | null;
  QUOTED_AGENT_RE.lastIndex = 0;
  while ((m = QUOTED_AGENT_RE.exec(input)) !== null) {
    const type = m[2];
    if (typeof type !== "string" || type.length === 0) continue;
    if (seen.has(type)) continue;
    seen.add(type);
    out.push(type);
  }

  UNQUOTED_AGENT_RE.lastIndex = 0;
  while ((m = UNQUOTED_AGENT_RE.exec(input)) !== null) {
    const raw = m[2];
    if (typeof raw !== "string" || !raw.startsWith("agent-")) continue;
    const type = raw.slice("agent-".length);
    if (type.length === 0) continue;
    if (seen.has(type)) continue;
    seen.add(type);
    out.push(type);
  }

  return out;
}

export const agentMentionsProducer: AttachmentProducer = async (opts) => {
  const types = extractAgentMentions(opts.userInput);
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
