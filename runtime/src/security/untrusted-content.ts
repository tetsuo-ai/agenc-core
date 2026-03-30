/**
 * Utilities for handling attacker-controlled text before it reaches prompts,
 * tool policies, or UI surfaces that may be interpreted by an agent.
 *
 * @module
 */

export type PromptInjectionRiskLevel = "low" | "medium" | "high";

export interface PromptInjectionAssessment {
  readonly normalizedText: string;
  readonly safeSummary: string;
  readonly riskScore: number;
  readonly riskLevel: PromptInjectionRiskLevel;
  readonly matchedSignals: readonly string[];
  readonly executionEligible: boolean;
}

export interface StructuredTaskDescription {
  readonly objective: string;
  readonly deliverables: readonly string[];
  readonly constraints: readonly string[];
  readonly risk: PromptInjectionAssessment;
}

export interface SkillMetadataLike {
  readonly name: string;
  readonly description: string;
  readonly tags?: readonly string[];
}

interface RiskRule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly weight: number;
}

const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const INVISIBLE_CHARS_RE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
const MULTISPACE_RE = /[^\S\n]+/g;

const RISK_RULES: readonly RiskRule[] = [
  {
    id: "override_higher_priority_instructions",
    pattern:
      /\b(ignore|disregard|forget|override)\b[\s\S]{0,60}\b(previous|prior|system|developer|instruction|prompt|rules)\b/i,
    weight: 0.38,
  },
  {
    id: "identity_override",
    pattern: /\b(you are now|act as|pretend to be|roleplay as)\b/i,
    weight: 0.24,
  },
  {
    id: "tool_execution_request",
    pattern:
      /\b(run|execute|call|invoke|use)\b[\s\S]{0,40}\b(tool|function|bash|shell|command|curl|wget|ssh)\b/i,
    weight: 0.34,
  },
  {
    id: "approval_bypass",
    pattern:
      /\b(skip|bypass|without|ignore)\b[\s\S]{0,30}\b(approval|confirmation|guardrail|policy)\b/i,
    weight: 0.34,
  },
  {
    id: "secret_exfiltration",
    pattern:
      /\b(secret|api[_ -]?key|token|wallet|seed phrase|ssh)\b[\s\S]{0,40}\b(send|print|reveal|exfiltrate|upload|paste|leak)\b/i,
    weight: 0.42,
  },
  {
    id: "prompt_markup_escape",
    pattern:
      /<\/?(system|assistant|developer|instructions?|tool-call|skill-summary|task-data)\b/i,
    weight: 0.28,
  },
  {
    id: "jailbreak_vocabulary",
    pattern:
      /\b(jailbreak|system prompt|developer message|ignore safety|bypass guardrails)\b/i,
    weight: 0.25,
  },
  {
    id: "imperative_sensitive_action",
    pattern:
      /\b(immediately|automatically|right now)\b[\s\S]{0,40}\b(claim|purchase|stake|delegate|complete|resolve|download|install)\b/i,
    weight: 0.18,
  },
];

function truncateUtf8(input: string, maxBytes: number): string {
  if (maxBytes <= 0 || input.length === 0) return "";
  const encoder = new TextEncoder();
  if (encoder.encode(input).length <= maxBytes) {
    return input;
  }

  let out = "";
  for (const char of input) {
    const candidate = out + char;
    if (encoder.encode(candidate).length > maxBytes) {
      break;
    }
    out = candidate;
  }
  return out;
}

function compactSummary(text: string): string {
  if (!text) return "";
  return text.replace(/\n+/g, " / ");
}

function normalizeLine(line: string): string {
  return line.replace(MULTISPACE_RE, " ").trim();
}

function isConstraintLine(line: string): boolean {
  return /\b(must|without|before|after|deadline|using|only|never|do not|don't)\b/i.test(
    line,
  );
}

function isBulletLine(line: string): boolean {
  return /^([-*•]|\d+\.)\s+/.test(line);
}

function joinSkillMetadata(
  name: string,
  description: string,
  tags: readonly string[],
): string {
  return [name, description, tags.join("\n")].filter(Boolean).join("\n");
}

export function normalizeUntrustedText(input: string): string {
  return input
    .normalize("NFKC")
    .replace(INVISIBLE_CHARS_RE, "")
    .replace(CONTROL_CHARS_RE, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(normalizeLine)
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function escapeForPromptContext(input: string): string {
  return JSON.stringify(normalizeUntrustedText(input)).slice(1, -1);
}

export function assessPromptInjectionRisk(
  input: string,
): PromptInjectionAssessment {
  const normalizedText = normalizeUntrustedText(input);
  const safeSummary = truncateUtf8(compactSummary(normalizedText), 160);
  const matchedSignals = RISK_RULES.filter((rule) =>
    rule.pattern.test(normalizedText),
  ).map((rule) => rule.id);
  const riskScore = Math.min(
    1,
    Number(
      RISK_RULES.filter((rule) => matchedSignals.includes(rule.id))
        .reduce((sum, rule) => sum + rule.weight, 0)
        .toFixed(2),
    ),
  );
  const riskLevel: PromptInjectionRiskLevel =
    riskScore >= 0.65 ? "high" : riskScore >= 0.3 ? "medium" : "low";

  return {
    normalizedText,
    safeSummary,
    riskScore,
    riskLevel,
    matchedSignals,
    executionEligible: riskLevel !== "high",
  };
}

export function assessSkillMetadataRisk(
  skill: SkillMetadataLike,
): PromptInjectionAssessment {
  return assessPromptInjectionRisk(
    joinSkillMetadata(skill.name, skill.description, skill.tags ?? []),
  );
}

export function extractStructuredTaskDescription(
  input: string,
): StructuredTaskDescription {
  const risk = assessPromptInjectionRisk(input);
  const lines = risk.normalizedText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const objective = lines[0] ?? risk.safeSummary;
  const remaining = lines.slice(1);
  const deliverables = remaining
    .filter((line) => isBulletLine(line) && !isConstraintLine(line))
    .map((line) => line.replace(/^([-*•]|\d+\.)\s+/, "").trim())
    .slice(0, 4);
  const constraints = remaining.filter(isConstraintLine).slice(0, 4);

  return {
    objective,
    deliverables,
    constraints,
    risk,
  };
}

export function normalizeTaskDescriptionForStorage(
  input: string,
  maxBytes: number,
): {
  readonly normalizedText: string;
  readonly assessment: PromptInjectionAssessment;
} {
  const assessment = assessPromptInjectionRisk(input);
  return {
    normalizedText: truncateUtf8(assessment.normalizedText, maxBytes),
    assessment,
  };
}
