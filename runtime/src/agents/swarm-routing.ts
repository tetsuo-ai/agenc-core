/**
 * Conservative task-to-topology policy for `/swarm`.
 *
 * The policy intentionally prefers one agent unless the current request
 * contains positive evidence of independent work. It never recommends more
 * than four workers: coordination overhead and shared-state contention grow
 * faster than useful parallelism on tightly coupled coding tasks.
 */

import { createHash } from "node:crypto";

export const SWARM_ROUTING_POLICY_VERSION = "agenc.swarm.route.v1" as const;

export type SwarmRoutingMode = "parallel" | "sequential" | "coordinate";
export type SwarmIsolationRecommendation = "none" | "worktree";
export type SwarmIntegrationRecommendation =
  "synthesize_results" | "verify_then_integrate" | "continue_coordination";

export type SwarmRoutingSignal =
  | "explicit_no_delegation"
  | "explicit_parallelism"
  | "explicit_independence"
  | "independent_list"
  | "multi_domain_analysis"
  | "write_task"
  | "shared_state_coupling"
  | "high_risk_change"
  | "no_substantive_input";

export interface SwarmRoutingDecision {
  readonly policyVersion: typeof SWARM_ROUTING_POLICY_VERSION;
  /** Fingerprint only; the receipt never duplicates raw user text. */
  readonly inputFingerprint: string;
  readonly mode: SwarmRoutingMode;
  readonly maxAgents: 0 | 1 | 2 | 4;
  readonly isolation: SwarmIsolationRecommendation;
  readonly integration: SwarmIntegrationRecommendation;
  readonly signals: readonly SwarmRoutingSignal[];
  readonly rationale: string;
}

const EXPLICIT_PARALLEL_RE =
  /\b(?:parallel(?:ize|ise)|fan[ -]?out|use\s+(?:a\s+)?swarm|(?:use|spawn|launch|engage)\s+(?:multiple|several|[2-9]|two|three|four)\s+(?:independent\s+)?(?:agents?|sub[ -]?agents?|workers?)|(?:delegate|assign)\s+(?:(?:these|the)\s+)?(?:independent|separate)|(?:delegate|assign)\b(?:\s+\w+){0,6}\s+to\s+(?:multiple|several|[2-9]|two|three|four)\s+(?:independent\s+)?(?:agents?|sub[ -]?agents?|workers?)|concurrently\s+(?:investigate|research|review|audit|analy[sz]e|check|test|implement|build|fix|work|run|execute|handle|perform|complete)|(?:investigate|research|review|audit|analy[sz]e|check|test|implement|build|fix|work|run|execute|handle|perform|complete|do)\b(?:\s+\w+){0,6}\s+(?:concurrently|in\s+parallel))\b/iu;
const EXPLICIT_INDEPENDENCE_RE =
  /\b(?:decomposable|disjoint|independent(?:ly)?|separate(?:ly)?|unrelated)\b/iu;
const NEGATED_INDEPENDENCE_RE =
  /(?:\b(?:no|not|never)\s+(?:(?:actually|entirely|fully|mutually|necessarily|truly)\s+)?(?:decomposable|disjoint|independent(?:ly)?|separate(?:ly)?|unrelated)\b|\b(?:aren['’]?t|isn['’]?t|wasn['’]?t|weren['’]?t)\s+(?:(?:actually|entirely|fully|mutually|necessarily|truly)\s+)?(?:decomposable|disjoint|independent(?:ly)?|separate(?:ly)?|unrelated)\b|\bnon[ -]?(?:decomposable|independent)\b)/iu;
const EXPLICIT_NO_DELEGATION_RE =
  /(?:\b(?:do\s+not|don['’]?t|never)\s+(?:delegate(?:\s+(?:anything|this|it|(?:this|the)\s+(?:task|request|work)|any\s+of\s+(?:this|the)\s+(?:task|request|work)))?|parallel(?:ize|ise)(?:\s+(?:this|it|(?:this|the)\s+(?:task|request|work)))?|fan[ -]?out(?:\s+(?:this|it|(?:this|the)\s+(?:task|request|work)))?|spawn\s+(?:(?:any|additional|multiple|new)\s+)?(?:agents?|sub[ -]?agents?|workers?)(?:\s+(?:for|on)\s+(?:this|it|(?:this|the)\s+(?:task|request|work)))?|use\s+(?:(?:any|multiple)\s+)?(?:agents?|sub[ -]?agents?|workers?|a\s+swarm)(?:\s+(?:for|on)\s+(?:this|it|(?:this|the)\s+(?:task|request|work)))?)(?=\s*(?:$|[.!?,;:]|\b(?:and|but)\b))|(?:^|[.!?;:]\s*)no\s+(?:delegation|agents?|sub[ -]?agents?|workers?|swarm|fan[ -]?out)\s*(?=$|[.!?;:])|\bno\s+(?:delegation|agents?|sub[ -]?agents?|workers?|swarm|fan[ -]?out)\s+(?:for|on)\s+(?:this|the)\s+(?:task|request|work)\b|\b(?:spawn|use)\s+no\s+(?:agents?|sub[ -]?agents?|workers?|swarm)\b|\bkeep\s+(?:this|it|(?:this|the)\s+(?:task|request|work))\s+local\b|\b(?:handle|do|complete)\s+(?:this|it|(?:this|the)\s+(?:task|request|work))\s+(?:alone|yourself|without\s+(?:delegation|agents?|sub[ -]?agents?|workers?|a\s+swarm))\b|\b(?:proceed|work)\s+(?:alone|without\s+(?:delegation|agents?|sub[ -]?agents?|workers?|a\s+swarm))\b|^(?:please\s+)?without\s+(?:delegation|agents?|sub[ -]?agents?|workers?|a\s+swarm)\b)/iu;
const MULTI_DOMAIN_RE =
  /\b(?:end[ -]to[ -]end|across|compare|comparison|audit|research|review)\b/iu;
const WRITE_TASK_RE =
  /\b(?:build|changes?|code|edit|fix|implement|migrate|patch|refactor|rewrite|update)\b/iu;
const SHARED_STATE_COUPLING_RE =
  /\b(?:single\s+(?:bug|failure|file|function|issue)|tightly\s+coupled|same\s+file|sequential|in\s+order|one\s+at\s+a\s+time)\b/iu;
const HIGH_RISK_CHANGE_RE =
  /\b(?:auth(?:entication|orization)?|database|deploy|mainnet|migration|payment|production|release|schema|security|sign(?:ing|ature)?|wallet)\b/iu;

function normalizedInput(input: string | null): string {
  return (input ?? "").replace(/\s+/gu, " ").trim();
}

function fingerprint(input: string): string {
  // Keep raw task content out of the structured receipt while retaining a
  // collision-resistant correlation key for evaluation and diagnostics.
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

function independentListItemCount(input: string): number {
  const lines = input.split(/\r?\n/gu);
  const marked = lines.filter((line) =>
    /^\s*(?:[-*+]\s+|\d+[.)]\s+)/u.test(line),
  ).length;
  if (marked >= 2) return marked;

  // A compact semicolon-separated request often carries independent clauses,
  // but require three to avoid treating ordinary prose as a task list.
  return input.split(";").filter((part) => part.trim().length >= 8).length >= 3
    ? input.split(";").length
    : 0;
}

function orderedSignals(
  signals: ReadonlySet<SwarmRoutingSignal>,
): SwarmRoutingSignal[] {
  const order: readonly SwarmRoutingSignal[] = [
    "no_substantive_input",
    "explicit_no_delegation",
    "explicit_parallelism",
    "explicit_independence",
    "independent_list",
    "multi_domain_analysis",
    "write_task",
    "shared_state_coupling",
    "high_risk_change",
  ];
  return order.filter((signal) => signals.has(signal));
}

export function routeSwarmTask(userInput: string | null): SwarmRoutingDecision {
  const rawInput = userInput ?? "";
  const input = normalizedInput(rawInput);
  // List structure is policy-relevant, so fingerprint the exact trusted input
  // rather than a whitespace-collapsed representation that can route
  // differently while producing the same audit key.
  const inputFingerprint = fingerprint(rawInput);
  if (input.length === 0) {
    return {
      policyVersion: SWARM_ROUTING_POLICY_VERSION,
      inputFingerprint,
      mode: "coordinate",
      maxAgents: 0,
      isolation: "none",
      integration: "continue_coordination",
      signals: ["no_substantive_input"],
      rationale:
        "No new user task is present; consume existing receipts and continue coordination without replacement fan-out.",
    };
  }

  const signals = new Set<SwarmRoutingSignal>();
  const listItems = independentListItemCount(userInput ?? "");
  const negatedIndependence = NEGATED_INDEPENDENCE_RE.test(input);
  if (EXPLICIT_NO_DELEGATION_RE.test(input))
    signals.add("explicit_no_delegation");
  if (EXPLICIT_PARALLEL_RE.test(input)) signals.add("explicit_parallelism");
  if (EXPLICIT_INDEPENDENCE_RE.test(input) && !negatedIndependence)
    signals.add("explicit_independence");
  if (listItems >= 2) signals.add("independent_list");
  if (MULTI_DOMAIN_RE.test(input)) signals.add("multi_domain_analysis");
  if (WRITE_TASK_RE.test(input)) signals.add("write_task");
  if (SHARED_STATE_COUPLING_RE.test(input))
    signals.add("shared_state_coupling");
  if (HIGH_RISK_CHANGE_RE.test(input)) signals.add("high_risk_change");

  const positiveEvidence =
    signals.has("explicit_parallelism") ||
    (signals.has("explicit_independence") &&
      signals.has("independent_list"));
  const explicitlyLocal = signals.has("explicit_no_delegation");
  const coupled = signals.has("shared_state_coupling");

  if (explicitlyLocal || !positiveEvidence || coupled) {
    return {
      policyVersion: SWARM_ROUTING_POLICY_VERSION,
      inputFingerprint,
      mode: "sequential",
      maxAgents: 1,
      isolation: "none",
      integration: "synthesize_results",
      signals: orderedSignals(signals),
      rationale: explicitlyLocal
        ? "The user explicitly prohibited delegation; keep all work in the current agent."
        : coupled
          ? "The request signals shared-state or ordering dependencies; keep the critical path local and delegate only non-blocking sidecars."
          : "The request does not provide enough evidence of independent subtasks to justify coordination overhead.",
    };
  }

  const maxAgents: 2 | 4 =
    listItems >= 4 && !signals.has("high_risk_change") ? 4 : 2;
  const writes = signals.has("write_task");
  return {
    policyVersion: SWARM_ROUTING_POLICY_VERSION,
    inputFingerprint,
    mode: "parallel",
    maxAgents,
    isolation: writes ? "worktree" : "none",
    integration: writes ? "verify_then_integrate" : "synthesize_results",
    signals: orderedSignals(signals),
    rationale: writes
      ? "Independent writable subtasks are present; isolate disjoint changes and verify each integration boundary."
      : "Independent analysis subtasks are present and can be synthesized without shared filesystem writes.",
  };
}

export function swarmRoutingReceipt(
  decision: SwarmRoutingDecision,
): Readonly<Record<string, unknown>> {
  return {
    policy_version: decision.policyVersion,
    input_fingerprint: decision.inputFingerprint,
    mode: decision.mode,
    recommended_max_agents: decision.maxAgents,
    recommended_isolation: decision.isolation,
    recommended_integration: decision.integration,
    signals: decision.signals,
  };
}
