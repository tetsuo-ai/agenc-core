/**
 * Lightweight channel-level prompt-injection tripwire.
 *
 * The real security boundary remains `frameChannelMessage()` plus daemon/tool
 * policy. This detector only catches obvious public-chat jailbreak attempts
 * early so they do not waste model turns or become part of the transcript.
 *
 * A blocked message never reaches the media, X search or on-chain features or
 * the agent, so a false positive costs more than a miss. The rules therefore
 * match only a forged wrapper tag or a phrase aimed at the model's own
 * instructions. Do not add rules that pair a common verb with tokens, wallets,
 * keys, permissions, the sandbox, approvals or roles: ordinary questions about
 * those topics read the same as an attack, and the boundary above already
 * covers them.
 */

const HIDDEN_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

/**
 * The reply to a blocked message. Neutral on purpose: the tripwire can misfire
 * on an honest question, so the sender is only asked to rephrase.
 */
export const PROMPT_INJECTION_REPLY =
  "I can't act on that message. Ask me a question about AgenC instead.";

export interface PromptInjectionDecision {
  readonly blocked: boolean;
  readonly reason?: string;
  readonly reply?: string;
}

interface Rule {
  readonly reason: string;
  readonly pattern: RegExp;
}

const RULES: readonly Rule[] = [
  {
    reason: "forged channel/system wrapper",
    pattern: /<\s*\/?\s*(?:channel_message|system-reminder|developer|system)\b/i,
  },
  {
    // "ignore all previous system instructions": an override verb, then within
    // the same clause (no . ! ? , ; : and at most 60 characters in between) a
    // qualifier, then the noun it modifies (at most two words and no , ; : in
    // between). The bounded gaps keep the halves together and the scan
    // linear. "message" and "policy" are not nouns: "ignore my previous
    // message, ..." is how people retract a chat message, and the comma ends
    // the clause. "prior" and "earlier" count only after ignore or disregard:
    // "forget earlier instructions" and "override prior rules" are how people
    // ask about compaction and bids.
    reason: "instruction override",
    pattern:
      /\b(?:(?:ignore|disregard)\b[^.!?,;:]{0,60}?\b(?:previous|prior|above|earlier|system|developer)|(?:forget|override)\b[^.!?,;:]{0,60}?\b(?:previous|above|system|developer))\b(?:[^\w.!?,;:]+\w+){0,2}?[^\w.!?,;:]+(?:instructions?|prompts?|rules?|guardrails?)\b/i,
  },
  {
    // "print your system prompt": a disclosure verb, at most three words, then
    // a name for the model's own prompt. Tokens, wallets, keys, secrets and a
    // bare "instructions" are not targets: people ask to see those all day.
    reason: "prompt exfiltration",
    pattern:
      /\b(?:reveal|print|show|dump|leak)\b(?:[^\w.!?,;:]+\w+){0,3}?[^\w.!?,;:]+(?:system[\s-]+prompts?|developer[\s-]+messages?|hidden[\s-]+prompts?|initial[\s-]+instructions?)\b/i,
  },
];

export function normalizeForPromptInjectionScan(text: string): string {
  return text
    .normalize("NFKC")
    .replace(HIDDEN_CONTROL_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectPromptInjectionAttempt(
  text: string,
): PromptInjectionDecision {
  const normalized = normalizeForPromptInjectionScan(text);
  if (normalized.length === 0) return { blocked: false };

  for (const rule of RULES) {
    if (rule.pattern.test(normalized)) {
      return {
        blocked: true,
        reason: rule.reason,
        reply: PROMPT_INJECTION_REPLY,
      };
    }
  }
  return { blocked: false };
}
