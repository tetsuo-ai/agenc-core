/**
 * Error types for AgenC execpolicy parsing, validation, and mutation.
 */

export interface TextPosition {
  readonly line: number;
  readonly column: number;
}

export interface TextRange {
  readonly start: TextPosition;
  readonly end: TextPosition;
}

export interface ErrorLocation {
  readonly path: string;
  readonly range: TextRange;
}

export type ExecPolicyErrorKind =
  | "invalid_decision"
  | "invalid_pattern"
  | "invalid_example"
  | "invalid_rule"
  | "example_did_not_match"
  | "example_did_match"
  | "parse_error";

export class ExecPolicyError extends Error {
  readonly kind: ExecPolicyErrorKind;
  readonly location: ErrorLocation | null;

  constructor(
    kind: ExecPolicyErrorKind,
    message: string,
    options: { readonly location?: ErrorLocation | null; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ExecPolicyError";
    this.kind = kind;
    this.location = options.location ?? null;
  }

  withLocation(location: ErrorLocation): ExecPolicyError {
    if (this.location !== null) return this;
    return new ExecPolicyError(this.kind, this.message, {
      location,
      cause: this.cause,
    });
  }
}

export class ExampleDidNotMatchError extends ExecPolicyError {
  readonly rules: readonly string[];
  readonly examples: readonly string[];

  constructor(
    rules: readonly string[],
    examples: readonly string[],
    location: ErrorLocation | null = null,
  ) {
    super(
      "example_did_not_match",
      `expected every example to match at least one rule. rules: ${JSON.stringify(
        rules,
      )}; unmatched examples: ${JSON.stringify(examples)}`,
      { location },
    );
    this.name = "ExampleDidNotMatchError";
    this.rules = [...rules];
    this.examples = [...examples];
  }

  override withLocation(location: ErrorLocation): ExampleDidNotMatchError {
    if (this.location !== null) return this;
    return new ExampleDidNotMatchError(this.rules, this.examples, location);
  }
}

export class ExampleDidMatchError extends ExecPolicyError {
  readonly rule: string;
  readonly example: string;

  constructor(rule: string, example: string, location: ErrorLocation | null = null) {
    super(
      "example_did_match",
      `expected example to not match rule \`${rule}\`: ${example}`,
      { location },
    );
    this.name = "ExampleDidMatchError";
    this.rule = rule;
    this.example = example;
  }

  override withLocation(location: ErrorLocation): ExampleDidMatchError {
    if (this.location !== null) return this;
    return new ExampleDidMatchError(this.rule, this.example, location);
  }
}

export function invalidDecision(raw: string): ExecPolicyError {
  return new ExecPolicyError("invalid_decision", `invalid decision: ${raw}`);
}

export function invalidPattern(message: string): ExecPolicyError {
  return new ExecPolicyError("invalid_pattern", `invalid pattern element: ${message}`);
}

export function invalidExample(message: string): ExecPolicyError {
  return new ExecPolicyError("invalid_example", `invalid example: ${message}`);
}

export function invalidRule(message: string): ExecPolicyError {
  return new ExecPolicyError("invalid_rule", `invalid rule: ${message}`);
}

export function parseError(
  message: string,
  location: ErrorLocation | null = null,
): ExecPolicyError {
  return new ExecPolicyError("parse_error", `policy parse error: ${message}`, { location });
}
