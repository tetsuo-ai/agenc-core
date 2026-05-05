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
  readonly positionalArgs: readonly DslValue[];
  readonly args: ReadonlyMap<string, DslValue>;
  readonly location: ErrorLocation;
}

interface ParserPosition {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

interface UserFunction {
  readonly params: readonly string[];
  readonly bodyExpression: string;
}

interface BlockSource {
  readonly source: string;
  readonly startLine: number;
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

  private applyPrefixRule(rawStatement: CallStatement): void {
    const statement = bindPositionalArgs(rawStatement, [
      "pattern",
      "decision",
      "match",
      "not_match",
      "justification",
    ]);
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

  private applyNetworkRule(rawStatement: CallStatement): void {
    const statement = bindPositionalArgs(rawStatement, [
      "host",
      "protocol",
      "decision",
      "justification",
    ]);
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

  private applyHostExecutable(rawStatement: CallStatement): void {
    const statement = bindPositionalArgs(rawStatement, ["name", "paths"]);
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

function bindPositionalArgs(
  statement: CallStatement,
  positionalNames: readonly string[],
): CallStatement {
  if (statement.positionalArgs.length > positionalNames.length) {
    throw invalidRule(
      `${statement.name} got ${statement.positionalArgs.length} positional arguments; expected at most ${positionalNames.length}`,
    );
  }
  const args = new Map(statement.args);
  for (let index = 0; index < statement.positionalArgs.length; index += 1) {
    const name = positionalNames[index];
    if (name === undefined) continue;
    if (args.has(name)) {
      throw invalidRule(`${statement.name} got multiple values for argument ${name}`);
    }
    const value = statement.positionalArgs[index];
    if (value !== undefined) args.set(name, cloneDslValue(value));
  }
  return {
    ...statement,
    positionalArgs: [],
    args,
  };
}

function assertAllowedArgs(statement: CallStatement, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of statement.args.keys()) {
    if (!allowedSet.has(key)) {
      throw invalidRule(`${statement.name} got unexpected argument ${key}`);
    }
  }
}

function cloneDslValue(value: DslValue): DslValue {
  return typeof value === "string" ? value : value.map(cloneDslValue);
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
  private readonly variables: Map<string, DslValue>;
  private readonly functions: Map<string, UserFunction>;

  constructor(
    private readonly policyIdentifier: string,
    private readonly source: string,
    variables: ReadonlyMap<string, DslValue> = new Map(),
    functions: Map<string, UserFunction> = new Map(),
    startLine = 1,
  ) {
    this.line = startLine;
    this.variables = new Map(
      [...variables.entries()].map(([key, value]) => [key, cloneDslValue(value)]),
    );
    this.functions = functions;
  }

  parse(): CallStatement[] {
    const statements: CallStatement[] = [];
    while (true) {
      this.skipTrivia();
      if (this.eof()) return statements;
      const statement = this.parseTopLevelStatement();
      if (Array.isArray(statement)) statements.push(...statement);
      else if (statement !== null) statements.push(statement);
    }
  }

  private parseTopLevelStatement(): CallStatement | CallStatement[] | null {
    const start = this.position();
    const name = this.parseIdentifier();
    if (name === "def") {
      this.parseFunctionDefinition();
      return null;
    }
    if (name === "for") {
      return this.parseForLoop();
    }
    this.skipTrivia();
    if (this.consume("=")) {
      this.variables.set(name, cloneDslValue(this.parseExpression()));
      return null;
    }
    this.expect("(");
    return this.parseCallStatement(name, start);
  }

  private parseCallStatement(name: string, start: TextPosition): CallStatement {
    const args = new Map<string, DslValue>();
    const positionalArgs: DslValue[] = [];
    let sawNamedArg = false;
    this.skipTrivia();
    while (!this.consume(")")) {
      const checkpoint = this.snapshot();
      const first = this.peek();
      if (first !== null && isIdentifierStart(first)) {
        const key = this.parseIdentifier();
        this.skipTrivia();
        if (this.consume("=")) {
          sawNamedArg = true;
          this.skipTrivia();
          if (args.has(key)) {
            throw this.error(`duplicate argument ${key}`);
          }
          args.set(key, this.parseExpression());
          this.skipTrivia();
          if (this.consume(",")) {
            this.skipTrivia();
            continue;
          }
          this.expect(")");
          break;
        }
      }

      if (sawNamedArg) {
        throw this.error("positional argument cannot follow keyword argument");
      }
      this.restore(checkpoint);
      positionalArgs.push(this.parseExpression());
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
      positionalArgs,
      args,
      location: {
        path: this.policyIdentifier,
        range: { start, end },
      },
    };
  }

  private parseFunctionDefinition(): void {
    this.skipHorizontalTrivia();
    const name = this.parseIdentifier();
    this.skipTrivia();
    this.expect("(");
    const params: string[] = [];
    this.skipTrivia();
    while (!this.consume(")")) {
      params.push(this.parseIdentifier());
      this.skipTrivia();
      if (this.consume(",")) {
        this.skipTrivia();
        continue;
      }
      this.expect(")");
      break;
    }
    this.skipHorizontalTrivia();
    this.expect(":");
    const body = this.readIndentedBlockSource();
    const statements = body.source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    if (statements.length !== 1 || !statements[0]?.startsWith("return ")) {
      throw this.error("policy helper functions must contain a single return expression");
    }
    this.functions.set(name, {
      params,
      bodyExpression: statements[0].slice("return ".length),
    });
  }

  private parseForLoop(): CallStatement[] {
    this.skipHorizontalTrivia();
    const variableName = this.parseIdentifier();
    this.skipHorizontalTrivia();
    const inKeyword = this.parseIdentifier();
    if (inKeyword !== "in") {
      throw this.error("expected `in` in for loop");
    }
    const iterable = this.parseExpression();
    if (!Array.isArray(iterable)) {
      throw this.error("for loop iterable must be a list");
    }
    this.skipHorizontalTrivia();
    this.expect(":");
    const body = this.readIndentedBlockSource();
    const hadPrevious = this.variables.has(variableName);
    const previous = this.variables.get(variableName);
    const statements: CallStatement[] = [];
    try {
      for (const value of iterable) {
        this.variables.set(variableName, cloneDslValue(value));
        statements.push(
          ...new DeclarativePolicyParser(
            this.policyIdentifier,
            body.source,
            this.variables,
            this.functions,
            body.startLine,
          ).parse(),
        );
      }
    } finally {
      if (hadPrevious && previous !== undefined) this.variables.set(variableName, previous);
      else this.variables.delete(variableName);
    }
    return statements;
  }

  private parseExpression(): DslValue {
    let left = this.parseTerm();
    while (true) {
      this.skipTrivia();
      if (!this.consume("+")) return left;
      const right = this.parseTerm();
      left = this.addValues(left, right);
    }
  }

  private parseTerm(): DslValue {
    this.skipTrivia();
    const char = this.peek();
    if ((char === "f" || char === "F") && (this.peekNext() === "\"" || this.peekNext() === "'")) {
      return this.parseFString();
    }
    if (char === "\"" || char === "'") return this.parseString();
    if (char === "[") return this.parseList();
    if (char === "(") {
      this.advance();
      const value = this.parseExpression();
      this.skipTrivia();
      this.expect(")");
      return value;
    }
    if (char !== null && isIdentifierStart(char)) {
      const name = this.parseIdentifier();
      this.skipTrivia();
      if (this.peek() === "(") {
        return this.parseFunctionCall(name);
      }
      const value = this.variables.get(name);
      if (value === undefined) {
        throw this.error(`unknown policy variable ${name}`);
      }
      return cloneDslValue(value);
    }
    throw this.error("expected string, list, or expression value");
  }

  private addValues(left: DslValue, right: DslValue): DslValue {
    if (typeof left === "string" && typeof right === "string") return left + right;
    if (Array.isArray(left) && Array.isArray(right)) {
      return [...left.map(cloneDslValue), ...right.map(cloneDslValue)];
    }
    throw this.error("operator + requires two strings or two lists");
  }

  private parseList(): DslValue[] {
    this.expect("[");
    const comprehension = this.tryParseListComprehension();
    if (comprehension !== null) return comprehension;
    const values: DslValue[] = [];
    this.skipTrivia();
    while (!this.consume("]")) {
      values.push(this.parseExpression());
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

  private parseFunctionCall(name: string): DslValue {
    const fn = this.functions.get(name);
    if (fn === undefined) {
      throw this.error(`unknown policy function ${name}`);
    }
    this.expect("(");
    const args: DslValue[] = [];
    this.skipTrivia();
    while (!this.consume(")")) {
      args.push(this.parseExpression());
      this.skipTrivia();
      if (this.consume(",")) {
        this.skipTrivia();
        continue;
      }
      this.expect(")");
      break;
    }
    if (args.length !== fn.params.length) {
      throw this.error(`policy function ${name} expected ${fn.params.length} arguments but got ${args.length}`);
    }
    const locals = new Map(this.variables);
    for (let index = 0; index < fn.params.length; index += 1) {
      const param = fn.params[index];
      const arg = args[index];
      if (param !== undefined && arg !== undefined) {
        locals.set(param, cloneDslValue(arg));
      }
    }
    return this.evaluateExpressionSnippet(fn.bodyExpression, locals);
  }

  private tryParseListComprehension(): DslValue[] | null {
    const start = this.offset;
    const end = this.findClosingListBracket(start - 1);
    if (end === null) return null;
    const content = this.source.slice(start, end);
    const comprehension = splitListComprehension(content);
    if (comprehension === null) return null;
    const { itemExpression, variableName, iterableExpression } = comprehension;
    const iterable = this.evaluateExpressionSnippet(iterableExpression, this.variables);
    if (!Array.isArray(iterable)) {
      throw this.error("list comprehension iterable must be a list");
    }
    const hadPrevious = this.variables.has(variableName);
    const previous = this.variables.get(variableName);
    const values: DslValue[] = [];
    try {
      for (const value of iterable) {
        this.variables.set(variableName, cloneDslValue(value));
        values.push(this.evaluateExpressionSnippet(itemExpression, this.variables));
      }
    } finally {
      if (hadPrevious && previous !== undefined) this.variables.set(variableName, previous);
      else this.variables.delete(variableName);
    }
    this.advanceTo(end + 1);
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

  private parseFString(): string {
    this.advance();
    const quote = this.peek();
    if (quote !== "\"" && quote !== "'") throw this.error("expected f-string");
    this.advance();
    let out = "";
    while (!this.eof()) {
      const char = this.advance();
      if (char === quote) return out;
      if (char === "\n" || char === "\r") {
        throw this.error("raw newline in string literal");
      }
      if (char === "{") {
        if (this.peek() === "{") {
          this.advance();
          out += "{";
          continue;
        }
        out += this.parseFStringReplacement();
        continue;
      }
      if (char === "}") {
        if (this.peek() === "}") {
          this.advance();
          out += "}";
          continue;
        }
        throw this.error("single `}` is not allowed in f-string literal");
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
        continue;
      }
      out += char;
    }
    throw this.error("unterminated string");
  }

  private parseFStringReplacement(): string {
    let expression = "";
    while (!this.eof()) {
      const char = this.advance();
      if (char === "}") {
        const name = expression.trim();
        if (!isIdentifier(name)) {
          throw this.error("f-string replacement must be a string variable");
        }
        const value = this.variables.get(name);
        if (value === undefined) {
          throw this.error(`unknown policy variable ${name}`);
        }
        if (typeof value !== "string") {
          throw this.error(`f-string replacement ${name} must be a string`);
        }
        return value;
      }
      if (char === "\n" || char === "\r") {
        throw this.error("raw newline in string literal");
      }
      expression += char;
    }
    throw this.error("unterminated f-string replacement");
  }

  private evaluateExpressionSnippet(
    source: string,
    variables: ReadonlyMap<string, DslValue>,
  ): DslValue {
    const parser = new DeclarativePolicyParser(
      this.policyIdentifier,
      source,
      variables,
      this.functions,
    );
    const value = parser.parseExpression();
    parser.skipTrivia();
    if (!parser.eof()) {
      throw this.error(`unsupported expression syntax: ${source.trim()}`);
    }
    return value;
  }

  private readIndentedBlockSource(): BlockSource {
    this.skipHorizontalTrivia();
    if (this.peek() !== "\n") {
      throw this.error("expected newline before indented block");
    }
    this.advance();
    const blockStart = this.offset;
    const startLine = this.line;
    let scan = this.offset;
    let indent: number | null = null;
    let blockEnd = this.offset;
    while (scan < this.source.length) {
      const lineStart = scan;
      const newline = this.source.indexOf("\n", lineStart);
      const lineEnd = newline === -1 ? this.source.length : newline;
      const line = this.source.slice(lineStart, lineEnd);
      if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
        scan = newline === -1 ? this.source.length : newline + 1;
        if (indent !== null) blockEnd = scan;
        continue;
      }
      const lineIndent = leadingWhitespaceWidth(line);
      if (indent === null) {
        if (lineIndent === 0) {
          throw this.error("expected indented block");
        }
        indent = lineIndent;
      }
      if (lineIndent < indent) break;
      blockEnd = newline === -1 ? this.source.length : newline + 1;
      scan = blockEnd;
    }
    if (indent === null) {
      throw this.error("expected indented block");
    }
    const block = this.source
      .slice(blockStart, blockEnd)
      .split("\n")
      .map((line) => stripIndent(line, indent))
      .join("\n");
    this.advanceTo(blockEnd);
    return { source: block, startLine };
  }

  private findClosingListBracket(openOffset: number): number | null {
    let depth = 0;
    let quote: "'" | "\"" | null = null;
    for (let index = openOffset; index < this.source.length; index += 1) {
      const char = this.source[index] ?? "";
      if (quote !== null) {
        if (char === "\\") {
          index += 1;
          continue;
        }
        if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === "\"") {
        quote = char;
        continue;
      }
      if (char === "[") {
        depth += 1;
        continue;
      }
      if (char === "]") {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return null;
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

  private skipHorizontalTrivia(): void {
    while (!this.eof()) {
      const char = this.peek();
      if (char === " " || char === "\t") {
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

  private snapshot(): ParserPosition {
    return {
      offset: this.offset,
      line: this.line,
      column: this.column,
    };
  }

  private restore(position: ParserPosition): void {
    this.offset = position.offset;
    this.line = position.line;
    this.column = position.column;
  }

  private peek(): string | null {
    return this.eof() ? null : this.source[this.offset] ?? null;
  }

  private peekNext(): string | null {
    const nextOffset = this.offset + 1;
    return nextOffset >= this.source.length ? null : this.source[nextOffset] ?? null;
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

  private advanceTo(targetOffset: number): void {
    while (this.offset < targetOffset) this.advance();
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

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_]/u.test(char);
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

function leadingWhitespaceWidth(line: string): number {
  let count = 0;
  for (const char of line) {
    if (char === " ") count += 1;
    else if (char === "\t") count += 1;
    else break;
  }
  return count;
}

function stripIndent(line: string, indent: number): string {
  let offset = 0;
  let remaining = indent;
  while (remaining > 0 && offset < line.length) {
    const char = line[offset];
    if (char !== " " && char !== "\t") break;
    offset += 1;
    remaining -= 1;
  }
  return line.slice(offset);
}

function splitListComprehension(
  content: string,
): { itemExpression: string; variableName: string; iterableExpression: string } | null {
  const trimmed = content.trim();
  const forIndex = findTopLevelKeyword(trimmed, "for");
  if (forIndex === null) return null;
  const inIndex = findTopLevelKeyword(trimmed, "in", forIndex + "for".length);
  if (inIndex === null) return null;
  const itemExpression = trimmed.slice(0, forIndex).trim();
  const variableName = trimmed.slice(forIndex + "for".length, inIndex).trim();
  const iterableExpression = trimmed.slice(inIndex + "in".length).trim();
  if (itemExpression.length === 0 || iterableExpression.length === 0) return null;
  if (!isIdentifier(variableName)) return null;
  return { itemExpression, variableName, iterableExpression };
}

function findTopLevelKeyword(source: string, keyword: string, start = 0): number | null {
  let depth = 0;
  let quote: "'" | "\"" | null = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote !== null) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "[" || char === "(" || char === "{") {
      depth += 1;
      continue;
    }
    if (char === "]" || char === ")" || char === "}") {
      depth -= 1;
      continue;
    }
    if (depth !== 0 || !source.startsWith(keyword, index)) continue;
    const before = source[index - 1];
    const after = source[index + keyword.length];
    const beforeOk = before === undefined || !/[A-Za-z0-9_]/u.test(before);
    const afterOk = after === undefined || !/[A-Za-z0-9_]/u.test(after);
    if (beforeOk && afterOk) return index;
  }
  return null;
}
