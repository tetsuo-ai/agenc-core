/**
 * Review-task subsystem for the AgenC session kernel.
 *
 * Port of the upstream agenc runtime review machinery:
 *   - `agenc-rs/core/src/tasks/review.rs` — the `ReviewTask` trait impl
 *     (`TaskKind::Review`, `span_name("session_task.review")`, run/abort
 *     wiring, process_review_events, exit_review_mode, and the
 *     JSON-parsing fallback for `ReviewOutputEvent`).
 *   - `agenc-rs/core/src/session/review.rs` — the `spawn_review_thread`
 *     entry point that builds a review-scoped `TurnContext`, disables
 *     web-search / view-image features, and spawns the `ReviewTask` via
 *     `Session::spawn_task`.
 *   - `agenc-rs/core/src/guardian/review_session.rs` —
 *     `GuardianReviewSessionManager`. This file ports the manager's
 *     shape and lifecycle primitives (`shutdown`, trunk vs ephemeral
 *     review-session tracking).
 *   - `agenc-rs/core/review_prompt.md` and the two
 *     `agenc-rs/core/templates/review/*.xml` templates — lifted
 *     verbatim into the three exported string constants so future
 *     `spawnReviewTask` wiring can reach them without adding a file
 *     loader.
 *
 * Purpose. Wave 2 landed the generic task-dispatch machinery in
 * `session/tasks.ts`, including a `TaskKind` union that already
 * contains `"review"`. But there was no review-task implementation or
 * manager, so `Session.spawnTask({kind: "review", ...})` had no
 * producer. This module provides:
 *
 *   1. `spawnReviewTask(session, opts)` — the session-scoped entry
 *      point. Calls `session.spawnTask({kind: "review", ...})` so the
 *      review task flows through the same replace-on-new-turn lifecycle
 *      as regular turns (upstream agenc runtime
 *      `session/review.rs::spawn_review_thread -> sess.spawn_task`).
 *
 *   2. `ReviewManager` — the agenc runtime `GuardianReviewSessionManager`
 *      port. Tracks the "trunk" review session and any ephemeral fork
 *      review sessions by subId so `shutdown()` can cancel them all on
 *      session teardown. The full trunk-reuse and ephemeral-fork
 *      semantics from `guardian/review_session.rs` (reuse-key
 *      invalidation, fork snapshots, prior-review-count deltas) now
 *      route through the AgenC child-session delegate.
 *
 *   3. `isTaskKindSteerable(kind)` — the classifier used by the
 *      forthcoming steer_input port (Item 6). Review tasks are
 *      explicitly NON-steerable (upstream agenc runtime treats
 *      `TaskKind::Review` as reject-on-steer). The classifier is
 *      implemented against the TaskKind contract so it can be asserted
 *      today even before the steer_input path is wired through.
 *
 *   4. The three review-prompt string constants
 *      (`REVIEW_SYSTEM_PROMPT`, `REVIEW_EXIT_SUCCESS_TMPL`,
 *      `REVIEW_EXIT_INTERRUPTED_TMPL`) — ported verbatim from the
 *      upstream assets so the reviewer runner can synthesize the
 *      system prompt and exit-templates without a file loader.
 *
 *   5. `ReviewRequest`, `ReviewFinding`, `ReviewOutput` — the
 *      structural types corresponding to upstream agenc runtime
 *      `agenc runtime-protocol::protocol::{ReviewRequest, ReviewOutputEvent}`
 *      and `ReviewLineRange` / `ReviewCodeLocation`. Shapes are
 *      preserved so `parseReviewOutput` can deserialize a reviewer
 *      model's JSON response (or fall back to the plain-text path
 *      mirroring upstream `parse_review_output_event`).
 *
 * `spawnReviewTask` now runs the full scoped reviewer turn by owning
 * the parent `kind: "review"` task while delegating model execution to
 * the isolated AgenC child-session driver in `agenc-delegate.ts`.
 *
 * @module
 */

import type {
  SessionTask,
  SessionTaskAbortContext,
  SessionTaskRunContext,
  TaskKind,
} from "./tasks.js";
import type {
  AgenCDelegateSessionLike,
  AgenCReviewOneShotOutcome,
  AgenCReviewOneShotRequest,
  ExitReviewModePayload,
} from "./agenc-delegate.js";
import type { ReviewDelegateCompletionReason } from "./event-log.js";
import type { ResponseItem } from "./rollout-item.js";
import type { LLMMessage } from "../llm/types.js";

// ─────────────────────────────────────────────────────────────────────
// Structural types (upstream `agenc runtime-protocol` review surface)
// ─────────────────────────────────────────────────────────────────────

/**
 * Upstream agenc runtime `agenc runtime-protocol::protocol::ReviewRequest`. Describes
 * what the user / operator asked the reviewer model to look at. The
 * target is a free-form description (e.g. "Diff between HEAD and
 * main") that upstream threads through `resolved.target`.
 */
export interface ReviewRequest {
  readonly target: string;
  readonly userFacingHint?: string;
}

/**
 * Upstream agenc runtime `agenc runtime-protocol::protocol::ReviewLineRange`.
 */
export interface ReviewLineRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Upstream agenc runtime `agenc runtime-protocol::protocol::ReviewCodeLocation`.
 */
export interface ReviewCodeLocation {
  readonly absolutePath: string;
  readonly lineRange: ReviewLineRange;
}

/**
 * Upstream agenc runtime `agenc runtime-protocol::protocol::ReviewFinding`.
 */
export interface ReviewFinding {
  readonly title: string;
  readonly body: string;
  readonly confidenceScore: number;
  readonly priority: number;
  readonly codeLocation: ReviewCodeLocation;
}

/**
 * Upstream agenc runtime `agenc runtime-protocol::protocol::ReviewOutputEvent`. Shape
 * of the structured review output the reviewer model returns. The
 * plain-text fallback path in `parseReviewOutput` stuffs the raw text
 * into `overallExplanation` and leaves `findings` empty, matching
 * upstream `tasks/review.rs::parse_review_output_event`.
 */
export interface ReviewOutput {
  readonly findings: ReadonlyArray<ReviewFinding>;
  readonly overallCorrectness: string;
  readonly overallExplanation: string;
  readonly overallConfidenceScore: number;
}

/**
 * Fresh-default `ReviewOutput` with all-zero confidences and no
 * findings. Mirrors upstream `Default` impl on `ReviewOutputEvent`.
 */
export function emptyReviewOutput(): ReviewOutput {
  return {
    findings: [],
    overallCorrectness: "",
    overallExplanation: "",
    overallConfidenceScore: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Task-kind classification (steer_input readiness)
// ─────────────────────────────────────────────────────────────────────

/**
 * Upstream agenc runtime `tasks/mod.rs` classification consumed by the
 * steer_input gate (Item 6 port): a review task cannot be steered
 * with a mid-turn user message. Upstream rejects with
 * `ActiveTurnNotSteerable`.
 *
 * Returns `true` when the task kind accepts steer input, `false`
 * otherwise. Today only `regular` tasks are steerable. `review` and
 * `compact` both reject, matching upstream behavior.
 *
 * Exposed as a free function so the forthcoming `steer_input` path
 * (and tests today, before that path lands) can assert the
 * classification against the public TaskKind contract without
 * dragging the `ReviewTask` implementation around.
 */
export function isTaskKindSteerable(kind: TaskKind): boolean {
  switch (kind) {
    case "regular":
      return true;
    case "review":
    case "compact":
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Review prompt / exit templates (verbatim from upstream assets)
// ─────────────────────────────────────────────────────────────────────

/**
 * Upstream agenc runtime `core/review_prompt.md`. Used as the reviewer
 * model's `base_instructions` in `tasks/review.rs::start_review_conversation`.
 * Ported verbatim so a later runner can set it on the review-scoped
 * config without needing a file loader. First-line header retained
 * for fidelity; newlines normalized to `\n` (the upstream file is LF).
 */
export const REVIEW_SYSTEM_PROMPT: string = [
  "# Review guidelines:",
  "",
  "You are acting as a reviewer for a proposed code change made by another engineer.",
  "",
  "Below are some default guidelines for determining whether the original author would appreciate the issue being flagged.",
  "",
  "These are not the final word in determining whether an issue is a bug. In many cases, you will encounter other, more specific guidelines. These may be present elsewhere in a developer message, a user message, a file, or even elsewhere in this system message.",
  "Those guidelines should be considered to override these general instructions.",
  "",
  "Here are the general guidelines for determining whether something is a bug and should be flagged.",
  "",
  "1. It meaningfully impacts the accuracy, performance, security, or maintainability of the code.",
  "2. The bug is discrete and actionable (i.e. not a general issue with the codebase or a combination of multiple issues).",
  "3. Fixing the bug does not demand a level of rigor that is not present in the rest of the codebase (e.g. one doesn't need very detailed comments and input validation in a repository of one-off scripts in personal projects)",
  "4. The bug was introduced in the commit (pre-existing bugs should not be flagged).",
  "5. The author of the original PR would likely fix the issue if they were made aware of it.",
  "6. The bug does not rely on unstated assumptions about the codebase or author's intent.",
  "7. It is not enough to speculate that a change may disrupt another part of the codebase, to be considered a bug, one must identify the other parts of the code that are provably affected.",
  "8. The bug is clearly not just an intentional change by the original author.",
].join("\n");

/**
 * Upstream agenc runtime `core/templates/review/exit_success.xml`. Rendered
 * by `render_review_exit_success` with `{{results}}` substituted in.
 * Ported verbatim; `renderReviewExitSuccess` below performs the
 * single-placeholder substitution (no template engine dependency).
 */
export const REVIEW_EXIT_SUCCESS_TMPL: string = [
  "<user_action>",
  "  <context>User initiated a review task. Here's the full review output from reviewer model. User may select one or more comments to resolve.</context>",
  "  <action>review</action>",
  "  <results>",
  "  {{results}}",
  "  </results>",
  "  </user_action>",
].join("\n");

/**
 * Upstream agenc runtime `core/templates/review/exit_interrupted.xml`.
 * Emitted when `review_output` is `None` in upstream
 * `exit_review_mode`.
 */
export const REVIEW_EXIT_INTERRUPTED_TMPL: string = [
  "<user_action>",
  "  <context>User initiated a review task, but was interrupted. If user asks about this, tell them to re-initiate a review with `/review` and wait for it to complete.</context>",
  "  <action>review</action>",
  "  <results>",
  "  None.",
  "  </results>",
  "</user_action>",
  "",
].join("\n");

/**
 * Upstream agenc runtime `tasks/review.rs::render_review_exit_success`. Single
 * placeholder template substitution (`{{results}}`). Upstream uses a
 * real template engine (`agenc runtime_utils_template::Template`); gut uses
 * plain string replace because there is only ever one placeholder.
 */
export function renderReviewExitSuccess(results: string): string {
  return REVIEW_EXIT_SUCCESS_TMPL.replace("{{results}}", results);
}

const REVIEW_ROLLOUT_USER_MESSAGE_ID = "review_rollout_user";
const REVIEW_ROLLOUT_ASSISTANT_MESSAGE_ID = "review_rollout_assistant";
const REVIEW_FALLBACK_MESSAGE = "Reviewer failed to output a response.";

interface ReviewRolloutSessionLike {
  readonly rolloutStore?: {
    appendRollout(item: { readonly type: "response_item"; readonly payload: ResponseItem }, opts?: unknown): void;
  } | null;
  readonly state?: {
    with<R>(fn: (value: { history?: unknown[] }) => R | Promise<R>): Promise<R>;
  };
}

function formatReviewLocation(item: ReviewFinding): string {
  const loose = item as ReviewFinding & {
    readonly code_location?: {
      readonly absolute_file_path?: string;
      readonly absolute_path?: string;
      readonly line_range?: { readonly start?: number; readonly end?: number };
    };
  };
  const loc = item.codeLocation ?? {
    absolutePath:
      loose.code_location?.absolute_path ??
      loose.code_location?.absolute_file_path ??
      "",
    lineRange: {
      start: loose.code_location?.line_range?.start ?? 0,
      end: loose.code_location?.line_range?.end ?? 0,
    },
  };
  return `${loc.absolutePath}:${loc.lineRange.start}-${loc.lineRange.end}`;
}

function formatReviewFindingsBlock(
  findings: ReadonlyArray<ReviewFinding>,
  selection?: ReadonlyArray<boolean>,
): string {
  const lines: string[] = ["", findings.length > 1 ? "Full review comments:" : "Review comment:"];
  findings.forEach((item, idx) => {
    lines.push("");
    const marker =
      selection !== undefined ? `${selection[idx] ?? true ? "[x]" : "[ ]"} ` : "";
    lines.push(`- ${marker}${item.title} - ${formatReviewLocation(item)}`);
    for (const bodyLine of item.body.split(/\r?\n/)) {
      lines.push(`  ${bodyLine}`);
    }
  });
  return lines.join("\n");
}

function renderReviewOutputText(output: ReviewOutput): string {
  const sections: string[] = [];
  const explanation = output.overallExplanation.trim();
  if (explanation.length > 0) sections.push(explanation);
  if (output.findings.length > 0) {
    const findings = formatReviewFindingsBlock(output.findings).trim();
    if (findings.length > 0) sections.push(findings);
  }
  return sections.length > 0 ? sections.join("\n\n") : REVIEW_FALLBACK_MESSAGE;
}

function buildReviewExitResponseItems(
  payload: ExitReviewModePayload,
): readonly [ResponseItem, ResponseItem] {
  const completed = payload.reason === "completed";
  const userMessage = completed
    ? renderReviewExitSuccess(renderReviewOutputText(payload.reviewOutput))
    : REVIEW_EXIT_INTERRUPTED_TMPL;
  const assistantMessage = completed
    ? renderReviewOutputText(payload.reviewOutput)
    : "Review was interrupted. Please re-run /review and wait for it to complete.";
  return [
    {
      id: REVIEW_ROLLOUT_USER_MESSAGE_ID,
      role: "user",
      content: userMessage,
    },
    {
      id: REVIEW_ROLLOUT_ASSISTANT_MESSAGE_ID,
      role: "assistant",
      content: assistantMessage,
    },
  ];
}

export async function recordReviewExitRollout(
  session: unknown,
  payload: ExitReviewModePayload,
): Promise<void> {
  const target = session as ReviewRolloutSessionLike;
  const items = buildReviewExitResponseItems(payload);
  for (const item of items) {
    target.rolloutStore?.appendRollout({
      type: "response_item",
      payload: item,
    });
  }
  await target.state?.with((state) => {
    if (!Array.isArray(state.history)) return;
    state.history = [...state.history, ...items];
  });
}

// ─────────────────────────────────────────────────────────────────────
// Review output parser (upstream parse_review_output_event)
// ─────────────────────────────────────────────────────────────────────

/**
 * Upstream agenc runtime `tasks/review.rs::parse_review_output_event`. Parses
 * a reviewer model's response text as JSON matching `ReviewOutput`.
 * If the raw text is not valid JSON, attempts to extract the
 * first-`{` to last-`}` substring and parse that (matching upstream's
 * `text.find('{')` / `text.rfind('}')` slice). On every parse failure,
 * returns a plain-text fallback where `overallExplanation` carries
 * the raw text verbatim.
 *
 * Gut does not ship a JSON-schema validator, so the parse accepts any
 * object shape and maps the known fields by structural check (upstream
 * uses `serde_json::from_str<ReviewOutputEvent>` which is similarly
 * lenient about additional fields).
 */
export function parseReviewOutput(text: string): ReviewOutput {
  const direct = tryParseReviewOutput(text);
  if (direct !== null) return direct;
  const firstOpen = text.indexOf("{");
  const lastClose = text.lastIndexOf("}");
  if (firstOpen >= 0 && lastClose > firstOpen) {
    const sliced = text.slice(firstOpen, lastClose + 1);
    const sliceParsed = tryParseReviewOutput(sliced);
    if (sliceParsed !== null) return sliceParsed;
  }
  return {
    ...emptyReviewOutput(),
    overallExplanation: text,
  };
}

function tryParseReviewOutput(raw: string): ReviewOutput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    // Upstream `serde_json::from_str<ReviewOutputEvent>` rejects arrays
    // and primitives because ReviewOutputEvent is an object schema.
    // The gut parser mirrors that by falling through to the substring
    // path (which will then fall through to plain-text) when the
    // top-level JSON is not an object literal.
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const findingsRaw = obj.findings;
  const findings = Array.isArray(findingsRaw)
    ? findingsRaw.filter(
        (f): f is ReviewFinding =>
          typeof f === "object" && f !== null && typeof (f as ReviewFinding).title === "string",
      )
    : [];
  return {
    findings,
    overallCorrectness:
      typeof obj.overall_correctness === "string"
        ? (obj.overall_correctness as string)
        : typeof obj.overallCorrectness === "string"
          ? (obj.overallCorrectness as string)
          : "",
    overallExplanation:
      typeof obj.overall_explanation === "string"
        ? (obj.overall_explanation as string)
        : typeof obj.overallExplanation === "string"
          ? (obj.overallExplanation as string)
          : "",
    overallConfidenceScore:
      typeof obj.overall_confidence_score === "number"
        ? (obj.overall_confidence_score as number)
        : typeof obj.overallConfidenceScore === "number"
          ? (obj.overallConfidenceScore as number)
          : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Review-session manager (upstream GuardianReviewSessionManager)
// ─────────────────────────────────────────────────────────────────────

/**
 * `SessionLike` surface needed by `spawnReviewTask`. Matches the live
 * `Session` review-delegate surface without importing the concrete
 * class here (avoids a circular dep with `session.ts`).
 */
export interface SessionLike extends AgenCDelegateSessionLike {
  newDefaultTurnWithSubId?(
    subId: string,
  ): AgenCReviewOneShotRequest["parentContext"];
}

/**
 * Tracked entry in `ReviewManager`. Carries the spawned task's
 * `subId`, its abort controller so `shutdown()` can cancel it, and
 * the original review request for UI hint surfacing.
 */
interface TrackedReview {
  readonly subId: string;
  readonly abortController: AbortController;
  readonly request: ReviewRequest;
}

/**
 * Upstream agenc runtime `guardian/review_session.rs::GuardianReviewSessionManager`,
 * ported to the gut session surface. Tracks live review tasks by
 * subId so a session-level shutdown can cancel them all.
 *
 * The upstream manager distinguishes a long-lived "trunk" review
 * session from short-lived "ephemeral" fork reviews; the AgenC port
 * keeps lifecycle entries in one registry and snapshots review
 * histories by reuse key for child delegates.
 */
export class ReviewManager {
  private readonly reviews = new Map<string, TrackedReview>();
  private readonly snapshots = new Map<string, ReviewConversationSnapshot>();

  /**
   * Upstream: `spawn_guardian_review_session` → `state.trunk = ...`.
   * Called by `spawnReviewTask` after `session.spawnTask` returns a
   * live `RunningTask`. Idempotent w.r.t. duplicate subIds — a
   * second `register` call for the same subId replaces the earlier
   * entry (matching upstream `trunk.replace` semantics).
   */
  register(entry: TrackedReview): void {
    this.reviews.set(entry.subId, entry);
  }

  /**
   * Upstream: `take_active_ephemeral` / `remove_trunk_if_current`.
   * Returns the registered entry for `subId` and removes it from the
   * map. `undefined` if the subId was not tracked (upstream returns
   * `Option::None`).
   */
  take(subId: string): TrackedReview | undefined {
    const entry = this.reviews.get(subId);
    if (entry !== undefined) this.reviews.delete(subId);
    return entry;
  }

  /**
   * Non-destructive membership check. Exposed for the steer_input
   * gate and telemetry so callers can ask "is there a live review?".
   */
  has(subId: string): boolean {
    return this.reviews.has(subId);
  }

  /**
   * Upstream `GuardianReviewSessionManager::shutdown`. Cancels every
   * tracked review's abort controller. Cancellation is fire-and-forget
   * here; the underlying `RunningTask.done` promise is awaited by
   * `Session.abortAllTasks` under the graceful-interruption budget
   * (see `tasks.ts::GRACEFUL_INTERRUPTION_TIMEOUT_MS`), so this does
   * not need to re-implement the bounded wait.
   */
  shutdown(reason: unknown = "review_ended"): void {
    for (const [, entry] of this.reviews) {
      if (!entry.abortController.signal.aborted) {
        entry.abortController.abort(reason);
      }
    }
    this.reviews.clear();
  }

  /**
   * Test / introspection helper. Upstream keeps `state: Arc<Mutex<…>>`
   * private; gut exposes a snapshot for coverage assertions without
   * letting callers mutate the registry.
   */
  snapshot(): ReadonlyArray<{ readonly subId: string; readonly request: ReviewRequest }> {
    return Array.from(this.reviews.values()).map((entry) => ({
      subId: entry.subId,
      request: entry.request,
    }));
  }

  /**
   * Current number of tracked reviews. Upstream
   * `state.trunk.is_some() + state.ephemeral_reviews.len()`.
   */
  get size(): number {
    return this.reviews.size;
  }

  /**
   * Upstream agenc runtime `guardian/review_session.rs::run_review` orchestrator
   * (the on-session wrapper that threads timeout + fork snapshot +
   * delta prompt logic around the child-session delegate). AgenC port
   * wraps the T13 delegate with:
   *
   *   - an optional caller-supplied timeout, with no implicit deadline,
   *   - an `AbortController` that fires on an explicit timeout OR on
   *     the caller's own abort signal,
   *   - registration in the manager registry for session-wide
   *     shutdown,
   *   - an `exit_review_mode` event on every termination path
   *     (emitted by the delegate) so consumers do not need to route
   *     around the manager.
   *
   * The delegate itself (`runAgenCReviewOneShot`) handles the actual review
   * provider call + `exit_review_mode` emission; `runReview` is the
   * manager-level wrapper that adds bookkeeping + abort merging.
   */
  async runReview(
    session: AgenCDelegateSessionLike,
    req: AgenCReviewOneShotRequest,
  ): Promise<AgenCReviewOneShotOutcome> {
    // Build the controller the manager owns so `shutdown()` + an
    // explicit timeout can both fire it without fighting the caller's own
    // signal. The delegate also accepts a `signal` through
    // `req.signal`; we merge by letting the caller's original
    // `req.signal` cascade here, then pass the merged controller's
    // signal to the delegate.
    const managerController = new AbortController();
    const callerSignal = req.signal;
    let callerAbortListener: (() => void) | undefined;
    if (callerSignal) {
      if (callerSignal.aborted) {
        managerController.abort(callerSignal.reason);
      } else {
        callerAbortListener = () => {
          managerController.abort(callerSignal.reason);
        };
        callerSignal.addEventListener("abort", callerAbortListener, {
          once: true,
        });
      }
    }

    // Register the review so session-level shutdown can cancel it.
    // The abort controller is the manager-owned one so `shutdown` /
    // `take` routes abort through the same surface the delegate
    // listens on.
    this.register({
      subId: req.subId,
      abortController: managerController,
      request: req.request,
    });

    const startedAt = Date.now();
    const prepared = this.prepareSnapshotReuse(req);
    const modelUsed =
      prepared.request.reviewerModel ??
      prepared.request.parentContext.modelInfo.slug;
    session.sendEvent(req.subId, {
      type: "review_delegate_started",
      payload: {
        subId: req.subId,
        target: req.request.target,
        modelUsed,
        ...(explicitReviewReuseKey(req) !== undefined
          ? { reuseKey: explicitReviewReuseKey(req) }
          : {}),
        snapshot_reused: prepared.snapshotReused,
        priorFindingCount: prepared.priorFindingCount,
        startedAt,
      },
    });

    // Lazy-import the delegate to sidestep the circular-dep risk
    // (review.ts <-> agenc-delegate.ts). Only the types were
    // imported at the module head.
    const { runAgenCReviewOneShot } = await import("./agenc-delegate.js");

    try {
      const outcome = await runAgenCReviewOneShot(session, {
        ...prepared.request,
        signal: managerController.signal,
      });
      this.recordSnapshot(prepared.request, outcome);
      this.emitReviewDelegateCompleted(session, {
        req,
        modelUsed: outcome.modelUsed,
        startedAt,
        snapshotReused: prepared.snapshotReused,
        priorFindingCount: prepared.priorFindingCount,
        newFindingCount: outcome.output.findings.length,
        verdict: outcome.verdict,
        reason: completionReasonFromVerdict(outcome.verdict),
      });
      return outcome;
    } catch (err) {
      this.emitReviewDelegateCompleted(session, {
        req,
        modelUsed,
        startedAt,
        snapshotReused: prepared.snapshotReused,
        priorFindingCount: prepared.priorFindingCount,
        newFindingCount: 0,
        verdict: "fail",
        reason: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      // Remove the listener even on success paths so the caller's
      // AbortController doesn't keep a reference to us.
      if (callerSignal && callerAbortListener !== undefined) {
        callerSignal.removeEventListener("abort", callerAbortListener);
      }
      this.take(req.subId);
    }
  }

  private prepareSnapshotReuse(
    req: AgenCReviewOneShotRequest,
  ): PreparedReviewRequest {
    const key = reviewSnapshotKey(req);
    if (key === null) {
      return {
        request: req,
        snapshotReused: false,
        priorFindingCount: 0,
      };
    }
    const snapshot = this.snapshots.get(key);
    if (snapshot === undefined) {
      return {
        request: req,
        snapshotReused: false,
        priorFindingCount: 0,
      };
    }

    const deltaPrompt: LLMMessage = {
      role: "user",
      content: [
        "A previous review snapshot is available in this child delegate's history.",
        "Reuse prior findings where still valid, and focus this review on changes or new evidence in the latest request.",
        `Previous finding count: ${snapshot.findingCount}`,
        snapshot.overallExplanation.trim().length > 0
          ? `Previous overall explanation: ${snapshot.overallExplanation}`
          : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
    };

    return {
      request: {
        ...req,
        ...(explicitReviewReuseKey(req) !== undefined
          ? { reuseKey: explicitReviewReuseKey(req) }
          : {}),
        initialHistory: snapshot.history,
        input: [deltaPrompt, ...req.input],
      },
      snapshotReused: true,
      priorFindingCount: snapshot.findingCount,
    };
  }

  private recordSnapshot(
    req: AgenCReviewOneShotRequest,
    outcome: AgenCReviewOneShotOutcome,
  ): void {
    const key = reviewSnapshotKey(req);
    if (key === null || outcome.rawText === null) return;
    this.snapshots.set(key, {
      history: [
        ...(req.initialHistory ?? []),
        ...req.input,
        { role: "assistant" as const, content: outcome.rawText },
      ].slice(-12),
      findingCount: outcome.output.findings.length,
      overallExplanation: outcome.output.overallExplanation,
    });
  }

  private emitReviewDelegateCompleted(
    session: AgenCDelegateSessionLike,
    opts: {
      readonly req: AgenCReviewOneShotRequest;
      readonly modelUsed: string;
      readonly startedAt: number;
      readonly snapshotReused: boolean;
      readonly priorFindingCount: number;
      readonly newFindingCount: number;
      readonly verdict: AgenCReviewOneShotOutcome["verdict"];
      readonly reason: ReviewDelegateCompletionReason;
      readonly error?: string;
    },
  ): void {
    const completedAt = Date.now();
    const reuseKey = explicitReviewReuseKey(opts.req);
    session.sendEvent(opts.req.subId, {
      type: "review_delegate_completed",
      payload: {
        subId: opts.req.subId,
        target: opts.req.request.target,
        modelUsed: opts.modelUsed,
        ...(reuseKey !== undefined ? { reuseKey } : {}),
        snapshot_reused: opts.snapshotReused,
        priorFindingCount: opts.priorFindingCount,
        newFindingCount: opts.newFindingCount,
        durationMs: Math.max(0, completedAt - opts.startedAt),
        verdict: opts.verdict,
        reason: opts.reason,
        completedAt,
        ...(opts.error !== undefined ? { error: opts.error } : {}),
      },
    });
  }
}

interface PreparedReviewRequest {
  readonly request: AgenCReviewOneShotRequest;
  readonly snapshotReused: boolean;
  readonly priorFindingCount: number;
}

interface ReviewConversationSnapshot {
  readonly history: ReadonlyArray<LLMMessage>;
  readonly findingCount: number;
  readonly overallExplanation: string;
}

function reviewSnapshotKey(req: AgenCReviewOneShotRequest): string | null {
  if (req.reuseKey === false || req.registerTask === false) return null;
  if (typeof req.reuseKey === "string" && req.reuseKey.trim().length > 0) {
    return req.reuseKey.trim();
  }
  return [
    req.request.target,
    req.reviewerModel ?? req.parentContext.modelInfo.slug,
    req.config.cwd,
  ].join("\u0000");
}

function explicitReviewReuseKey(
  req: AgenCReviewOneShotRequest,
): string | undefined {
  return typeof req.reuseKey === "string" && req.reuseKey.trim().length > 0
    ? req.reuseKey.trim()
    : undefined;
}

function completionReasonFromVerdict(
  verdict: AgenCReviewOneShotOutcome["verdict"],
): ReviewDelegateCompletionReason {
  if (verdict === "timeout") return "timeout";
  if (verdict === "aborted") return "aborted";
  return "completed";
}

function llmMessageText(message: LLMMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        const text = (part as { readonly text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function priorFindingCountFromHistory(
  history: ReadonlyArray<LLMMessage> | undefined,
): number {
  if (history === undefined) return 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message?.role !== "assistant") continue;
    return parseReviewOutput(llmMessageText(message)).findings.length;
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────
// spawnReviewTask entry point
// ─────────────────────────────────────────────────────────────────────

/**
 * Options for `spawnReviewTask`. Mirrors the upstream
 * `spawn_review_thread` task-registration shape.
 */
export interface SpawnReviewTaskOptions {
  /** Upstream `sub_id`. Identifier the session uses in its task registry. */
  readonly subId: string;
  /** Upstream `resolved: ResolvedReviewRequest`. The reviewer's target + hint. */
  readonly request: ReviewRequest;
  /** Review-scoped config. Defaults to `parentContext.config` when omitted. */
  readonly config?: AgenCReviewOneShotRequest["config"];
  /**
   * Parent turn context used to synthesize the review-scoped child
   * turn. Defaults to `session.newDefaultTurnWithSubId(...)` when the
   * live Session method is available.
   */
  readonly parentContext?: AgenCReviewOneShotRequest["parentContext"];
  /**
   * Model-visible review prompt. Defaults to a compact prompt rendered
   * from `request` so `spawnReviewTask` can be used directly by slash
   * command callers.
   */
  readonly input?: ReadonlyArray<LLMMessage>;
  readonly reviewerModel?: AgenCReviewOneShotRequest["reviewerModel"];
  readonly reviewerModelInfo?: AgenCReviewOneShotRequest["reviewerModelInfo"];
  readonly finalOutputJsonSchema?: AgenCReviewOneShotRequest["finalOutputJsonSchema"];
  readonly timeoutMs?: AgenCReviewOneShotRequest["timeoutMs"];
  readonly systemPrompt?: AgenCReviewOneShotRequest["systemPrompt"];
  readonly initialHistory?: AgenCReviewOneShotRequest["initialHistory"];
  readonly reuseKey?: AgenCReviewOneShotRequest["reuseKey"];
  /** Optional pre-allocated controller so tests can observe abort. */
  readonly abortController?: AbortController;
  /** Optional started-at override for telemetry determinism. */
  readonly startedAtMs?: number;
  /**
   * Optional manager override. When omitted, no registration happens —
   * callers without a manager still get a live review RunningTask so
   * they can observe its lifecycle directly.
   */
  readonly manager?: ReviewManager;
}

/**
 * Result of `spawnReviewTask`. A thin pass-through of the task the
 * session registered, plus the review-scoped request for UI surfacing.
 */
export interface SpawnedReviewTask {
  readonly subId: string;
  readonly kind: "review";
  readonly abortController: AbortController;
  readonly done: Promise<void>;
  readonly outcome: Promise<AgenCReviewOneShotOutcome | null>;
  readonly request: ReviewRequest;
}

/**
 * Upstream agenc runtime `session/review.rs::spawn_review_thread` entry point.
 * Registers a `kind: "review"` task, then starts the full isolated
 * AgenC child-session reviewer driver. The returned `done` promise
 * resolves only after the reviewer finishes and the parent task slot is
 * drained, matching upstream `ReviewTask::run -> on_task_finished`.
 *
 * The returned `SpawnedReviewTask` carries the task's abort controller
 * so callers can cancel the review directly (`spawnedTask.abortController.abort(...)`)
 * or through `session.abortAllTasks("review_ended")`.
 */
export async function spawnReviewTask(
  session: SessionLike,
  opts: SpawnReviewTaskOptions,
): Promise<SpawnedReviewTask> {
  const abortController = opts.abortController ?? new AbortController();
  const parentContext = resolveSpawnReviewParentContext(session, opts);
  const config = opts.config ?? parentContext.config;
  const input = opts.input ?? renderReviewTaskInput(opts.request);
  const request: AgenCReviewOneShotRequest = {
    subId: opts.subId,
    config,
    parentContext,
    input,
    request: opts.request,
    signal: abortController.signal,
    registerTask: false,
    recordExitRollout: true,
    ...(opts.reviewerModel !== undefined
      ? { reviewerModel: opts.reviewerModel }
      : {}),
    ...(opts.reviewerModelInfo !== undefined
      ? { reviewerModelInfo: opts.reviewerModelInfo }
      : {}),
    ...(opts.finalOutputJsonSchema !== undefined
      ? { finalOutputJsonSchema: opts.finalOutputJsonSchema }
      : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
    ...(opts.initialHistory !== undefined
      ? { initialHistory: opts.initialHistory }
      : {}),
    ...(opts.reuseKey !== undefined ? { reuseKey: opts.reuseKey } : {}),
  };
  const reviewTask = new ReviewSessionTask(session, request, opts.manager);
  if (opts.manager !== undefined) {
    opts.manager.register({
      subId: opts.subId,
      abortController,
      request: opts.request,
    });
  }
  const task = await session.spawnTask({
    subId: opts.subId,
    kind: "review",
    task: reviewTask,
    turnContext: parentContext,
    abortController,
    startedAtMs: opts.startedAtMs,
  });
  if (task.kind !== "review") {
    // Defensive: upstream agenc runtime `spawn_task` never rewrites the kind,
    // but the JS surface is structural, so surface a clear contract
    // violation instead of silently proceeding.
    throw new Error(
      `spawnReviewTask: session.spawnTask returned unexpected kind=${task.kind}`,
    );
  }
  session.sendEvent(task.subId, {
    type: "entered_review_mode",
    payload: opts.request,
  });
  const outcome = (task.handle ??
    Promise.resolve(null)) as Promise<AgenCReviewOneShotOutcome | null>;
  return {
    subId: task.subId,
    kind: "review",
    abortController: task.abortController,
    done: task.done,
    outcome,
    request: opts.request,
  };
}

class ReviewSessionTask implements SessionTask {
  constructor(
    private readonly session: SessionLike,
    private readonly request: AgenCReviewOneShotRequest,
    private readonly manager: ReviewManager | undefined,
  ) {}

  kind(): "review" {
    return "review";
  }

  spanName(): string {
    return "session_task.review";
  }

  async run(
    _ctx: SessionTaskRunContext,
  ): Promise<AgenCReviewOneShotOutcome | null> {
    return await runSpawnedReviewTask(
      this.session,
      this.request.subId,
      this.request,
      this.manager,
    );
  }

  async abort(_ctx: SessionTaskAbortContext): Promise<void> {
    this.manager?.take(this.request.subId);
  }
}

function resolveSpawnReviewParentContext(
  session: SessionLike,
  opts: SpawnReviewTaskOptions,
): AgenCReviewOneShotRequest["parentContext"] {
  if (opts.parentContext !== undefined) return opts.parentContext;
  if (typeof session.newDefaultTurnWithSubId === "function") {
    return session.newDefaultTurnWithSubId(`${opts.subId}-parent`);
  }
  throw new Error(
    "spawnReviewTask requires parentContext when the session cannot create a default turn context",
  );
}

function renderReviewTaskInput(request: ReviewRequest): ReadonlyArray<LLMMessage> {
  return [
    {
      role: "user",
      content: [
        "Please review the requested target.",
        `Target: ${request.target}`,
        request.userFacingHint !== undefined && request.userFacingHint.trim().length > 0
          ? `Hint: ${request.userFacingHint}`
          : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
    },
  ];
}

async function runSpawnedReviewTask(
  session: SessionLike,
  subId: string,
  req: AgenCReviewOneShotRequest,
  manager: ReviewManager | undefined,
): Promise<AgenCReviewOneShotOutcome | null> {
  const startedAt = Date.now();
  const modelUsed = req.reviewerModel ?? req.parentContext.modelInfo.slug;
  const explicitReuseKey = explicitReviewReuseKey(req);
  const priorFindingCount = priorFindingCountFromHistory(req.initialHistory);
  const snapshotReused = (req.initialHistory?.length ?? 0) > 0;
  session.sendEvent(subId, {
    type: "review_delegate_started",
    payload: {
      subId,
      target: req.request.target,
      modelUsed,
      ...(explicitReuseKey !== undefined ? { reuseKey: explicitReuseKey } : {}),
      snapshot_reused: snapshotReused,
      priorFindingCount,
      startedAt,
    },
  });
  try {
    const { runAgenCReviewOneShot } = await import("./agenc-delegate.js");
    const outcome = await runAgenCReviewOneShot(session, req);
    const completedAt = Date.now();
    session.sendEvent(subId, {
      type: "review_delegate_completed",
      payload: {
        subId,
        target: req.request.target,
        modelUsed: outcome.modelUsed,
        ...(explicitReuseKey !== undefined ? { reuseKey: explicitReuseKey } : {}),
        snapshot_reused: snapshotReused,
        priorFindingCount,
        newFindingCount: outcome.output.findings.length,
        durationMs: Math.max(0, completedAt - startedAt),
        verdict: outcome.verdict,
        reason: completionReasonFromVerdict(outcome.verdict),
        completedAt,
        ...(outcome.error !== null ? { error: outcome.error.message } : {}),
      },
    });
    return outcome;
  } catch (err) {
    const completedAt = Date.now();
    session.sendEvent(subId, {
      type: "review_delegate_completed",
      payload: {
        subId,
        target: req.request.target,
        modelUsed,
        ...(explicitReuseKey !== undefined ? { reuseKey: explicitReuseKey } : {}),
        snapshot_reused: snapshotReused,
        priorFindingCount,
        newFindingCount: 0,
        durationMs: Math.max(0, completedAt - startedAt),
        verdict: "fail",
        reason: "error",
        completedAt,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    const exitPayload: ExitReviewModePayload = {
      subId,
      reason: "aborted",
      reviewOutput: emptyReviewOutput(),
      modelUsed,
      request: req.request,
    };
    if (req.recordExitRollout ?? req.registerTask !== false) {
      await recordReviewExitRollout(session, exitPayload);
    }
    session.sendEvent(subId, {
      type: "exit_review_mode",
      payload: exitPayload,
    });
    session.sendEvent(subId, {
      type: "error",
      payload: {
        cause: "review_task_failed",
        message: err instanceof Error ? err.message : String(err),
        turnId: subId,
        ...(err instanceof Error && err.stack !== undefined
          ? { stack: err.stack }
          : {}),
      },
    });
    return null;
  } finally {
    manager?.take(subId);
  }
}
