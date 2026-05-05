import path from "node:path";

import { type Decision, maxDecision } from "./decision.js";
import { executablePathLookupKey } from "./executable-name.js";
import { invalidPattern, invalidRule } from "./error.js";
import {
  normalizeNetworkRuleHost,
  prefixRuleMatches,
  singleToken,
  tokenAlternatives,
  withResolvedProgram,
  type NetworkRule,
  type NetworkRuleProtocol,
  type PatternToken,
  type PrefixRule,
  type Rule,
  type RuleMatch,
} from "./rule.js";

export interface MatchOptions {
  readonly resolveHostExecutables: boolean;
}

export interface Evaluation {
  readonly decision: Decision;
  readonly matchedRules: readonly RuleMatch[];
}

export type HeuristicsFallback = (command: readonly string[]) => Decision;

export class Policy {
  private readonly rulesByProgram: Map<string, Rule[]>;
  private readonly networkRuleList: NetworkRule[];
  private readonly hostExecutablesByName: Map<string, readonly string[]>;

  constructor(rulesByProgram: Map<string, Rule[]> = new Map()) {
    this.rulesByProgram = cloneRulesByProgram(rulesByProgram);
    this.networkRuleList = [];
    this.hostExecutablesByName = new Map();
  }

  static fromParts(
    rulesByProgram: Map<string, Rule[]>,
    networkRules: readonly NetworkRule[],
    hostExecutablesByName: Map<string, readonly string[]>,
  ): Policy {
    const policy = new Policy(rulesByProgram);
    policy.networkRuleList.push(...networkRules.map(cloneNetworkRule));
    for (const [name, paths] of hostExecutablesByName) {
      policy.hostExecutablesByName.set(name, [...paths]);
    }
    return policy;
  }

  static empty(): Policy {
    return new Policy();
  }

  rules(): ReadonlyMap<string, readonly Rule[]> {
    return this.rulesByProgram;
  }

  networkRules(): readonly NetworkRule[] {
    return this.networkRuleList;
  }

  hostExecutables(): ReadonlyMap<string, readonly string[]> {
    return this.hostExecutablesByName;
  }

  getAllowedPrefixes(): string[][] {
    const prefixes: string[][] = [];
    for (const rules of this.rulesByProgram.values()) {
      for (const rule of rules) {
        if (rule.type !== "prefix_rule" || rule.decision !== "allow") continue;
        prefixes.push([
          rule.pattern.first,
          ...rule.pattern.rest.map(renderPatternToken),
        ]);
      }
    }
    prefixes.sort(compareStringArrays);
    return dedupeStringArrays(prefixes);
  }

  addPrefixRule(prefix: readonly string[], decision: Decision): void {
    const first = prefix[0];
    if (first === undefined) {
      throw invalidPattern("prefix cannot be empty");
    }
    const rule: PrefixRule = {
      type: "prefix_rule",
      pattern: {
        first,
        rest: prefix.slice(1).map(singleToken),
      },
      decision,
      justification: null,
    };
    this.addRule(rule);
  }

  addNetworkRule(
    host: string,
    protocol: NetworkRuleProtocol,
    decision: Decision,
    justification: string | null = null,
  ): void {
    const normalizedHost = normalizeNetworkRuleHost(host);
    if (justification !== null && justification.trim().length === 0) {
      throw invalidRule("justification cannot be empty");
    }
    this.networkRuleList.push({
      host: normalizedHost,
      protocol,
      decision,
      justification,
    });
  }

  setHostExecutablePaths(name: string, paths: readonly string[]): void {
    this.hostExecutablesByName.set(name, [...paths]);
  }

  mergeOverlay(overlay: Policy): Policy {
    const combinedRules = cloneRulesByProgram(this.rulesByProgram);
    for (const [program, rules] of overlay.rules()) {
      const target = combinedRules.get(program) ?? [];
      target.push(...rules.map(cloneRule));
      combinedRules.set(program, target);
    }

    const combinedNetworkRules = [
      ...this.networkRuleList.map(cloneNetworkRule),
      ...overlay.networkRules().map(cloneNetworkRule),
    ];
    const combinedHostExecutables = new Map<string, readonly string[]>();
    for (const [name, paths] of this.hostExecutablesByName) {
      combinedHostExecutables.set(name, [...paths]);
    }
    for (const [name, paths] of overlay.hostExecutables()) {
      combinedHostExecutables.set(name, [...paths]);
    }
    return Policy.fromParts(combinedRules, combinedNetworkRules, combinedHostExecutables);
  }

  compiledNetworkDomains(): readonly [readonly string[], readonly string[]] {
    const allowed: string[] = [];
    const denied: string[] = [];

    for (const rule of this.networkRuleList) {
      switch (rule.decision) {
        case "allow":
          removeDomain(denied, rule.host);
          upsertDomain(allowed, rule.host);
          break;
        case "forbidden":
          removeDomain(allowed, rule.host);
          upsertDomain(denied, rule.host);
          break;
        case "prompt":
          break;
        default: {
          const exhaustive: never = rule.decision;
          return exhaustive;
        }
      }
    }

    return [allowed, denied];
  }

  check(command: readonly string[], heuristicsFallback: HeuristicsFallback): Evaluation {
    return EvaluationFromMatches(
      this.matchesForCommandWithOptions(command, heuristicsFallback, {
        resolveHostExecutables: false,
      }),
    );
  }

  checkWithOptions(
    command: readonly string[],
    heuristicsFallback: HeuristicsFallback,
    options: MatchOptions,
  ): Evaluation {
    return EvaluationFromMatches(
      this.matchesForCommandWithOptions(command, heuristicsFallback, options),
    );
  }

  checkMultiple(
    commands: Iterable<readonly string[]>,
    heuristicsFallback: HeuristicsFallback,
  ): Evaluation {
    return this.checkMultipleWithOptions(commands, heuristicsFallback, {
      resolveHostExecutables: false,
    });
  }

  checkMultipleWithOptions(
    commands: Iterable<readonly string[]>,
    heuristicsFallback: HeuristicsFallback,
    options: MatchOptions,
  ): Evaluation {
    const matches: RuleMatch[] = [];
    for (const command of commands) {
      matches.push(
        ...this.matchesForCommandWithOptions(command, heuristicsFallback, options),
      );
    }
    return EvaluationFromMatches(matches);
  }

  matchesForCommand(
    command: readonly string[],
    heuristicsFallback: HeuristicsFallback | null,
  ): readonly RuleMatch[] {
    return this.matchesForCommandWithOptions(command, heuristicsFallback, {
      resolveHostExecutables: false,
    });
  }

  matchesForCommandWithOptions(
    command: readonly string[],
    heuristicsFallback: HeuristicsFallback | null,
    options: MatchOptions,
  ): readonly RuleMatch[] {
    const exactMatches = this.matchExactRules(command);
    let matchedRules =
      exactMatches.length > 0
        ? exactMatches
        : options.resolveHostExecutables
          ? this.matchHostExecutableRules(command)
          : [];

    if (matchedRules.length === 0 && heuristicsFallback !== null) {
      matchedRules = [
        {
          type: "heuristics_rule_match",
          command: [...command],
          decision: heuristicsFallback(command),
        },
      ];
    }
    return matchedRules;
  }

  addRule(rule: Rule): void {
    const program = rule.pattern.first;
    const rules = this.rulesByProgram.get(program) ?? [];
    rules.push(cloneRule(rule));
    this.rulesByProgram.set(program, rules);
  }

  addNetworkRuleObject(rule: NetworkRule): void {
    this.networkRuleList.push(cloneNetworkRule(rule));
  }

  addHostExecutable(name: string, paths: readonly string[]): void {
    this.hostExecutablesByName.set(name, [...paths]);
  }

  private matchExactRules(command: readonly string[]): RuleMatch[] {
    const first = command[0];
    if (first === undefined) return [];
    const rules = this.rulesByProgram.get(first) ?? [];
    return rules.flatMap((rule) => {
      const match = prefixRuleMatches(rule, command);
      return match === null ? [] : [match];
    });
  }

  private matchHostExecutableRules(command: readonly string[]): RuleMatch[] {
    const first = command[0];
    if (first === undefined || !path.isAbsolute(first)) return [];
    const basename = executablePathLookupKey(first);
    if (basename === null) return [];
    const rules = this.rulesByProgram.get(basename);
    if (rules === undefined) return [];
    const allowedPaths = this.hostExecutablesByName.get(basename);
    if (allowedPaths !== undefined && !allowedPaths.some((entry) => entry === first)) {
      return [];
    }
    const basenameCommand = [basename, ...command.slice(1)];
    return rules.flatMap((rule) => {
      const match = prefixRuleMatches(rule, basenameCommand);
      return match === null ? [] : [withResolvedProgram(match, first)];
    });
  }
}

export function EvaluationFromMatches(matches: readonly RuleMatch[]): Evaluation {
  const decision = maxDecision(matches.map((match) => match.decision));
  if (decision === null) {
    throw new Error("invariant failed: matchedRules must be non-empty");
  }
  return {
    decision,
    matchedRules: [...matches],
  };
}

function cloneRulesByProgram(source: ReadonlyMap<string, readonly Rule[]>): Map<string, Rule[]> {
  const out = new Map<string, Rule[]>();
  for (const [program, rules] of source) {
    out.set(program, rules.map(cloneRule));
  }
  return out;
}

function cloneRule(rule: Rule): Rule {
  return {
    type: "prefix_rule",
    pattern: {
      first: rule.pattern.first,
      rest: rule.pattern.rest.map(clonePatternToken),
    },
    decision: rule.decision,
    justification: rule.justification,
  };
}

function clonePatternToken(token: PatternToken): PatternToken {
  return token.type === "single"
    ? { type: "single", value: token.value }
    : { type: "alts", alternatives: [...token.alternatives] };
}

function cloneNetworkRule(rule: NetworkRule): NetworkRule {
  return {
    host: rule.host,
    protocol: rule.protocol,
    decision: rule.decision,
    justification: rule.justification,
  };
}

function renderPatternToken(token: PatternToken): string {
  return token.type === "single" ? token.value : `[${token.alternatives.join("|")}]`;
}

function compareStringArrays(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const cmp = (left[index] ?? "").localeCompare(right[index] ?? "");
    if (cmp !== 0) return cmp;
  }
  return left.length - right.length;
}

function dedupeStringArrays(values: readonly (readonly string[])[]): string[][] {
  const out: string[][] = [];
  let previous: string | null = null;
  for (const value of values) {
    const key = JSON.stringify(value);
    if (key === previous) continue;
    out.push([...value]);
    previous = key;
  }
  return out;
}

function removeDomain(entries: string[], host: string): void {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index] === host) entries.splice(index, 1);
  }
}

function upsertDomain(entries: string[], host: string): void {
  removeDomain(entries, host);
  entries.push(host);
}

void tokenAlternatives;
