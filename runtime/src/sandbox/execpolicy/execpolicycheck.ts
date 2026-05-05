import fs from "node:fs";

import { Policy } from "./policy.js";
import { PolicyParser } from "./parser.js";
import { serializeRuleMatch, type RuleMatch } from "./rule.js";

export interface ExecPolicyCheckCommand {
  readonly rules: readonly string[];
  readonly pretty: boolean;
  readonly resolveHostExecutables: boolean;
  readonly command: readonly string[];
}

export interface ExecPolicyCheckOutput {
  readonly matchedRules: readonly ReturnType<typeof serializeRuleMatch>[];
  readonly decision?: string;
}

export interface ExecPolicyCheckIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
}

export function runExecPolicyCheckCommand(
  command: ExecPolicyCheckCommand,
  io: ExecPolicyCheckIo = { stdout: process.stdout },
): void {
  const policy = loadPolicies(command.rules);
  const matchedRules = policy.matchesForCommandWithOptions(command.command, null, {
    resolveHostExecutables: command.resolveHostExecutables,
  });
  io.stdout.write(`${formatMatchesJson(matchedRules, command.pretty)}\n`);
}

export function formatMatchesJson(
  matchedRules: readonly RuleMatch[],
  pretty: boolean,
): string {
  const decision = maxMatchedDecision(matchedRules);
  const output: ExecPolicyCheckOutput = {
    matchedRules: matchedRules.map(serializeRuleMatch),
    ...(decision === null ? {} : { decision }),
  };
  return pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output);
}

export function loadPolicies(policyPaths: readonly string[]): Policy {
  const parser = new PolicyParser();
  for (const policyPath of policyPaths) {
    let contents: string;
    try {
      contents = fs.readFileSync(policyPath, "utf8");
    } catch (error) {
      throw new Error(
        `failed to read policy at ${policyPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    try {
      parser.parse(policyPath, contents);
    } catch (error) {
      throw new Error(
        `failed to parse policy at ${policyPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }
  return parser.build();
}

function maxMatchedDecision(matchedRules: readonly RuleMatch[]): string | null {
  const order = new Map([
    ["allow", 0],
    ["prompt", 1],
    ["forbidden", 2],
  ]);
  let current: string | null = null;
  for (const rule of matchedRules) {
    if (
      current === null ||
      (order.get(rule.decision) ?? -1) > (order.get(current) ?? -1)
    ) {
      current = rule.decision;
    }
  }
  return current;
}
