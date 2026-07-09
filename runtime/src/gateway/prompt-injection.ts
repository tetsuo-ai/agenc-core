/**
 * Lightweight channel-level prompt-injection tripwire.
 *
 * The real security boundary remains `frameChannelMessage()` plus daemon/tool
 * policy. This detector only catches obvious public-chat jailbreak attempts
 * early so they do not waste model turns or become part of the transcript.
 */

const HIDDEN_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

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
    reason: "instruction override",
    pattern:
      /\b(?:ignore|forget|disregard|override|bypass|drop)\b[\s\S]{0,90}\b(?:previous|above|system|developer|hidden|original|all)\b[\s\S]{0,70}\b(?:instruction|prompt|rule|guardrail|policy|message)s?\b/i,
  },
  {
    reason: "secret or prompt exfiltration",
    pattern:
      /\b(?:reveal|print|show|dump|leak|exfiltrate|send)\b[\s\S]{0,80}\b(?:system prompt|developer message|hidden prompt|instructions|api key|token|secret|wallet|private key)\b/i,
  },
  {
    reason: "role jailbreak",
    pattern:
      /\b(?:you are now|act as|become|switch to)\b[\s\S]{0,80}\b(?:system|developer|admin|root|unrestricted|jailbroken|no[-\s]?rules)\b/i,
  },
  {
    reason: "permission/policy override",
    pattern:
      /\b(?:disable|remove|change|set|relax|broaden|unlock)\b[\s\S]{0,80}\b(?:permissions?|sandbox|tool policy|wallet policy|signer policy|approval|guardrails?)\b/i,
  },
  {
    reason: "fake approval authority",
    pattern:
      /\b(?:approve|allow|pre[-\s]?authorize)\b[\s\S]{0,60}\b(?:all|every|tool|command|wallet|transaction|payment|spend|signing)\b/i,
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
        reply:
          "Nice try. Prompt injection blocked. Ask a real AgenC question or stop wasting bandwidth.",
      };
    }
  }
  return { blocked: false };
}
