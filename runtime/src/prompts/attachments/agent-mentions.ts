/**
 * Agent-mention attachment producer.
 *
 * Hand-port of openclaude `processAgentMentions()`
 * (`src/utils/attachments.ts:1967-1994`). Scans the latest user input
 * for `@agent-<type>` mentions and emits one `agent_mention` attachment
 * per unique reference.
 *
 * Supports both formats openclaude accepts at `:2822-2848`:
 *   1. `@agent-<type>` (legacy/manual typing)
 *   2. `@"<type> (agent)"` (autocomplete-selected)
 *
 * AgenC does not currently expose a synchronous agent registry to the
 * orchestrator, so this producer does NOT validate that the named agent
 * actually exists. Every detected mention emits an attachment; the
 * downstream consumer (system-reminder rendering) is harmless when the
 * agent type is unknown. When an agent registry becomes available on
 * the session, gate the emit on registry membership here. (TODO.)
 *
 * @module
 */

import type { AgentMentionAttachment } from "./types.js";
import type { AttachmentProducer } from "./orchestrator.js";

/** Match `@"<type> (agent)"` autocomplete form. */
const QUOTED_AGENT_RE = /(^|\s)@"([\w:.@-]+) \(agent\)"/g;
/** Match `@agent-<type>` legacy form. */
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
  const out: AgentMentionAttachment[] = [];
  for (const agentType of types) {
    out.push({ kind: "agent_mention", agentType });
  }
  return out;
};
