/**
 * Goal intake: turn `/goal <text> [flags]` into a {@link SessionGoal}.
 *
 * A goal without a verification surface is the underspecified case that
 * Ambig-SWE (arXiv:2502.13069) shows agents neither notice nor recover from
 * alone, so intake refuses it and says exactly how to supply one, unless the
 * user opts into a judge-only goal with `--no-verify`.
 *
 * @module
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  detectPackageManager,
  parsePackageJson,
} from "../config/project-init.js";
import {
  DEFAULT_GOAL_MAX_ROUNDS,
  GOAL_INTEGRITY_CONSTRAINT,
  GOAL_MAX_ROUNDS_HARD_CAP,
  GOAL_MAX_VERIFICATION_COMMANDS,
  GOAL_OBJECTIVE_MAX_CHARS,
  type GoalVerificationCommand,
  type SessionGoal,
} from "./goal.js";

export type GoalCommand =
  | { readonly kind: "status" }
  | { readonly kind: "clear" }
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  | { readonly kind: "set"; readonly request: GoalSetRequest }
  | { readonly kind: "error"; readonly message: string };

export interface GoalSetRequest {
  readonly objective: string;
  readonly verify: readonly GoalVerificationCommand[];
  readonly noVerify: boolean;
  readonly maxRounds?: number;
  readonly maxCostUsd?: number;
}

const CLEAR_ALIASES = new Set(["clear", "stop", "off", "cancel", "reset", "none"]);

export const GOAL_USAGE = [
  "Usage:",
  "  /goal <objective> [--verify \"label=command\"]... [--max-rounds N] [--max-cost USD] [--no-verify]",
  "  /goal            show the active goal",
  "  /goal pause | resume | clear",
  "",
  "Write the objective as an end state that a command can prove, for example:",
  "  /goal every test in test/auth passes and no other test file changes --verify \"tests=npm test\"",
].join("\n");

/** Quote-aware split: `--verify "tests=npm test"` stays one value. */
export function tokenizeGoalArgs(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (const char of raw) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (hasToken || current.length > 0) tokens.push(current);
      current = "";
      hasToken = false;
      continue;
    }
    current += char;
  }
  if (hasToken || current.length > 0) tokens.push(current);
  return tokens;
}

function parseVerify(value: string, index: number): GoalVerificationCommand | null {
  const match = /^([A-Za-z0-9_.-]{1,40})=(.+)$/su.exec(value.trim());
  const label = match?.[1] ?? `check ${index + 1}`;
  const script = (match?.[2] ?? value).trim();
  return script.length === 0 ? null : { label, script };
}

export function parseGoalCommand(argsRaw: string): GoalCommand {
  const trimmed = argsRaw.trim();
  if (trimmed.length === 0) return { kind: "status" };
  const lowered = trimmed.toLowerCase();
  if (CLEAR_ALIASES.has(lowered)) return { kind: "clear" };
  if (lowered === "pause") return { kind: "pause" };
  if (lowered === "resume") return { kind: "resume" };
  if (lowered === "status") return { kind: "status" };

  const tokens = tokenizeGoalArgs(trimmed);
  const words: string[] = [];
  const verify: GoalVerificationCommand[] = [];
  let noVerify = false;
  let maxRounds: number | undefined;
  let maxCostUsd: number | undefined;
  let literal = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (literal) {
      words.push(token);
      continue;
    }
    if (token === "--") {
      literal = true;
      continue;
    }
    if (token === "--no-verify") {
      noVerify = true;
      continue;
    }
    const flag = /^(--verify|--max-rounds|--max-cost)(?:=(.*))?$/su.exec(token);
    if (flag === null) {
      words.push(token);
      continue;
    }
    const name = flag[1]!;
    const value = flag[2] ?? tokens[(index += 1)];
    if (value === undefined || value.length === 0) {
      return { kind: "error", message: `${name} needs a value.\n${GOAL_USAGE}` };
    }
    if (name === "--verify") {
      const command = parseVerify(value, verify.length);
      if (command === null) {
        return { kind: "error", message: `--verify needs a command.\n${GOAL_USAGE}` };
      }
      verify.push(command);
      continue;
    }
    const numeric = Number(value);
    if (name === "--max-rounds") {
      if (!Number.isInteger(numeric) || numeric < 1 || numeric > GOAL_MAX_ROUNDS_HARD_CAP) {
        return {
          kind: "error",
          message: `--max-rounds must be a whole number from 1 to ${GOAL_MAX_ROUNDS_HARD_CAP}.`,
        };
      }
      maxRounds = numeric;
      continue;
    }
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return { kind: "error", message: "--max-cost must be a positive number of US dollars." };
    }
    maxCostUsd = numeric;
  }
  const objective = words.join(" ").trim();
  if (objective.length === 0) {
    return { kind: "error", message: `A goal needs an objective.\n${GOAL_USAGE}` };
  }
  if (objective.length > GOAL_OBJECTIVE_MAX_CHARS) {
    return {
      kind: "error",
      message: `The objective is ${objective.length} characters; the limit is ${GOAL_OBJECTIVE_MAX_CHARS}.`,
    };
  }
  if (verify.length > GOAL_MAX_VERIFICATION_COMMANDS) {
    return {
      kind: "error",
      message: `A goal takes at most ${GOAL_MAX_VERIFICATION_COMMANDS} verification commands.`,
    };
  }
  if (noVerify && verify.length > 0) {
    return { kind: "error", message: "--no-verify and --verify contradict each other." };
  }
  return {
    kind: "set",
    request: {
      objective,
      verify,
      noVerify,
      ...(maxRounds !== undefined ? { maxRounds } : {}),
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    },
  };
}

const NPM_PLACEHOLDER_TEST = /no test specified/iu;

function readIfPresent(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The project's own test entry points, in the order a developer would reach
 * for them. Only commands whose purpose is verification: a `build` or `dev`
 * script proves nothing about a goal.
 */
export function detectVerificationCommands(
  cwd: string,
): readonly GoalVerificationCommand[] {
  let names: string[];
  try {
    names = readdirSync(cwd);
  } catch {
    return [];
  }
  const files = new Map<string, string>();
  for (const name of names) files.set(name, "");
  const commands: GoalVerificationCommand[] = [];
  const pkg = parsePackageJson(readIfPresent(join(cwd, "package.json")));
  const scripts =
    pkg !== null && typeof pkg.scripts === "object" && pkg.scripts !== null
      ? (pkg.scripts as Record<string, unknown>)
      : {};
  const testScript = scripts.test;
  if (typeof testScript === "string" && !NPM_PLACEHOLDER_TEST.test(testScript)) {
    commands.push({
      label: "tests",
      script: `${detectPackageManager(files, pkg)} test`,
    });
  }
  if (files.has("Cargo.toml")) commands.push({ label: "tests", script: "cargo test" });
  if (files.has("go.mod")) commands.push({ label: "tests", script: "go test ./..." });
  const pythonProject = files.has("pyproject.toml") || files.has("requirements.txt");
  const pythonTests =
    files.has("pytest.ini") || files.has("tests") || files.has("test") || files.has("conftest.py");
  if (pythonProject && pythonTests) {
    commands.push({ label: "tests", script: "python -m pytest" });
  }
  if (commands.length === 0) {
    const makefile = readIfPresent(join(cwd, "Makefile"));
    if (makefile !== undefined && /^test\s*:/mu.test(makefile)) {
      commands.push({ label: "tests", script: "make test" });
    }
  }
  return commands.slice(0, GOAL_MAX_VERIFICATION_COMMANDS);
}

export type GoalIntakeResult =
  | { readonly ok: true; readonly goal: SessionGoal; readonly detected: boolean }
  | { readonly ok: false; readonly message: string };

export function buildSessionGoal(input: {
  readonly request: GoalSetRequest;
  readonly cwd: string;
  readonly id: string;
  readonly now: string;
  readonly sessionCostUsd: number;
  readonly baseCommit?: string;
  readonly defaultMaxRounds?: number;
  readonly detect?: (cwd: string) => readonly GoalVerificationCommand[];
}): GoalIntakeResult {
  const { request } = input;
  let verification = request.verify;
  let detected = false;
  if (verification.length === 0 && !request.noVerify) {
    verification = (input.detect ?? detectVerificationCommands)(input.cwd);
    detected = verification.length > 0;
    if (verification.length === 0) {
      return {
        ok: false,
        message: [
          "This goal has no way to be checked: no test command was found in this project.",
          "Say how success is proven, for example:",
          `  /goal ${request.objective} --verify "tests=<your test command>"`,
          "Or accept a review-only goal, judged from the diff and the agent's executed checks:",
          `  /goal ${request.objective} --no-verify`,
        ].join("\n"),
      };
    }
  }
  const maxRounds = Math.min(
    GOAL_MAX_ROUNDS_HARD_CAP,
    Math.max(1, request.maxRounds ?? input.defaultMaxRounds ?? DEFAULT_GOAL_MAX_ROUNDS),
  );
  return {
    ok: true,
    detected,
    goal: {
      id: input.id,
      objective: request.objective,
      verification,
      criteria: [],
      constraints: [GOAL_INTEGRITY_CONSTRAINT],
      budget: {
        maxRounds,
        ...(request.maxCostUsd !== undefined ? { maxCostUsd: request.maxCostUsd } : {}),
      },
      status: "active",
      rounds: 0,
      stalledRounds: 0,
      startedAt: input.now,
      startCostUsd: input.sessionCostUsd,
      ...(input.baseCommit !== undefined ? { baseCommit: input.baseCommit } : {}),
    },
  };
}
