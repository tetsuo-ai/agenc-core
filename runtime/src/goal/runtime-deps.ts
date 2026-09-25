/**
 * The goal gate's contact with the outside world: run a verification command,
 * read the diff, ask the independent judge. Injectable so the gate's decision
 * flow is testable with scripted observations.
 *
 * Verification runs through the session's own shell tool and router, so it
 * inherits the sandbox, the permission evaluation, admission and the audit
 * trail of any other command in this session. The goal grants no authority.
 *
 * @module
 */
import { randomUUID } from "node:crypto";

import { buildLiveToolDispatchOptions } from "../phases/execute-tools.js";
import {
  buildGuardianReviewSessionConfig,
  runAgenCReviewOneShot,
  type AgenCDelegateSessionLike,
} from "../session/agenc-delegate.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import { routerFromRegistry } from "../tools/router.js";
import { runGit } from "../utils/git.js";
import {
  boundedExcerpt,
  type GoalVerificationCommand,
  type GoalVerificationResult,
} from "./goal.js";

export const DEFAULT_GOAL_VERIFY_TIMEOUT_MS = 10 * 60_000;
export const GOAL_JUDGE_TIMEOUT_MS = 120_000;
const GOAL_DIFF_MAX_CHARS = 60_000;
const SHELL_TOOL_NAME = "system.bash";

export interface GoalGateDeps {
  now(): string;
  sessionCostUsd(session: Session): number;
  runVerification(input: {
    readonly commands: readonly GoalVerificationCommand[];
    readonly ctx: TurnContext;
    readonly session: Session;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly GoalVerificationResult[]>;
  changedPaths(cwd: string, baseCommit: string | undefined): Promise<readonly string[]>;
  diff(
    cwd: string,
    baseCommit: string | undefined,
  ): Promise<{ readonly stat: string; readonly diff: string }>;
  /** Raw judge text; throws when the judge could not be reached. */
  judge(input: {
    readonly systemPrompt: string;
    readonly userMessage: string;
    readonly model: string | undefined;
    readonly ctx: TurnContext;
    readonly session: Session;
    readonly signal?: AbortSignal;
  }): Promise<string>;
}

function metadataNumber(metadata: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metadataText(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value : "";
}

async function runOneVerification(
  command: GoalVerificationCommand,
  ctx: TurnContext,
  session: Session,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<GoalVerificationResult> {
  const startedAt = Date.now();
  if (!session.services.registry.tools.some((tool) => tool.name === SHELL_TOOL_NAME)) {
    return {
      ...command,
      exitCode: 127,
      timedOut: false,
      durationMs: 0,
      excerpt: `The session has no ${SHELL_TOOL_NAME} tool, so the runtime cannot run this check.`,
    };
  }
  const router = routerFromRegistry(session.services.registry);
  const result = await router.dispatchModelToolCall(
    {
      id: `goal-verify-${randomUUID()}`,
      name: SHELL_TOOL_NAME,
      arguments: JSON.stringify({ command: command.script, timeoutMs }),
    },
    { ...buildLiveToolDispatchOptions(ctx, session, signal), source: "direct" },
  );
  const metadata = result.metadata;
  const timedOut = metadata?.timedOut === true;
  const reported = metadataNumber(metadata, "exitCode");
  // A refused or failed dispatch has no exit code: that is a failure, never a pass.
  const exitCode = reported ?? (result.isError === true || timedOut ? 1 : 0);
  const output = [metadataText(metadata, "stdout"), metadataText(metadata, "stderr")]
    .filter((part) => part.length > 0)
    .join("\n");
  return {
    ...command,
    exitCode: result.isError === true && exitCode === 0 ? 1 : exitCode,
    timedOut,
    durationMs: metadataNumber(metadata, "durationMs") ?? Date.now() - startedAt,
    excerpt: boundedExcerpt(output.length > 0 ? output : result.content),
  };
}

async function gitText(args: readonly string[], cwd: string): Promise<string> {
  try {
    const result = await runGit(args, cwd);
    return result.code === 0 && !result.timedOut ? result.stdout : "";
  } catch {
    return "";
  }
}

export async function resolveGoalBaseCommit(cwd: string): Promise<string | undefined> {
  const head = (await gitText(["rev-parse", "HEAD"], cwd)).trim();
  return /^[0-9a-f]{7,64}$/u.test(head) ? head : undefined;
}

export const defaultGoalGateDeps: GoalGateDeps = {
  now: () => new Date().toISOString(),
  sessionCostUsd: (session) => session.services.costSidecar?.getTotalCostUsd() ?? 0,
  async runVerification({ commands, ctx, session, timeoutMs, signal }) {
    const results: GoalVerificationResult[] = [];
    // Sequential on purpose: checks share a workspace and build caches.
    for (const command of commands) {
      signal?.throwIfAborted();
      results.push(await runOneVerification(command, ctx, session, timeoutMs, signal));
    }
    return results;
  },
  async changedPaths(cwd, baseCommit) {
    if (baseCommit === undefined) return [];
    const [tracked, untracked] = await Promise.all([
      gitText(["diff", "--name-only", baseCommit], cwd),
      gitText(["ls-files", "--others", "--exclude-standard"], cwd),
    ]);
    const paths = new Set<string>();
    for (const line of `${tracked}\n${untracked}`.split("\n")) {
      const path = line.trim();
      if (path.length > 0) paths.add(path);
    }
    return [...paths];
  },
  async diff(cwd, baseCommit) {
    if (baseCommit === undefined) return { stat: "", diff: "" };
    const [stat, diff] = await Promise.all([
      gitText(["diff", "--stat", baseCommit], cwd),
      gitText(["diff", "--no-color", baseCommit], cwd),
    ]);
    return {
      stat: stat.trim(),
      diff:
        diff.length > GOAL_DIFF_MAX_CHARS
          ? `${diff.slice(0, GOAL_DIFF_MAX_CHARS)}\n[diff truncated at ${GOAL_DIFF_MAX_CHARS} characters]`
          : diff.trim(),
    };
  },
  async judge({ systemPrompt, userMessage, model, ctx, session, signal }) {
    const reviewerModel = model ?? ctx.modelInfo.slug;
    const outcome = await runAgenCReviewOneShot(
      session as unknown as AgenCDelegateSessionLike,
      {
        subId: `goal-judge-${randomUUID()}`,
        config: buildGuardianReviewSessionConfig({
          parentConfig: ctx.config,
          activeModel: reviewerModel,
          baseInstructions: systemPrompt,
        }),
        parentContext: ctx,
        input: [{ role: "user", content: userMessage }],
        request: {
          target: "session goal",
          userFacingHint: "independent goal review",
        },
        reviewerModel,
        systemPrompt,
        timeoutMs: GOAL_JUDGE_TIMEOUT_MS,
        // The judge runs inside the worker's live turn. Registering a
        // Session task here would abort that turn as "replaced".
        registerTask: false,
        reuseKey: false,
        ...(signal !== undefined ? { signal } : {}),
      },
    );
    if (outcome.rawText === null) {
      throw new Error(
        outcome.error instanceof Error
          ? outcome.error.message
          : `goal judge returned no text (verdict ${outcome.verdict})`,
      );
    }
    return outcome.rawText;
  },
};
