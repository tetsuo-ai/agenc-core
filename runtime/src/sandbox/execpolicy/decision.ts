import { invalidDecision } from "./error.js";

export type Decision = "allow" | "prompt" | "forbidden";

const DECISION_ORDER: Record<Decision, number> = {
  allow: 0,
  prompt: 1,
  forbidden: 2,
};

export function parseDecision(raw: string): Decision {
  switch (raw) {
    case "allow":
    case "prompt":
    case "forbidden":
      return raw;
    default:
      throw invalidDecision(raw);
  }
}

export function maxDecision(decisions: readonly Decision[]): Decision | null {
  let current: Decision | null = null;
  for (const decision of decisions) {
    if (current === null || DECISION_ORDER[decision] > DECISION_ORDER[current]) {
      current = decision;
    }
  }
  return current;
}
