import { PolicyParser } from "./parser.js";
import { Policy, type Evaluation, type HeuristicsFallback } from "./policy.js";

export { AmendError, blockingAppendAllowPrefixRule, blockingAppendNetworkRule } from "./amend.js";
export { type Decision, maxDecision, parseDecision } from "./decision.js";
export {
  ExecPolicyError,
  ExampleDidMatchError,
  ExampleDidNotMatchError,
  invalidDecision,
  invalidExample,
  invalidPattern,
  invalidRule,
  parseError,
  type ErrorLocation,
  type ExecPolicyErrorKind,
  type TextPosition,
  type TextRange,
} from "./error.js";
export {
  formatMatchesJson,
  loadPolicies,
  runExecPolicyCheckCommand,
  type ExecPolicyCheckCommand,
  type ExecPolicyCheckOutput,
} from "./execpolicycheck.js";
export { parseExecPolicyArgv, runExecPolicyCli } from "./main.js";
export { PolicyParser } from "./parser.js";
export {
  EvaluationFromMatches,
  Policy,
  type Evaluation,
  type HeuristicsFallback,
  type MatchOptions,
} from "./policy.js";
export {
  normalizeNetworkRuleHost,
  parseNetworkRuleProtocol,
  serializeRuleMatch,
  singleToken,
  alternativeToken,
  type NetworkRule,
  type NetworkRuleProtocol,
  type PatternToken,
  type PrefixPattern,
  type PrefixRule,
  type Rule,
  type RuleMatch,
  type SerializedRuleMatch,
} from "./rule.js";

export function createPolicyParser(): PolicyParser {
  return new PolicyParser();
}

export function parsePolicy(policyIdentifier: string, policyFileContents: string): Policy {
  const parser = new PolicyParser();
  parser.parse(policyIdentifier, policyFileContents);
  return parser.build();
}

export function evaluatePolicyCommand(
  policy: Policy,
  command: readonly string[],
  fallback: HeuristicsFallback,
): Evaluation {
  return policy.check(command, fallback);
}
