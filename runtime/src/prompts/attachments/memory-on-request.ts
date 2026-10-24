/**
 * Memory-on-request attachment producer (interactive sessions, Light or
 * standard, whose memory was empty when the prompt was assembled).
 *
 * Such a session's fixed prefix carries no memory rules and no memory
 * directories (memory/memdir.ts loadMemoryPrompt). When the root human message
 * of a turn asks about memory or states something worth keeping (who the user
 * is, how they work, standing instructions, team or project facts, pointers to
 * external systems), the producer sends the same rules and directories once, on
 * that turn's first request. The retention ledger anchors the reminder before
 * the message and replays it in place on every later request, so the cached
 * prefix never moves and the rules are not sent twice. The background memory
 * extractor keeps saving project facts from the conversation either way
 * (services/extractMemories).
 *
 * @module
 */

import type { LLMMessage } from "../../llm/types.js";
import { LIGHT_MEMORY_RULES_MARKER, MEMORY_RULES_MARKER } from "../../memory/memdir.js";
import type { AttachmentProducer } from "./orchestrator.js";

/** Roles in "I'm a data engineer", "I am the release manager". */
const ROLE = String.raw`(?:engineer|developer|dev|programmer|coder|designer|manager|lead|maintainer|owner|architect|scientist|analyst|student|researcher|admin(?:istrator)?|sre|devops|founder|cto|ceo|cfo|vp|director|intern|consultant|contractor|freelancer|beginner|novice|newcomer|expert|specialist|tester|qa|reviewer|writer|teacher|professor|pm)s?`;

/** External systems a pointer names ("Bugs are tracked in Jira project PAY"). */
const SYSTEMS = String.raw`(?:jira|linear|confluence|notion|grafana|datadog|sentry|pagerduty|opsgenie|kibana|splunk|slack|trello|asana)`;

/**
 * Messages about memory, or that state durable facts. A false match costs one
 * reminder of about 350 tokens on every request of that turn; a miss leaves the
 * save to the background extractor. Each pattern names memory itself or a
 * statement worth keeping, never a word that ordinary task requests use:
 * "memory" as RAM, a URL in a task, "I'm new to this repo" or "I'm getting an
 * error" do not match.
 */
const MEMORY_REQUEST = new RegExp([
  // Asking to remember, recall or forget, and the assistant's memory itself.
  String.raw`(?:^|[.!?]\s+)(?:please |also |and )?(?:remember|memori[sz]e|forget)\b`,
  String.raw`\b(?:please|can you|could you|will you|would you|do you|did you|you should|try to|make sure to|be sure to) (?:remember|memori[sz]e|recall|forget)\b`,
  String.raw`\b(?:remember|memori[sz]e) (?:that|this|these|it|me|my|for)\b`,
  String.raw`\bforget (?:my|that|this|these|it|what|about|everything|all)\b`,
  String.raw`\b(?:your|persistent|long[- ]term|durable|saved|stored|auto) memor(?:y|ies)\b|\b(?:my|your|saved|stored) memories\b|\bMEMORY\.md\b`,
  String.raw`\bignore (?:all |any |your |the )?(?:saved |stored |persistent )?memor(?:y|ies)\b|\bmemory topics?\b|\bmy (?:saved|stored|remembered) \w+`,
  String.raw`\b(?:know|remember|recall|learned|saved|stored) about me\b`,
  String.raw`\b(?:keep (?:it|this|that) in mind|note (?:that|this) down|from now on|going forward|for future (?:reference|sessions|conversations|tasks)|in future (?:sessions|conversations|chats|tasks)|next time you)\b`,
  // Who the user is and how they work.
  String.raw`\bI(?:'m| am) (?:a|an|the|your|one of the) (?:[\w-]+ ){0,3}${ROLE}\b`,
  String.raw`\bI(?:'m| am) (?:on|in|part of) (?:the|our|a) (?:[\w-]+ ){1,2}team\b`,
  String.raw`\bI(?:'m| am) (?:responsible for|in charge of|based in|located in)\b`,
  String.raw`\bI(?:'ve| have) (?:been )?\w+(?:ing|ed|en)\b[^.!?]{0,40}\bfor (?:\w+ ){0,2}(?:years|decades)\b`,
  String.raw`\bcall me\b`,
  String.raw`\bmy (?:name|role|job|title|team|company|pronouns|time ?zone) (?:is|are)\b|\bmy (?:preferences?|preferred|usual workflow)\b`,
  String.raw`\bI (?:prefer|like|love|hate|dislike)\b|\bI'?d (?:rather|prefer)\b|\bI (?:usually|always|never) (?:use|want|prefer|work|write|run|deploy|commit|test|format|review)\b`,
  // Feedback and standing instructions.
  String.raw`\bplease (?:always|never)\b|\b(?:always|never) \w+\b[^.!?]{0,60}\b(?:in this (?:repo|repository|project|codebase)|for this (?:repo|repository|project))\b`,
  String.raw`(?:^|[.!?]\s+)(?:please )?stop \w+ing\b`,
  String.raw`\bkeep doing (?:that|this|it)\b`,
  // Team and project context, and pointers to external systems.
  String.raw`\bwe (?:only |also |still |usually |always |never |don'?t |do not )?(?:use|prefer|deploy|release|ship)\b|\bwe (?:always|never|usually)\b`,
  String.raw`\bwe(?:'re| are) (?:freezing|moving|migrating|switching|deprecating|ripping|replacing|dropping|standardi[sz]ing|sunsetting)\b`,
  String.raw`\bwhere we (?:track|keep|discuss|document|log|store)\b|\bwe track\b`,
  String.raw`\bour (?:team|convention|conventions|style|process|policy|policies|standard|standards|deadline|release|on-?call|dashboard|wiki)\b`,
  String.raw`\b(?:code|merge|release|feature) freeze\b|\bpostmortem\b|\bon-?call\b`,
  String.raw`\b${SYSTEMS}\b[^.!?]{0,60}\b(?:project|board|channel|space|page|dashboard|queue)\b`,
  String.raw`\b(?:tracked|documented|discussed|filed|reported) (?:in|on) (?:the )?${SYSTEMS}\b`,
  String.raw`\b(?:staging|production|prod|team|ops|monitoring|status) (?:dashboard|board|runbook|wiki|channel)\b`,
].join("|"), "iu");

/** Whether `text` is about memory or states something worth keeping. */
export function asksAboutMemory(text: string): boolean {
  return MEMORY_REQUEST.test(text);
}

function contains(messages: readonly LLMMessage[], needle: string): boolean {
  return messages.some((message) => {
    if (typeof message.content === "string") return message.content.includes(needle);
    return message.content.some((part) =>
      (part as { type?: string }).type === "text" &&
      ((part as { text?: string }).text ?? "").includes(needle));
  });
}

export const memoryOnRequestProducer: AttachmentProducer = async (opts) => {
  const resolve = opts.memoryOnRequest;
  if (resolve === undefined) return [];
  // Only the human's own message of this turn decides.
  const provenance = opts.turnProvenance;
  const root = provenance?.rootHumanTurn;
  if (provenance === undefined || root === null || root === undefined ||
      root.turnId !== provenance.turnId) {
    return [];
  }
  if (!asksAboutMemory(root.text)) return [];
  // Already in front of the model: retained from an earlier request or turn.
  if (contains(opts.messages, LIGHT_MEMORY_RULES_MARKER) || contains(opts.messages, MEMORY_RULES_MARKER)) return [];
  const content = await resolve();
  return content === undefined || content.length === 0
    ? []
    : [{ kind: "memory_on_request", content }];
};
