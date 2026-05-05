import path from "node:path";

import { parseDecision, type Decision } from "./decision.js";
import { executableLookupKey, executablePathLookupKey } from "./executable-name.js";
import {
  ExecPolicyError,
  invalidExample,
  invalidPattern,
  invalidRule,
  parseError,
  type ErrorLocation,
  type TextPosition,
} from "./error.js";
import { Policy } from "./policy.js";
import {
  assertBareExecutableName,
  attachValidationLocation,
  normalizeNetworkRuleHost,
  parseNetworkRuleProtocol,
  singleToken,
  alternativeToken,
  validateMatchExamples,
  validateNotMatchExamples,
  type NetworkRule,
  type PatternToken,
  type PrefixRule,
  type Rule,
} from "./rule.js";

type DslValue = string | DslValue[];

interface CallStatement {
  readonly name: string;
  readonly args: ReadonlyMap<string, DslValue>;
  readonly location: ErrorLocation;
}

interface PendingExampleValidation {
  readonly rules: readonly Rule[];
  readonly matches: readonly (readonly string[])[];
  readonly notMatches: readonly (readonly string[])[];
  readonly location: ErrorLocation | null;
}

class PolicyBuilder {
  readonly rulesByProgram = new Map<string, Rule[]>();
  readonly networkRules: NetworkRule[] = [];
  readonly hostExecutablesByName = new Map<string, readonly string[]>();
  readonly pendingExampleValidations: PendingExampleValidation[] = [];

  addRule(rule: Rule): void {
    const existing = this.rulesByProgram.get(rule.pattern.first) ?? [];
    existing.push(rule);
    this.rulesByProgram.set(rule.pattern.first, existing);
  }

  addNetworkRule(rule: NetworkRule): void {
    this.networkRules.push(rule);
  }

  addHostExecutable(name: string, paths: readonly string[]): void {
    this.hostExecutablesByName.set(name, [...paths]);
  }

  addPendingExampleValidation(
    rules: readonly Rule[],
    matches: readonly (readonly string[])[],
    notMatches: readonly (readonly string[])[],
    location: ErrorLocation | null,
  ): void {
    this.pendingExampleValidations.push({
      rules: [...rules],
      matches: matches.map((entry) => [...entry]),
      notMatches: notMatches.map((entry) => [...entry]),
      location,
    });
  }

  validatePendingExamplesFrom(start: number): void {
    for (const validation of this.pendingExampleValidations.slice(start)) {
      const rulesByProgram = new Map<string, Rule[]>();
      for (const rule of validation.rules) {
        const rules = rulesByProgram.get(rule.pattern.first) ?? [];
        rules.push(rule);
        rulesByProgram.set(rule.pattern.first, rules);
      }
      const policy = Policy.fromParts(
        rulesByProgram,
        [],
        this.hostExecutablesByName,
      );
      try {
        validateNotMatchExamples(policy, validation.notMatches);
        validateMatchExamples(policy, validation.rules, validation.matches);
      } catch (error) {
        attachValidationLocation(error, validation.location);
      }
    }
  }

  build(): Policy {
    return Policy.fromParts(
      this.rulesByProgram,
      this.networkRules,
      this.hostExecutablesByName,
    );
  }
}

export class PolicyParser {
  private readonly builder = new PolicyBuilder();

  parse(policyIdentifier: string, policyFileContents: string): void {
    const pendingValidationCount = this.builder.pendingExampleValidations.length;
    const statements = new DeclarativePolicyParser(
      policyIdentifier,
      policyFileContents,
    ).parse();
    for (const statement of statements) {
      this.applyStatement(statement);
    }
    this.builder.validatePendingExamplesFrom(pendingValidationCount);
  }

  build(): Policy {
    return this.builder.build();
  }

  private applyStatement(statement: CallStatement): void {
    try {
      switch (statement.name) {
        case "prefix_rule":
          this.applyPrefixRule(statement);
          return;
        case "network_rule":
          this.applyNetworkRule(statement);
          return;
        case "host_executable":
          this.applyHostExecutable(statement);
          return;
        default:
          throw invalidRule(`unknown policy builtin ${statement.name}`);
      }
    } catch (error) {
      if (error instanceof ExecPolicyError && error.location === null) {
        throw error.withLocation(statement.location);
      }
      throw error;
    }
  }

  private applyPrefixRule(statement: CallStatement): void {
    assertAllowedArgs(statement, ["pattern", "decision", "justification", "match", "not_match"]);
    const decision = optionalStringArg(statement, "decision", null);
    const parsedDecision = decision === null ? "allow" : parseDecision(decision);
    const justification = optionalJustification(statement);
    const patternTokens = parsePattern(requiredArg(statement, "pattern"));
    const matches = parseExamples(optionalArg(statement, "match"));
    const notMatches = parseExamples(optionalArg(statement, "not_match"));

    const [firstToken, ...remainingTokens] = patternTokens;
    if (firstToken === undefined) {
      throw invalidPattern("pattern cannot be empty");
    }

    const rules: PrefixRule[] = tokenAlternatives(firstToken).map((head) => ({
      type: "prefix_rule",
      pattern: {
        first: head,
        rest: remainingTokens,
      },
      decision: parsedDecision,
      justification,
    }));

    this.builder.addPendingExampleValidation(
      rules,
      matches,
      notMatches,
      statement.location,
    );
    for (const rule of rules) {
      this.builder.addRule(rule);
    }
  }

  private applyNetworkRule(statement: CallStatement): void {
    assertAllowedArgs(statement, ["host", "protocol", "decision", "justification"]);
    const host = normalizeNetworkRuleHost(requiredStringArg(statement, "host"));
    const protocol = parseNetworkRuleProtocol(requiredStringArg(statement, "protocol"));
    const rawDecision = requiredStringArg(statement, "decision");
    const decision = parseNetworkRuleDecision(rawDecision);
    const justification = optionalJustification(statement);
    this.builder.addNetworkRule({
      host,
      protocol,
      decision,
      justification,
    });
  }

  private applyHostExecutable(statement: CallStatement): void {
    assertAllowedArgs(statement, ["name", "paths"]);
    const name = requiredStringArg(statement, "name");
    assertBareExecutableName(name);
    const paths = requiredListArg(statement, "paths").map((value) => {
      const raw = stringValue(value, "host_executable paths must be strings");
      if (!path.isAbsolute(raw)) {
        throw invalidRule(`host_executable paths must be absolute (got ${raw})`);
      }
      const pathName = executablePathLookupKey(raw);
      if (pathName === null || pathName !== executableLookupKey(name)) {
        throw invalidRule(`host_executable path \`${raw}\` must have basename \`${name}\``);
      }
      return raw;
    });
    this.builder.addHostExecutable(executableLookupKey(name), dedupe(paths));
  }
}

function assertAllowedArgs(statement: CallStatement, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of statement.args.keys()) {
    if (!allowedSet.has(key)) {
      throw invalidRule(`${statement.name} got unexpected argument ${key}`);
    }
  }
}

function parsePattern(value: DslValue): PatternToken[] {
  const tokens = patternListValue(value, "pattern must be a list");
  const parsed = tokens.map(parsePatternToken);
  if (parsed.length === 0) {
    throw invalidPattern("pattern cannot be empty");
  }
  return parsed;
}

function parsePatternToken(value: DslValue): PatternToken {
  if (typeof value === "string") return singleToken(value);
  const alternatives = value.map((entry) =>
    patternStringValue(entry, "pattern alternative must be a string"),
  );
  if (alternatives.length === 0) {
    throw invalidPattern("pattern alternatives cannot be empty");
  }
  return alternativeToken(alternatives);
}

function parseExamples(value: DslValue | null): string[][] {
  if (value === null) return [];
  return exampleListValue(value, "examples must be a list").map(parseExample);
}

function parseExample(value: DslValue): string[] {
  if (typeof value === "string") {
    const tokens = splitShellWords(value);
    if (tokens === null) {
      throw invalidExample("example string has invalid shell syntax");
    }
    if (tokens.length === 0) {
      throw invalidExample("example cannot be an empty string");
    }
    return tokens;
  }
  const tokens = value.map((entry) =>
    exampleStringValue(entry, "example tokens must be strings"),
  );
  if (tokens.length === 0) {
    throw invalidExample("example cannot be an empty list");
  }
  return tokens;
}

function parseNetworkRuleDecision(raw: string): Decision {
  return raw === "deny" ? "forbidden" : parseDecision(raw);
}

function requiredArg(statement: CallStatement, key: string): DslValue {
  const value = optionalArg(statement, key);
  if (value === null) {
    throw invalidRule(`${statement.name} requires ${key}`);
  }
  return value;
}

function optionalArg(statement: CallStatement, key: string): DslValue | null {
  return statement.args.get(key) ?? null;
}

function requiredStringArg(statement: CallStatement, key: string): string {
  return stringValue(requiredArg(statement, key), `${statement.name} ${key} must be a string`);
}

function optionalStringArg(
  statement: CallStatement,
  key: string,
  fallback: string | null,
): string | null {
  const value = optionalArg(statement, key);
  return value === null
    ? fallback
    : stringValue(value, `${statement.name} ${key} must be a string`);
}

function requiredListArg(statement: CallStatement, key: string): DslValue[] {
  return listValue(requiredArg(statement, key), `${statement.name} ${key} must be a list`);
}

function optionalJustification(statement: CallStatement): string | null {
  const justification = optionalStringArg(statement, "justification", null);
  if (justification !== null && justification.trim().length === 0) {
    throw invalidRule("justification cannot be empty");
  }
  return justification;
}

function stringValue(value: DslValue, message: string): string {
  if (typeof value === "string") return value;
  throw invalidRule(`${message} (got list)`);
}

function listValue(value: DslValue, message: string): DslValue[] {
  if (Array.isArray(value)) return value;
  throw invalidRule(`${message} (got string)`);
}

function patternStringValue(value: DslValue, message: string): string {
  if (typeof value === "string") return value;
  throw invalidPattern(`${message} (got list)`);
}

function patternListValue(value: DslValue, message: string): DslValue[] {
  if (Array.isArray(value)) return value;
  throw invalidPattern(`${message} (got string)`);
}

function exampleStringValue(value: DslValue, message: string): string {
  if (typeof value === "string") return value;
  throw invalidExample(`${message} (got list)`);
}

function exampleListValue(value: DslValue, message: string): DslValue[] {
  if (Array.isArray(value)) return value;
  throw invalidExample(`${message} (got string)`);
}

function tokenAlternatives(token: PatternToken): readonly string[] {
  return token.type === "single" ? [token.value] : token.alternatives;
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function splitShellWords(raw: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let tokenStarted = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] ?? "";
    if (quote === null && /\s/u.test(char)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    if (char === "\\" && quote !== "'") {
      const next = raw[index + 1];
      if (next === undefined) return null;
      current += next;
      tokenStarted = true;
      index += 1;
      continue;
    }
    if ((char === "'" || char === "\"") && (quote === null || quote === char)) {
      quote = quote === null ? char : null;
      tokenStarted = true;
      continue;
    }
    current += char;
    tokenStarted = true;
  }

  if (quote !== null) return null;
  if (tokenStarted) tokens.push(current);
  return tokens;
}

class DeclarativePolicyParser {
  private offset = 0;
  private line = 1;
  private column = 1;

  constructor(
    private readonly policyIdentifier: string,
    private readonly source: string,
  ) {}

  parse(): CallStatement[] {
    const statements: CallStatement[] = [];
    while (true) {
      this.skipTrivia();
      if (this.eof()) return statements;
      statements.push(this.parseCallStatement());
    }
  }

  private parseCallStatement(): CallStatement {
    const start = this.position();
    const name = this.parseIdentifier();
    this.skipTrivia();
    this.expect("(");
    const args = new Map<string, DslValue>();
    this.skipTrivia();
    while (!this.consume(")")) {
      const key = this.parseIdentifier();
      this.skipTrivia();
      this.expect("=");
      this.skipTrivia();
      if (args.has(key)) {
        throw this.error(`duplicate argument ${key}`);
      }
      args.set(key, this.parseValue());
      this.skipTrivia();
      if (this.consume(",")) {
        this.skipTrivia();
        continue;
      }
      this.expect(")");
      break;
    }
    const end = this.position();
    return {
      name,
      args,
      location: {
        path: this.policyIdentifier,
        range: { start, end },
      },
    };
  }

  private parseValue(): DslValue {
    this.skipTrivia();
    const char = this.peek();
    if (char === "\"" || char === "'") return this.parseString();
    if (char === "[") return this.parseList();
    throw this.error("expected string or list value");
  }

  private parseList(): DslValue[] {
    this.expect("[");
    const values: DslValue[] = [];
    this.skipTrivia();
    while (!this.consume("]")) {
      values.push(this.parseValue());
      this.skipTrivia();
      if (this.consume(",")) {
        this.skipTrivia();
        continue;
      }
      this.expect("]");
      break;
    }
    return values;
  }

  private parseString(): string {
    const quote = this.peek();
    if (quote !== "\"" && quote !== "'") throw this.error("expected string");
    this.advance();
    let out = "";
    while (!this.eof()) {
      const char = this.advance();
      if (char === quote) return out;
      if (char === "\n" || char === "\r") {
        throw this.error("raw newline in string literal");
      }
      if (char === "\\") {
        const escaped = this.advance();
        if (escaped === "\n" || escaped === "\r") {
          throw this.error("raw newline in string literal");
        }
        switch (escaped) {
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "\\":
          case "\"":
          case "'":
            out += escaped;
            break;
          default:
            out += escaped;
            break;
        }
      } else {
        out += char;
      }
    }
    throw this.error("unterminated string");
  }

  private parseIdentifier(): string {
    this.skipTrivia();
    const start = this.offset;
    const first = this.peek();
    if (first === null || !/[A-Za-z_]/u.test(first)) {
      throw this.error("expected identifier");
    }
    this.advance();
    while (!this.eof()) {
      const char = this.peek();
      if (char === null || !/[A-Za-z0-9_]/u.test(char)) break;
      this.advance();
    }
    return this.source.slice(start, this.offset);
  }

  private skipTrivia(): void {
    while (!this.eof()) {
      const char = this.peek();
      if (char !== null && /\s/u.test(char)) {
        this.advance();
        continue;
      }
      if (char === "#") {
        while (!this.eof() && this.peek() !== "\n") this.advance();
        continue;
      }
      return;
    }
  }

  private consume(expected: string): boolean {
    if (this.peek() !== expected) return false;
    this.advance();
    return true;
  }

  private expect(expected: string): void {
    if (!this.consume(expected)) {
      throw this.error(`expected \`${expected}\``);
    }
  }

  private peek(): string | null {
    return this.eof() ? null : this.source[this.offset] ?? null;
  }

  private advance(): string {
    if (this.eof()) throw this.error("unexpected end of input");
    const char = this.source[this.offset] ?? "";
    this.offset += 1;
    if (char === "\n") {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
    return char;
  }

  private eof(): boolean {
    return this.offset >= this.source.length;
  }

  private position(): TextPosition {
    return { line: this.line, column: this.column };
  }

  private error(message: string): ExecPolicyError {
    const position = this.position();
    return parseError(message, {
      path: this.policyIdentifier,
      range: {
        start: position,
        end: position,
      },
    });
  }
}
