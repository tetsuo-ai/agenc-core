/**
 * Conservative task-to-topology policy for `/swarm`.
 *
 * The policy intentionally prefers one agent unless the current request
 * contains positive evidence of independent work. It never recommends more
 * than four workers: coordination overhead and shared-state contention grow
 * faster than useful parallelism on tightly coupled coding tasks.
 */

import { createHash } from "node:crypto";

export const SWARM_ROUTING_POLICY_VERSION = "agenc.swarm.route.v2" as const;

export type SwarmRoutingMode = "parallel" | "sequential" | "coordinate";
export type SwarmDelegationEnforcement =
  | "none"
  // Retained for older receipts; current routing emits "none".
  | "require_initial_spawn";
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
  readonly delegationEnforcement: SwarmDelegationEnforcement;
  readonly maxAgents: 0 | 1 | 2 | 4;
  readonly isolation: SwarmIsolationRecommendation;
  readonly integration: SwarmIntegrationRecommendation;
  readonly signals: readonly SwarmRoutingSignal[];
  readonly rationale: string;
}

const EXPLICIT_PARALLEL_RE =
  /\b(?:parallel(?:ize|ise)|fan[ -]?out|use\s+(?:a\s+)?swarm|(?:use|spawn|launch|engage)\s+(?:multiple|several|[2-9]|two|three|four)\s+(?:independent\s+)?(?:agents?|sub[ -]?agents?|workers?|helpers)|(?:delegate|assign)\s+(?:(?:these|the)\s+)?(?:independent|separate)|(?:delegate|assign)\b(?:\s+\w+){0,6}\s+to\s+(?:multiple|several|[2-9]|two|three|four)\s+(?:independent\s+)?(?:agents?|sub[ -]?agents?|workers?|helpers)|concurrently\s+(?:investigate|research|review|audit|analy[sz]e|check|test|implement|build|fix|work|run|execute|handle|perform|complete)|(?:investigate|research|review|audit|analy[sz]e|check|test|implement|build|fix|work|run|execute|handle|perform|complete|do)\b(?:\s+\w+){0,6}\s+(?:concurrently|in\s+parallel))\b/iu;
const EXPLICIT_INDEPENDENCE_RE =
  /\b(?:decomposable|disjoint|independent(?:ly)?|separate(?:ly)?|unrelated)\b/iu;
const NEGATED_INDEPENDENCE_RE =
  /(?:\b(?:no|not|never)\s+(?:(?:actually|entirely|fully|mutually|necessarily|truly)\s+)?(?:decomposable|disjoint|independent(?:ly)?|separate(?:ly)?|unrelated)\b|\b(?:aren['’]?t|isn['’]?t|wasn['’]?t|weren['’]?t)\s+(?:(?:actually|entirely|fully|mutually|necessarily|truly)\s+)?(?:decomposable|disjoint|independent(?:ly)?|separate(?:ly)?|unrelated)\b|\bnon[ -]?(?:decomposable|independent)\b)/iu;
const EXPLICIT_NO_DELEGATION_RE =
  /(?:\b(?:do\s+not|don['’]?t|never)\s+(?:delegate(?:\s+(?:anything|this|it|(?:this|the)\s+(?:task|request|work)|any\s+of\s+(?:this|the)\s+(?:task|request|work)))?|parallel(?:ize|ise)(?:\s+(?:this|it|(?:this|the)\s+(?:task|request|work)))?|fan[ -]?out(?:\s+(?:this|it|(?:this|the)\s+(?:task|request|work)))?|spawn\s+(?:(?:any|additional|multiple|new)\s+)?(?:agents?|sub[ -]?agents?|workers?|helpers?)(?:\s+(?:for|on)\s+(?:this|it|(?:this|the)\s+(?:task|request|work)))?|use\s+(?:(?:any|multiple)\s+)?(?:agents?|sub[ -]?agents?|workers?|helpers?|a\s+swarm)(?:\s+(?:for|on)\s+(?:this|it|(?:this|the)\s+(?:task|request|work)))?)(?=\s*(?:$|[.!?,;:]|\b(?:and|but)\b))|(?:^|[.!?;:]\s*)no\s+(?:delegation|agents?|sub[ -]?agents?|workers?|helpers?|swarm|fan[ -]?out)\s*(?=$|[.!?;:])|\bno\s+(?:delegation|agents?|sub[ -]?agents?|workers?|helpers?|swarm|fan[ -]?out)\s+(?:for|on)\s+(?:this|the)\s+(?:task|request|work)\b|\b(?:spawn|use)\s+no\s+(?:agents?|sub[ -]?agents?|workers?|helpers?|swarm)\b|\bkeep\s+(?:this|it|(?:this|the)\s+(?:task|request|work))\s+local\b|\b(?:handle|do|complete)\s+(?:this|it|(?:this|the)\s+(?:task|request|work))\s+(?:alone|yourself|without\s+(?:delegation|agents?|sub[ -]?agents?|workers?|helpers?|a\s+swarm))\b|\b(?:proceed|work)\s+(?:alone|without\s+(?:delegation|agents?|sub[ -]?agents?|workers?|helpers?|a\s+swarm))\b|^(?:please\s+)?without\s+(?:delegation|agents?|sub[ -]?agents?|workers?|helpers?|a\s+swarm)\b)/iu;
const MULTI_DOMAIN_RE =
  /\b(?:end[ -]to[ -]end|across|compare|comparison|audit|research|review)\b/iu;
const WRITE_TASK_RE =
  /\b(?:build|changes?|code|edit|fix|implement|migrate|patch|refactor|rewrite|update)\b/iu;
const SHARED_STATE_COUPLING_RE =
  /\b(?:single\s+(?:bug|failure|file|function|issue)|tightly\s+coupled|same\s+file|sequential|in\s+order|one\s+at\s+a\s+time)\b/iu;
const HIGH_RISK_CHANGE_RE =
  /\b(?:auth(?:entication|orization)?|database|deploy|mainnet|migration|payment|production|release|schema|security|sign(?:ing|ature)?|wallet)\b/iu;

// Explicit requests for helpers outside /swarm (requestsHelpers below). The nouns name the helpers: "sub-agents",
// "helper agents" and "child agents" with or without a count; "helpers" and "agents" with a plural count or right
// after "spawn" ("spawn helpers", "have two helpers read ..."); "an agent" with any of the verbs; "a helper" only with
// a verb that starts one ("spawn a helper"), since "use a helper" or "delegate to a helper" mostly means a helper
// function. "Workers" are left out here: outside /swarm they are mostly code (thread, gunicorn or Cloudflare workers).
const HELPER_SPECIFIC_NOUN = String.raw`(?:sub[ -]?agents?|helper[ -]agents?|child[ -]agents?|agent[ -]helpers?)`;
const HELPER_COUNT = String.raw`(?:a|an|one|two|three|four|five|six|several|multiple|some|[2-9]|1[0-9])`;
const HELPER_PLURAL_COUNT = String.raw`(?:two|three|four|five|six|several|multiple|some|[2-9]|1[0-9])`;
const HELPER_QUALIFIER = String.raw`(?:(?:independent|separate|parallel|dedicated|background)\s+)?`;
// A code noun or a file extension right after the helper noun makes it a programming term: "a helper function",
// "an agent SDK", "the agents module", "helpers.ts".
const HELPER_NOT_CODE = String.raw`(?!\.\w|[ -]?(?:functions?|methods?|class(?:es)?|modules?|files?|folders?|director(?:y|ies)|scripts?|threads?|process(?:es)?|types?|interfaces?|utils?|utilit(?:y|ies)|librar(?:y|ies)|hooks?|components?|packages?|apps?|routes?|tests?|specs?|nodes?|pools?|queues?|services?|servers?|daemons?|frameworks?|sdks?|apis?|endpoints?|config(?:s|urations?)?|settings?|code|logic|bots?|objects?|binar(?:y|ies)|images?|containers?|fields?|columns?|propert(?:y|ies)|variables?|attributes?|parameters?|arguments?|arrays?|lists?|maps?|tables?|records?|schemas?|models?|strings?|names?|ids?)\b)`;
const HELPER_START_VERB = String.raw`(?:spawn|spawns|spawning|launch|launches|launching|start|starting|dispatch|send|ask|get|engage|employ|spin\s+up|fire\s+up|kick\s+off|bring\s+in)`;
const HELPER_USE_VERB = String.raw`(?:use|uses|using|with|via|through|run|running|${HELPER_START_VERB})`;
// "do not use two helpers", "without using sub-agents", "no need to spawn agents".
const HELPER_NOT_NEGATED = String.raw`(?<!(?:\b(?:not|never|without|no\s+need\s+to)|n['’]t)\s+)`;
const HELPER_REQUEST_RES: readonly RegExp[] = [
  // "use sub-agents", "spawn a helper agent", "with two independent sub-agents"
  new RegExp(String.raw`${HELPER_NOT_NEGATED}\b${HELPER_USE_VERB}\s+(?:(?:the|these|those|your)\s+)?(?:${HELPER_COUNT}\s+)?${HELPER_QUALIFIER}${HELPER_SPECIFIC_NOUN}\b${HELPER_NOT_CODE}`, "giu"),
  // "have a sub-agent look at the logs", "let two helper agents check the docs"
  new RegExp(String.raw`${HELPER_NOT_NEGATED}\b(?:have|let|need|want)\s+(?:(?:the|your)\s+)?(?:${HELPER_COUNT}\s+)?${HELPER_QUALIFIER}${HELPER_SPECIFIC_NOUN}\b${HELPER_NOT_CODE}`, "giu"),
  // "using two helpers", "spawn three agents", "use an agent", "spawn a helper"
  new RegExp(String.raw`${HELPER_NOT_NEGATED}\b(?:${HELPER_USE_VERB}\s+(?:${HELPER_PLURAL_COUNT}\s+${HELPER_QUALIFIER}(?:helpers|agents)|(?:a|an|one)\s+${HELPER_QUALIFIER}agent)|${HELPER_START_VERB}\s+(?:a|an|one)\s+${HELPER_QUALIFIER}helper)\b${HELPER_NOT_CODE}`, "giu"),
  // "Have two helpers read alpha.txt and beta.txt", "Let two agents check the docs" (not "we have two helpers in utils")
  new RegExp(String.raw`(?:^|\b(?:please|then|and|can\s+you|could\s+you|would\s+you)\s+)(?:have|let)\s+(?:(?:the|your)\s+)?${HELPER_PLURAL_COUNT}\s+${HELPER_QUALIFIER}(?:helpers|agents)\b${HELPER_NOT_CODE}`, "giu"),
  // "Spawn helpers for the lint and the tests", "spawn agents to check each file"
  new RegExp(String.raw`${HELPER_NOT_NEGATED}\b(?:spawn|spin\s+up|fire\s+up|kick\s+off)\s+${HELPER_QUALIFIER}(?:helpers|agents)\b${HELPER_NOT_CODE}`, "giu"),
  // "delegate the review to two agents", "split the work between sub-agents"
  new RegExp(String.raw`${HELPER_NOT_NEGATED}\b(?:delegate|delegating|hand\s+off|handing\s+off|assign|assigning|offload|offloading|farm\s+out|split|splitting)\b(?:\s+[\w'’-]+){0,8}?\s+(?:to|between|among|across)\s+(?:(?:the|your)\s+)?(?:(?:${HELPER_COUNT}\s+)?${HELPER_QUALIFIER}${HELPER_SPECIFIC_NOUN}|${HELPER_PLURAL_COUNT}\s+${HELPER_QUALIFIER}(?:helpers|agents)|(?:a|an|one)\s+${HELPER_QUALIFIER}agent)\b${HELPER_NOT_CODE}`, "giu"),
  // "in parallel with helpers", "concurrently using sub-agents"
  new RegExp(String.raw`\b(?:in\s+parallel|concurrently|simultaneously|at\s+the\s+same\s+time)\s+(?:using|with|via|through|by)\s+(?:(?:${HELPER_COUNT}\s+)?${HELPER_QUALIFIER}${HELPER_SPECIFIC_NOUN}|(?:${HELPER_PLURAL_COUNT}\s+)?${HELPER_QUALIFIER}(?:helpers|agents))\b${HELPER_NOT_CODE}`, "giu"),
];
// Every pattern and every enumerated label needs one of these words, so a text or a sentence without them is
// skipped at once; and a pattern is first tried with test(), which does not copy it as matchAll does.
const HELPER_WORD_RE = /helper|agent/iu;
const HELPER_REQUEST_TESTS: readonly RegExp[] = HELPER_REQUEST_RES.map((pattern) => new RegExp(pattern.source, "iu"));
// "Helper one: ...", "Agent 2: ..." on their own lines; two different labels make a request.
const ENUMERATED_HELPER_RE =
  /^[ \t]*(?:[-*+][ \t]+)?(?:helper|sub[ -]?agent|agent)[ \t]+(one|two|three|four|five|six|[1-9])[ \t]*[:.)-]/gimu;
// Code, quoted lines and double-quoted text are examples, not requests.
const QUOTED_OR_CODE_RE = /```[\s\S]*?(?:```|(?![\s\S]))|~~~[\s\S]*?(?:~~~|(?![\s\S]))|`[^`\n]*`|^[ \t]*>.*$|"[^"\n]*"|“[^”\n]*”/gmu;

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
      delegationEnforcement: "none",
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
      signals.has("independent_list")) ||
    (signals.has("multi_domain_analysis") &&
      signals.has("independent_list"));
  const explicitlyLocal = signals.has("explicit_no_delegation");
  const coupled = signals.has("shared_state_coupling");

  if (explicitlyLocal || !positiveEvidence || coupled) {
    return {
      policyVersion: SWARM_ROUTING_POLICY_VERSION,
      inputFingerprint,
      mode: "sequential",
      delegationEnforcement: "none",
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
    delegationEnforcement: "none",
    maxAgents,
    isolation: writes ? "worktree" : "none",
    integration: writes ? "verify_then_integrate" : "synthesize_results",
    signals: orderedSignals(signals),
    rationale: writes
      ? "Independent writable subtasks are present; isolate disjoint changes and verify each integration boundary."
      : "Independent analysis subtasks are present and can be synthesized without shared filesystem writes.",
  };
}

// A negation cue before the match, in its own part of the sentence: "Please avoid using sub-agents", "Instead of
// spawning sub-agents, read both files yourself". Parts end at commas, colons, spaced dashes and "but", "so" or
// "then", so "Instead of reading them yourself, spawn two helpers" still asks. Before a base-form verb "and" ends a
// part too ("Don't touch the tests and use two sub-agents"); before a gerund the negation still governs it ("Avoid
// editing files and using sub-agents").
const HELPER_NEGATION_RE = /\b(?:not|never|no|without|avoid|avoiding|instead\s+of|rather\s+than|stop|skip)\b|n['’]t\b/iu;
const HELPER_PART_BOUNDARY_RE = /[,:]|\s[-\u2013\u2014]\s|\b(?:but|so|then)\b/iu;
const HELPER_PART_BOUNDARY_AND_RE = /[,:]|\s[-\u2013\u2014]\s|\b(?:but|so|then|and)\b/iu;
const HELPER_GERUND_RE = /^(?!bring\b)\w+ing\b/iu;
// A cue left before an aside still governs the verb after it: "You should not, in this case, spawn helpers", "Avoid,
// if possible, spawning sub-agents".
const HELPER_DANGLING_NEGATION_RE = /(?:\b(?:not|never|avoid|without|instead\s+of|rather\s+than)|n['’]t)\s*$/iu;
// "Using sub-agents would be overkill here, just read the file."
const HELPER_NEEDLESS_RE = /\b(?:overkill|unnecessary|not\s+(?:needed|necessary))\b/iu;
// Questions about the feature ask for an answer, not for helpers: "How do I use sub-agents in AgenC?". Requests
// phrased as questions ("Can you", "Could you", "Could we", "Would you", "Would it be possible") still count.
const HELPER_QUESTION_RE =
  /^(?:(?:so|and|but|ok|okay|also)[, ]+)?(?:how|what|why|when|where|which|who|whether|does|do|did|is|are|should\s+(?:i|we)|can\s+(?:i|we)|could\s+i)\b/iu;
// How far before a match a negation cue may sit. Every match of every pattern is checked, so an unbounded look-back
// made a long sentence of rejected matches quadratic: 1 MB of "avoid using sub-agents, " took 30 s, synchronously in
// the daemon. 200 characters is longer than any sentence part needs.
const HELPER_NEGATION_LOOKBACK = 200;

function helperRequestInClause(clause: string): boolean {
  if (!HELPER_WORD_RE.test(clause)) return false;
  if (/\?\s*$/u.test(clause) && HELPER_QUESTION_RE.test(clause)) return false;
  if (HELPER_NEEDLESS_RE.test(clause)) return false;
  for (const [index, pattern] of HELPER_REQUEST_RES.entries()) {
    if (!HELPER_REQUEST_TESTS[index]?.test(clause)) continue;
    for (const match of clause.matchAll(pattern)) {
      const at = match.index ?? 0;
      const boundary = HELPER_GERUND_RE.test(match[0].trim()) ? HELPER_PART_BOUNDARY_RE : HELPER_PART_BOUNDARY_AND_RE;
      const parts = clause.slice(Math.max(0, at - HELPER_NEGATION_LOOKBACK), at).split(boundary);
      if (HELPER_NEGATION_RE.test(parts.at(-1) ?? "")) continue;
      if (parts.slice(0, -1).some((part) => HELPER_DANGLING_NEGATION_RE.test(part))) continue;
      return true;
    }
  }
  return false;
}

/**
 * Whether a root-human request explicitly asks for helpers, outside /swarm (prompts/attachments/delegation-request.ts):
 * it names helpers, helper agents or sub-agents to use, spawn or delegate to ("using two helpers", "spawn a
 * sub-agent", "delegate the review to two agents", "Helper one: ..." and "Helper two: ..." lines). Code spans, fenced
 * blocks, quoted lines and double-quoted text are ignored, a programming noun after the helper noun rules the phrase
 * out, and an explicit no-delegation constraint wins. Each sentence is read on its own: a negation cue before the
 * match ("please avoid using sub-agents", "instead of spawning sub-agents") or a question about the feature ("how do I
 * use sub-agents?") is not a request. A conditional request still counts: the reminder it brings states the
 * prerequisites.
 */
export function requestsHelpers(userInput: string | null): boolean {
  if (!HELPER_WORD_RE.test(userInput ?? "")) return false;
  const unquoted = (userInput ?? "").replace(QUOTED_OR_CODE_RE, " ");
  const input = normalizedInput(unquoted);
  if (input.length === 0 || EXPLICIT_NO_DELEGATION_RE.test(input)) return false;
  if (input.split(/(?<=[.!?;])\s+/u).some(helperRequestInClause)) return true;
  const labels = new Set([...unquoted.matchAll(ENUMERATED_HELPER_RE)].map((match) => match[1]?.toLowerCase()));
  return labels.size >= 2;
}

export function swarmRoutingReceipt(
  decision: SwarmRoutingDecision,
): Readonly<Record<string, unknown>> {
  return {
    policy_version: decision.policyVersion,
    input_fingerprint: decision.inputFingerprint,
    mode: decision.mode,
    delegation_enforcement: decision.delegationEnforcement,
    recommended_max_agents: decision.maxAgents,
    recommended_isolation: decision.isolation,
    recommended_integration: decision.integration,
    signals: decision.signals,
  };
}
