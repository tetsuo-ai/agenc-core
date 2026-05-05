import path from "node:path";

import type { Decision } from "./decision.js";
import {
  ExampleDidMatchError,
  ExampleDidNotMatchError,
  invalidRule,
} from "./error.js";

export type PatternToken =
  | { readonly type: "single"; readonly value: string }
  | { readonly type: "alts"; readonly alternatives: readonly string[] };

export interface PrefixPattern {
  readonly first: string;
  readonly rest: readonly PatternToken[];
}

export interface PrefixRule {
  readonly type: "prefix_rule";
  readonly pattern: PrefixPattern;
  readonly decision: Decision;
  readonly justification: string | null;
}

export interface NetworkRule {
  readonly host: string;
  readonly protocol: NetworkRuleProtocol;
  readonly decision: Decision;
  readonly justification: string | null;
}

export type Rule = PrefixRule;

export type RuleMatch =
  | {
      readonly type: "prefix_rule_match";
      readonly matchedPrefix: readonly string[];
      readonly decision: Decision;
      readonly resolvedProgram: string | null;
      readonly justification: string | null;
    }
  | {
      readonly type: "heuristics_rule_match";
      readonly command: readonly string[];
      readonly decision: Decision;
    };

export type SerializedRuleMatch =
  | {
      readonly prefixRuleMatch: {
        readonly matchedPrefix: readonly string[];
        readonly decision: Decision;
        readonly resolvedProgram?: string;
        readonly justification?: string;
      };
    }
  | {
      readonly heuristicsRuleMatch: {
        readonly command: readonly string[];
        readonly decision: Decision;
      };
    };

export type NetworkRuleProtocol =
  | "http"
  | "https"
  | "socks5_tcp"
  | "socks5_udp";

export function singleToken(value: string): PatternToken {
  return { type: "single", value };
}

export function alternativeToken(alternatives: readonly string[]): PatternToken {
  return alternatives.length === 1
    ? singleToken(alternatives[0] ?? "")
    : { type: "alts", alternatives: [...alternatives] };
}

export function tokenAlternatives(token: PatternToken): readonly string[] {
  return token.type === "single" ? [token.value] : token.alternatives;
}

export function patternTokenMatches(token: PatternToken, value: string): boolean {
  return token.type === "single"
    ? token.value === value
    : token.alternatives.some((alternative) => alternative === value);
}

export function prefixPatternMatches(
  pattern: PrefixPattern,
  command: readonly string[],
): readonly string[] | null {
  const patternLength = pattern.rest.length + 1;
  if (command.length < patternLength || command[0] !== pattern.first) {
    return null;
  }
  for (let index = 0; index < pattern.rest.length; index += 1) {
    const token = pattern.rest[index];
    const commandToken = command[index + 1];
    if (token === undefined || commandToken === undefined) return null;
    if (!patternTokenMatches(token, commandToken)) return null;
  }
  return command.slice(0, patternLength);
}

export function prefixRuleProgram(rule: PrefixRule): string {
  return rule.pattern.first;
}

export function prefixRuleMatches(
  rule: PrefixRule,
  command: readonly string[],
): RuleMatch | null {
  const matchedPrefix = prefixPatternMatches(rule.pattern, command);
  if (matchedPrefix === null) return null;
  return {
    type: "prefix_rule_match",
    matchedPrefix,
    decision: rule.decision,
    resolvedProgram: null,
    justification: rule.justification,
  };
}

export function withResolvedProgram(match: RuleMatch, resolvedProgram: string): RuleMatch {
  if (match.type !== "prefix_rule_match") return match;
  return {
    ...match,
    resolvedProgram,
  };
}

export function parseNetworkRuleProtocol(raw: string): NetworkRuleProtocol {
  switch (raw) {
    case "http":
      return "http";
    case "https":
    case "https_connect":
    case "http-connect":
      return "https";
    case "socks5_tcp":
      return "socks5_tcp";
    case "socks5_udp":
      return "socks5_udp";
    default:
      throw invalidRule(
        `network_rule protocol must be one of http, https, socks5_tcp, socks5_udp (got ${raw})`,
      );
  }
}

export function networkRuleProtocolAsPolicyString(
  protocol: NetworkRuleProtocol,
): string {
  return protocol;
}

export function normalizeNetworkRuleHost(raw: string): string {
  let host = raw.trim();
  if (host.length === 0) {
    throw invalidRule("network_rule host cannot be empty");
  }
  if (host.includes("://") || /[/?#]/u.test(host)) {
    throw invalidRule(
      "network_rule host must be a hostname or IP literal (without scheme or path)",
    );
  }

  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close === -1) {
      throw invalidRule("network_rule host has an invalid bracketed IPv6 literal");
    }
    const inside = host.slice(1, close);
    const rest = host.slice(close + 1);
    const port = rest.startsWith(":") ? rest.slice(1) : null;
    const portOk =
      port !== null && port.length > 0 && [...port].every((char) => isAsciiDigit(char));
    if (rest.length > 0 && !portOk) {
      throw invalidRule(`network_rule host contains an unsupported suffix: ${raw}`);
    }
    host = inside;
  } else if (countChar(host, ":") === 1) {
    const split = host.lastIndexOf(":");
    const candidate = host.slice(0, split);
    const port = host.slice(split + 1);
    if (
      candidate.length > 0 &&
      port.length > 0 &&
      [...port].every((char) => isAsciiDigit(char))
    ) {
      host = candidate;
    }
  }

  const normalized = host.trim().replace(/\.+$/u, "").trim().toLowerCase();
  if (normalized.length === 0) {
    throw invalidRule("network_rule host cannot be empty");
  }
  if (normalized.includes("*")) {
    throw invalidRule("network_rule host must be a specific host; wildcards are not allowed");
  }
  if (/\s/u.test(normalized)) {
    throw invalidRule("network_rule host cannot contain whitespace");
  }
  return normalized;
}

export function serializeRuleMatch(match: RuleMatch): SerializedRuleMatch {
  if (match.type === "heuristics_rule_match") {
    return {
      heuristicsRuleMatch: {
        command: match.command,
        decision: match.decision,
      },
    };
  }
  const payload: {
    matchedPrefix: readonly string[];
    decision: Decision;
    resolvedProgram?: string;
    justification?: string;
  } = {
    matchedPrefix: match.matchedPrefix,
    decision: match.decision,
  };
  if (match.resolvedProgram !== null) payload.resolvedProgram = match.resolvedProgram;
  if (match.justification !== null) payload.justification = match.justification;
  return { prefixRuleMatch: payload };
}

export function validateMatchExamples(
  policy: {
    matchesForCommandWithOptions(
      command: readonly string[],
      heuristicsFallback: null,
      options: { readonly resolveHostExecutables: boolean },
    ): readonly RuleMatch[];
  },
  rules: readonly Rule[],
  examples: readonly (readonly string[])[],
): void {
  const unmatched: string[] = [];
  for (const example of examples) {
    if (
      policy.matchesForCommandWithOptions(example, null, {
        resolveHostExecutables: true,
      }).length > 0
    ) {
      continue;
    }
    unmatched.push(shellJoin(example));
  }
  if (unmatched.length > 0) {
    throw new ExampleDidNotMatchError(rules.map(renderRuleForError), unmatched);
  }
}

export function validateNotMatchExamples(
  policy: {
    matchesForCommandWithOptions(
      command: readonly string[],
      heuristicsFallback: null,
      options: { readonly resolveHostExecutables: boolean },
    ): readonly RuleMatch[];
  },
  examples: readonly (readonly string[])[],
): void {
  for (const example of examples) {
    const match = policy.matchesForCommandWithOptions(example, null, {
      resolveHostExecutables: true,
    })[0];
    if (match !== undefined) {
      throw new ExampleDidMatchError(renderRuleMatchForError(match), shellJoin(example));
    }
  }
}

export function assertBareExecutableName(name: string): void {
  if (name.length === 0) {
    throw invalidRule("host_executable name cannot be empty");
  }
  if (path.basename(name) !== name || name.includes("/") || name.includes("\\")) {
    throw invalidRule(`host_executable name must be a bare executable name (got ${name})`);
  }
}

function renderRuleForError(rule: Rule): string {
  return JSON.stringify(rule);
}

function renderRuleMatchForError(match: RuleMatch): string {
  return JSON.stringify(match);
}

function shellJoin(tokens: readonly string[]): string {
  return tokens
    .map((token) =>
      /^[A-Za-z0-9_./:@%+=,-]+$/u.test(token)
        ? token
        : `'${token.replace(/'/gu, "'\\''")}'`,
    )
    .join(" ");
}

function countChar(value: string, needle: string): number {
  let count = 0;
  for (const char of value) {
    if (char === needle) count += 1;
  }
  return count;
}

function isAsciiDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

export function attachValidationLocation(
  error: unknown,
  location: import("./error.js").ErrorLocation | null,
): never {
  if (location !== null && error instanceof Error && "withLocation" in error) {
    const withLocation = error.withLocation;
    if (typeof withLocation === "function") {
      throw withLocation.call(error, location);
    }
  }
  throw error;
}
