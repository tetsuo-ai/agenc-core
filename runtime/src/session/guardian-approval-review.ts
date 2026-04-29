/**
 * Guardian approval review producer.
 *
 * This is the missing writer for `GuardianRejectionCircuitBreaker`.
 * The run-turn kernel already clears and reads the breaker; this module
 * owns the approval-time review that records denial/non-denial outcomes.
 *
 * Semantics follow upstream AgenC runtime `guardian/review.rs`:
 *   - only approval requests explicitly routed to the guardian are counted;
 *   - completed deny assessments increment the breaker;
 *   - allow/timeout/abort reset the consecutive-denial counter;
 *   - prompt/session/parse failures fail closed but do not count as
 *     breaker denials;
 *   - generic review findings count only when they are produced by this
 *     guardian approval-review prompt, not by unrelated `/review` runs.
 *
 * @module
 */

import { randomUUID } from "node:crypto";

import type { ReviewDecision } from "../permissions/review-decision.js";
import type { ApprovalCtx } from "../tools/orchestrator.js";
import type {
  AgenCDelegateSessionLike,
  AgenCReviewOneShotRequest,
} from "./agenc-delegate.js";
import { buildGuardianReviewSessionConfig } from "./agenc-delegate.js";
import type { ModelInfo, TurnContext } from "./turn-context.js";
import {
  ReviewManager,
  type ReviewFinding,
  type ReviewOutput,
} from "./review.js";
import type { GuardianRejectionCircuitBreaker } from "./guardian-rejection-circuit-breaker.js";

export const GUARDIAN_PREFERRED_MODEL = "agenc-auto-review";
export const GUARDIAN_REVIEW_TIMEOUT_MS = 90_000;
export const GUARDIAN_REVIEWER_NAME = "guardian";

const GUARDIAN_REJECTION_INSTRUCTIONS =
  "The agent must not attempt to achieve the same outcome via workaround, " +
  "indirect execution, or policy circumvention. Proceed only with a materially " +
  "safer alternative, or if the user explicitly approves the action after " +
  "being informed of the risk. Otherwise, stop and request user input.";

const GUARDIAN_TIMEOUT_INSTRUCTIONS =
  "The automatic permission approval review did not finish before its deadline. " +
  "Do not assume the action is unsafe based on the timeout alone. You may retry " +
  "once, or ask the user for guidance or explicit approval.";

const MAX_ACTION_TEXT_CHARS = 16_000;

export type GuardianRiskLevel = "low" | "medium" | "high" | "critical";
export type GuardianUserAuthorization = "unknown" | "low" | "medium" | "high";
export type GuardianAssessmentOutcome = "allow" | "deny";
export type GuardianAssessmentDecisionSource = "agent";

export interface GuardianAssessment {
  readonly riskLevel: GuardianRiskLevel;
  readonly userAuthorization: GuardianUserAuthorization;
  readonly outcome: GuardianAssessmentOutcome;
  readonly rationale: string;
}

export interface GuardianRejection {
  readonly rationale: string;
  readonly source: GuardianAssessmentDecisionSource;
}

export interface GuardianApprovalReviewOptions {
  readonly ctx: ApprovalCtx;
  readonly args?: Record<string, unknown>;
  readonly signal?: AbortSignal;
}

export interface GuardianApprovalReviewResult {
  readonly decision: ReviewDecision;
  readonly reason?: string;
  readonly reviewId: string;
  readonly assessment?: GuardianAssessment;
  readonly countedDenial: boolean;
}

export interface GuardianApprovalReviewer {
  reviewApprovalRequest(
    opts: GuardianApprovalReviewOptions,
  ): Promise<GuardianApprovalReviewResult>;
}

type DelegateServices = NonNullable<AgenCDelegateSessionLike["services"]>;
type DelegateModelsManager = NonNullable<DelegateServices["modelsManager"]>;

type GuardianModelsManager = DelegateModelsManager;

export interface GuardianApprovalReviewSession extends AgenCDelegateSessionLike {
  readonly conversationId?: string;
  readonly services?: DelegateServices & {
    readonly modelsManager?: GuardianModelsManager;
    readonly reviewManager?: ReviewManager;
    readonly guardianRejectionCircuitBreaker?: GuardianRejectionCircuitBreaker;
    readonly guardianRejections?: Map<string, unknown>;
  };
  abortTurnIfActive?(turnId: string, reason: "interrupted"): Promise<boolean>;
}

export interface DefaultGuardianApprovalReviewerOptions {
  readonly timeoutMs?: number;
}

export function newGuardianReviewId(): string {
  return randomUUID();
}

export function guardianOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      risk_level: {
        type: "string",
        enum: ["low", "medium", "high", "critical"],
      },
      user_authorization: {
        type: "string",
        enum: ["unknown", "low", "medium", "high"],
      },
      outcome: {
        type: "string",
        enum: ["allow", "deny"],
      },
      rationale: {
        type: "string",
      },
    },
    required: ["outcome"],
  };
}

export function parseGuardianAssessment(
  text: string | null | undefined,
): GuardianAssessment {
  if (text === null || text === undefined) {
    throw new Error("guardian review completed without an assessment payload");
  }
  const payload = parseGuardianAssessmentPayload(text);
  if (payload === null) {
    throw new Error("guardian assessment was not valid JSON");
  }
  const outcome = payload.outcome;
  const riskLevel = payload.risk_level ?? (outcome === "allow" ? "low" : "high");
  const rationale = nonEmpty(payload.rationale) ??
    (outcome === "allow"
      ? "Auto-review returned a low-risk allow decision."
      : "Auto-review returned a deny decision without a rationale.");
  return {
    riskLevel,
    userAuthorization: payload.user_authorization ?? "unknown",
    outcome,
    rationale,
  };
}

export function guardianRejectionMessage(
  session: GuardianApprovalReviewSession,
  reviewId: string,
): string {
  const rejection = session.services?.guardianRejections?.get(reviewId) as
    | GuardianRejection
    | undefined;
  session.services?.guardianRejections?.delete(reviewId);
  const rationale = rejection?.rationale.trim() ||
    "Auto-reviewer denied the action without a specific rationale.";
  return [
    "This action was rejected due to unacceptable risk.",
    `Reason: ${rationale}`,
    GUARDIAN_REJECTION_INSTRUCTIONS,
  ].join("\n");
}

export function guardianTimeoutMessage(): string {
  return GUARDIAN_TIMEOUT_INSTRUCTIONS;
}

export function shouldRouteApprovalToGuardian(ctx: ApprovalCtx): boolean {
  const approvalPolicy = ctx.invocation.turn.approvalPolicy?.value;
  const reviewer = ctx.invocation.turn.config?.approvalsReviewer;
  return (
    (approvalPolicy === "on_request" || approvalPolicy === "granular") &&
    (reviewer === "auto_review" || reviewer === "guardian_subagent")
  );
}

export function createDefaultGuardianApprovalReviewer(
  opts: DefaultGuardianApprovalReviewerOptions = {},
): GuardianApprovalReviewer {
  return new DefaultGuardianApprovalReviewer(opts.timeoutMs ?? GUARDIAN_REVIEW_TIMEOUT_MS);
}

class DefaultGuardianApprovalReviewer implements GuardianApprovalReviewer {
  constructor(private readonly timeoutMs: number) {}

  async reviewApprovalRequest(
    opts: GuardianApprovalReviewOptions,
  ): Promise<GuardianApprovalReviewResult> {
    const session = opts.ctx.invocation.session as GuardianApprovalReviewSession;
    const turn = opts.ctx.invocation.turn;
    const reviewId = opts.ctx.guardianReviewId ?? newGuardianReviewId();
    const turnId = opts.ctx.turnId || turn.subId;
    const actionSummary = summarizeGuardianAction(opts.ctx, opts.args ?? {});
    const targetItemId = opts.ctx.callId;
    emitGuardianAssessment(session, turnId, {
      id: reviewId,
      targetItemId,
      turnId,
      status: "in_progress",
      action: actionSummary,
    });

    if (opts.signal?.aborted === true) {
      emitGuardianAssessment(session, turnId, {
        id: reviewId,
        targetItemId,
        turnId,
        status: "aborted",
        decisionSource: "agent",
        action: actionSummary,
      });
      emitGuardianAssessmentWarning(session, turnId, "aborted", actionSummary);
      recordGuardianNonDenial(session, turnId);
      return {
        decision: { kind: "abort" },
        reason: "approval aborted",
        reviewId,
        countedDenial: false,
      };
    }

    const reviewerModel = await chooseGuardianModel(session, turn);
    const request = buildOneShotRequest({
      reviewId,
      targetItemId,
      actionSummary,
      session,
      turn,
      reviewerModel,
      ctx: opts.ctx,
      args: opts.args ?? {},
      signal: opts.signal,
      timeoutMs: this.timeoutMs,
    });
    const manager = session.services?.reviewManager ?? new ReviewManager();
    const outcome = await manager.runReview(session, request).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      return {
        verdict: "fail" as const,
        output: {
          findings: [],
          overallCorrectness: "",
          overallExplanation: "",
          overallConfidenceScore: 0,
        },
        rawText: null,
        modelUsed: reviewerModel,
        error: new Error(message),
      };
    });

    if (outcome.verdict === "timeout") {
      emitGuardianWarning(
        session,
        turnId,
        "guardian_review_timeout",
        "Automatic approval review timed out while evaluating the requested approval.",
      );
      emitGuardianAssessment(session, turnId, {
        id: reviewId,
        targetItemId,
        turnId,
        status: "timed_out",
        rationale:
          "Automatic approval review timed out while evaluating the requested approval.",
        decisionSource: "agent",
        action: actionSummary,
      });
      emitGuardianAssessmentWarning(session, turnId, "timed_out", actionSummary);
      recordGuardianNonDenial(session, turnId);
      return {
        decision: { kind: "timed_out" },
        reason: guardianTimeoutMessage(),
        reviewId,
        countedDenial: false,
      };
    }

    if (outcome.verdict === "aborted") {
      emitGuardianAssessment(session, turnId, {
        id: reviewId,
        targetItemId,
        turnId,
        status: "aborted",
        decisionSource: "agent",
        action: actionSummary,
      });
      emitGuardianAssessmentWarning(session, turnId, "aborted", actionSummary);
      recordGuardianNonDenial(session, turnId);
      return {
        decision: { kind: "abort" },
        reason: "approval aborted",
        reviewId,
        countedDenial: false,
      };
    }

    const derived = deriveAssessment(outcome.rawText, outcome.output, outcome.error);
    emitGuardianDecisionWarning(session, turnId, derived.assessment);
    emitGuardianAssessment(session, turnId, {
      id: reviewId,
      targetItemId,
      turnId,
      status: derived.assessment.outcome === "allow" ? "approved" : "denied",
      riskLevel: derived.assessment.riskLevel,
      userAuthorization: derived.assessment.userAuthorization,
      rationale: derived.assessment.rationale,
      decisionSource: "agent",
      action: actionSummary,
    });
    recordGuardianRejection(session, reviewId, derived.assessment);
    if (derived.countDenialForBreaker) {
      await recordGuardianDenial(session, turnId);
    } else {
      recordGuardianNonDenial(session, turnId);
    }

    if (derived.assessment.outcome === "allow") {
      return {
        decision: { kind: "approved" },
        reviewId,
        assessment: derived.assessment,
        countedDenial: false,
      };
    }

    return {
      decision: { kind: "denied" },
      reason: guardianRejectionMessage(session, reviewId),
      reviewId,
      assessment: derived.assessment,
      countedDenial: derived.countDenialForBreaker,
    };
  }
}

interface ParsedGuardianAssessmentPayload {
  readonly risk_level?: GuardianRiskLevel;
  readonly user_authorization?: GuardianUserAuthorization;
  readonly outcome: GuardianAssessmentOutcome;
  readonly rationale?: string;
}

function parseGuardianAssessmentPayload(
  raw: string,
): ParsedGuardianAssessmentPayload | null {
  const direct = tryParseGuardianAssessmentPayload(raw);
  if (direct !== null) return direct;
  const firstOpen = raw.indexOf("{");
  const lastClose = raw.lastIndexOf("}");
  if (firstOpen >= 0 && lastClose > firstOpen) {
    return tryParseGuardianAssessmentPayload(raw.slice(firstOpen, lastClose + 1));
  }
  return null;
}

function tryParseGuardianAssessmentPayload(
  raw: string,
): ParsedGuardianAssessmentPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const outcome = obj.outcome;
  if (outcome !== "allow" && outcome !== "deny") return null;
  const risk = obj.risk_level;
  const auth = obj.user_authorization;
  return {
    outcome,
    ...(isRiskLevel(risk) ? { risk_level: risk } : {}),
    ...(isUserAuthorization(auth) ? { user_authorization: auth } : {}),
    ...(typeof obj.rationale === "string" ? { rationale: obj.rationale } : {}),
  };
}

function isRiskLevel(value: unknown): value is GuardianRiskLevel {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "critical"
  );
}

function isUserAuthorization(value: unknown): value is GuardianUserAuthorization {
  return (
    value === "unknown" ||
    value === "low" ||
    value === "medium" ||
    value === "high"
  );
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

async function chooseGuardianModel(
  session: GuardianApprovalReviewSession,
  turn: TurnContext,
): Promise<string> {
  const models = await listModels(session.services?.modelsManager);
  const preferred = models.find((model) => model.slug === GUARDIAN_PREFERRED_MODEL);
  return preferred?.slug ?? turn.modelInfo.slug;
}

async function listModels(
  modelsManager: GuardianModelsManager | undefined,
): Promise<ReadonlyArray<ModelInfo>> {
  const listed = modelsManager?.tryListModels?.();
  if (listed !== undefined) return listed;
  return (await modelsManager?.listModels?.()) ?? [];
}

interface BuildOneShotRequestOptions {
  readonly reviewId: string;
  readonly targetItemId: string;
  readonly actionSummary: string;
  readonly session: GuardianApprovalReviewSession;
  readonly turn: TurnContext;
  readonly reviewerModel: string;
  readonly ctx: ApprovalCtx;
  readonly args: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

function buildOneShotRequest(
  opts: BuildOneShotRequestOptions,
): AgenCReviewOneShotRequest {
  const config = buildGuardianReviewSessionConfig({
    parentConfig: opts.turn.config,
    activeModel: opts.reviewerModel,
    baseInstructions: guardianPolicyPrompt(),
  });
  return {
    subId: `guardian-review-${opts.reviewId}`,
    config,
    parentContext: opts.turn,
    input: [
      {
        role: "user",
        content: buildGuardianUserPrompt(opts),
      },
    ],
    request: {
      target: `Approval request for ${opts.ctx.toolName}`,
      userFacingHint: opts.ctx.retryReason,
    },
    reviewerModel: opts.reviewerModel,
    finalOutputJsonSchema: guardianOutputSchema(),
    systemPrompt: guardianPolicyPrompt(),
    registerTask: false,
    reuseKey: false,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    timeoutMs: opts.timeoutMs,
  };
}

function guardianPolicyPrompt(): string {
  return [
    "You are AgenC's automatic approval reviewer.",
    "",
    "Decide whether the requested tool action is safe to approve under the user's instructions, the current approval policy, and the workspace context. Deny actions that are destructive, exfiltrate secrets, bypass sandboxing, perform unexplained network access, or pursue a risky workaround after a previous denial.",
    "",
    "You may only answer with strict JSON. For low-risk actions, use {\"outcome\":\"allow\"}. For anything else, use:",
    "{\"risk_level\":\"low|medium|high|critical\",\"user_authorization\":\"unknown|low|medium|high\",\"outcome\":\"allow|deny\",\"rationale\":\"string\"}",
  ].join("\n");
}

function buildGuardianUserPrompt(opts: BuildOneShotRequestOptions): string {
  return truncateActionText(
    [
      "Review this approval request and return the guardian JSON assessment.",
      "",
      `Review ID: ${opts.reviewId}`,
      `Conversation ID: ${opts.session.conversationId ?? "unknown"}`,
      `Turn ID: ${opts.ctx.turnId || opts.turn.subId}`,
      `Target item ID: ${opts.targetItemId}`,
      `Tool: ${opts.ctx.toolName}`,
      `Approval policy: ${opts.turn.approvalPolicy?.value ?? "unknown"}`,
      `Sandbox policy: ${opts.turn.sandboxPolicy?.value ?? "unknown"}`,
      opts.ctx.retryReason ? `Retry reason: ${opts.ctx.retryReason}` : undefined,
      "",
      "Action summary:",
      opts.actionSummary,
      "",
      "Arguments:",
      stringifyForReview(opts.args),
      "",
      "Payload:",
      stringifyForReview(opts.ctx.invocation.payload),
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
  );
}

function summarizeGuardianAction(
  ctx: ApprovalCtx,
  args: Record<string, unknown>,
): string {
  const command = commandSummary(ctx, args);
  if (command !== undefined) return command;
  return `${ctx.toolName} ${stringifyForReview(args)}`;
}

function commandSummary(
  ctx: ApprovalCtx,
  args: Record<string, unknown>,
): string | undefined {
  const payload = ctx.invocation.payload;
  if (payload.kind === "local_shell") {
    return payload.params.command.join(" ");
  }
  const cmd = args.cmd ?? args.command;
  if (typeof cmd === "string" && cmd.trim().length > 0) {
    return cmd;
  }
  if (Array.isArray(cmd) && cmd.every((part) => typeof part === "string")) {
    return cmd.join(" ");
  }
  return undefined;
}

interface DerivedAssessment {
  readonly assessment: GuardianAssessment;
  readonly countDenialForBreaker: boolean;
}

function deriveAssessment(
  rawText: string | null,
  genericOutput: ReviewOutput,
  error: Error | null,
): DerivedAssessment {
  try {
    const assessment = parseGuardianAssessment(rawText);
    return {
      assessment,
      countDenialForBreaker: assessment.outcome === "deny",
    };
  } catch {
    const findingAssessment = assessmentFromGenericFindings(genericOutput);
    if (findingAssessment !== null) {
      return {
        assessment: findingAssessment,
        countDenialForBreaker: true,
      };
    }
    const reason = error?.message ?? "guardian assessment was not valid JSON";
    return {
      assessment: {
        riskLevel: "high",
        userAuthorization: "unknown",
        outcome: "deny",
        rationale: `Automatic approval review failed: ${reason}`,
      },
      countDenialForBreaker: false,
    };
  }
}

function assessmentFromGenericFindings(
  output: ReviewOutput,
): GuardianAssessment | null {
  if (output.findings.length === 0) return null;
  const first = output.findings[0];
  const summary = first !== undefined
    ? summarizeFinding(first)
    : "reviewer reported approval risk";
  return {
    riskLevel: "high",
    userAuthorization: "unknown",
    outcome: "deny",
    rationale: `Generic review findings flagged this approval request: ${summary}`,
  };
}

function summarizeFinding(finding: ReviewFinding): string {
  const body = finding.body.trim();
  if (body.length === 0) return finding.title.trim();
  return `${finding.title.trim()}: ${truncateActionText(body, 500)}`;
}

function recordGuardianRejection(
  session: GuardianApprovalReviewSession,
  reviewId: string,
  assessment: GuardianAssessment,
): void {
  const store = session.services?.guardianRejections;
  if (store === undefined) return;
  if (assessment.outcome === "allow") {
    store.delete(reviewId);
    return;
  }
  store.set(reviewId, {
    rationale: assessment.rationale,
    source: "agent",
  } satisfies GuardianRejection);
}

async function recordGuardianDenial(
  session: GuardianApprovalReviewSession,
  turnId: string,
): Promise<void> {
  const action = session.services?.guardianRejectionCircuitBreaker?.recordDenial(turnId);
  if (action?.kind !== "interrupt_turn") return;
  emitGuardianWarning(
    session,
    turnId,
    "guardian_circuit_breaker",
    `Automatic approval review rejected too many approval requests for this turn (${action.consecutiveDenials} consecutive, ${action.totalDenials} total); interrupting the turn.`,
  );
  await session.abortTurnIfActive?.(turnId, "interrupted");
}

function recordGuardianNonDenial(
  session: GuardianApprovalReviewSession,
  turnId: string,
): void {
  session.services?.guardianRejectionCircuitBreaker?.recordNonDenial(turnId);
}

function emitGuardianDecisionWarning(
  session: GuardianApprovalReviewSession,
  turnId: string,
  assessment: GuardianAssessment,
): void {
  const verdict = assessment.outcome === "allow" ? "approved" : "denied";
  emitGuardianWarning(
    session,
    turnId,
    "guardian_review",
    `Automatic approval review ${verdict} (risk: ${assessment.riskLevel}, authorization: ${assessment.userAuthorization}): ${assessment.rationale}`,
  );
}

function emitGuardianAssessmentWarning(
  session: GuardianApprovalReviewSession,
  turnId: string,
  status: "aborted" | "timed_out",
  action: string,
): void {
  emitGuardianWarning(
    session,
    turnId,
    "guardian_review",
    `Automatic approval review ${status} for: ${action}`,
  );
}

function emitGuardianWarning(
  session: GuardianApprovalReviewSession,
  turnId: string,
  cause: string,
  message: string,
): void {
  session.sendEvent(turnId, {
    type: "warning",
    payload: { cause, message },
  });
}

function emitGuardianAssessment(
  session: GuardianApprovalReviewSession,
  turnId: string,
  payload: {
    readonly id: string;
    readonly targetItemId: string;
    readonly turnId: string;
    readonly status: "in_progress" | "approved" | "denied" | "timed_out" | "aborted";
    readonly riskLevel?: GuardianRiskLevel;
    readonly userAuthorization?: GuardianUserAuthorization;
    readonly rationale?: string;
    readonly decisionSource?: GuardianAssessmentDecisionSource;
    readonly action: string;
  },
): void {
  session.sendEvent(turnId, {
    type: "guardian_assessment",
    payload,
  });
}

function stringifyForReview(value: unknown): string {
  try {
    return truncateActionText(JSON.stringify(value, null, 2));
  } catch {
    return truncateActionText(String(value));
  }
}

function truncateActionText(
  text: string,
  maxChars = MAX_ACTION_TEXT_CHARS,
): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[... guardian approval request truncated ...]`;
}
