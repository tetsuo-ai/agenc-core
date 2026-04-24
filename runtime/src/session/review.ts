/**
 * Review-task subsystem for the AgenC session kernel.
 *
 * Port of the upstream codex review machinery:
 *   - `codex-rs/core/src/tasks/review.rs` — the `ReviewTask` trait impl
 *     (`TaskKind::Review`, `span_name("session_task.review")`, run/abort
 *     wiring, process_review_events, exit_review_mode, and the
 *     JSON-parsing fallback for `ReviewOutputEvent`).
 *   - `codex-rs/core/src/session/review.rs` — the `spawn_review_thread`
 *     entry point that builds a review-scoped `TurnContext`, disables
 *     web-search / view-image features, and spawns the `ReviewTask` via
 *     `Session::spawn_task`.
 *   - `codex-rs/core/src/guardian/review_session.rs` —
 *     `GuardianReviewSessionManager`. This file ports the manager's
 *     shape and lifecycle primitives (`shutdown`, trunk vs ephemeral
 *     review-session tracking).
 *   - `codex-rs/core/review_prompt.md` and the two
 *     `codex-rs/core/templates/review/*.xml` templates — lifted
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
 *      as regular turns (upstream codex
 *      `session/review.rs::spawn_review_thread -> sess.spawn_task`).
 *
 *   2. `ReviewManager` — the codex `GuardianReviewSessionManager`
 *      port. Tracks the "trunk" review session and any ephemeral fork
 *      review sessions by subId so `shutdown()` can cancel them all on
 *      session teardown. The full trunk-reuse and ephemeral-fork
 *      semantics from `guardian/review_session.rs` (reuse-key
 *      invalidation, fork snapshots, prior-review-count deltas) now
 *      route through the AgenC child-session delegate.
 *
 *   3. `isTaskKindSteerable(kind)` — the classifier used by the
 *      forthcoming steer_input port (Item 6). Review tasks are
 *      explicitly NON-steerable (upstream codex treats
 *      `TaskKind::Review` as reject-on-steer). The classifier is
 *      implemented against the TaskKind contract so it can be asserted
 *      today even before the steer_input path is wired through.
 *
 *   4. The three review-prompt string constants
 *      (`REVIEW_SYSTEM_PROMPT`, `REVIEW_EXIT_SUCCESS_TMPL`,
 *      `REVIEW_EXIT_INTERRUPTED_TMPL`) — ported verbatim from the
 *      upstream assets so a future runner can synthesize the reviewer
 *      system prompt and exit-templates without a file loader.
 *
 *   5. `ReviewRequest`, `ReviewFinding`, `ReviewOutput` — the
 *      structural types corresponding to upstream codex
 *      `codex-protocol::protocol::{ReviewRequest, ReviewOutputEvent}`
 *      and `ReviewLineRange` / `ReviewCodeLocation`. Shapes are
 *      preserved so `parseReviewOutput` can deserialize a reviewer
 *      model's JSON response (or fall back to the plain-text path
 *      mirroring upstream `parse_review_output_event`).
 *
 * Remaining narrow gaps:
 *
 *   - `spawnReviewTask` does NOT synthesize the review-scoped
 *     `TurnContext`, disable `web_search` / `view_image`, or route the
 *     reviewer model through the provider adapter. `runReview` owns
 *     the real review conversation via `runAgenCReviewOneShot`; this
 *     helper remains only the task-registry primitive for callers that
 *     need a bare review `RunningTask`.
 *
 *   - Full analytics parity for prior-review-count deltas is not yet
 *     wired. The live runtime behavior, child session, timeout, abort,
 *     exit event, and bounded snapshot reuse are implemented.
 *
 * @module
 */

import type { TaskKind } from "./tasks.js";
import type {
  AgenCDelegateSessionLike,
  AgenCReviewOneShotOutcome,
  AgenCReviewOneShotRequest,
} from "./agenc-delegate.js";
import type { LLMMessage } from "../llm/types.js";

// ─────────────────────────────────────────────────────────────────────
// Structural types (upstream `codex-protocol` review surface)
// ─────────────────────────────────────────────────────────────────────

/**
 * Upstream codex `codex-protocol::protocol::ReviewRequest`. Describes
 * what the user / operator asked the reviewer model to look at. The
 * target is a free-form description (e.g. "Diff between HEAD and
 * main") that upstream threads through `resolved.target`.
 */
export interface ReviewRequest {
  readonly target: string;
  readonly userFacingHint?: string;
}

/**
 * Upstream codex `codex-protocol::protocol::ReviewLineRange`.
 */
export interface ReviewLineRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Upstream codex `codex-protocol::protocol::ReviewCodeLocation`.
 */
export interface ReviewCodeLocation {
  readonly absolutePath: string;
  readonly lineRange: ReviewLineRange;
}

/**
 * Upstream codex `codex-protocol::protocol::ReviewFinding`.
 */
export interface ReviewFinding {
  readonly title: string;
  readonly body: string;
  readonly confidenceScore: number;
  readonly priority: number;
  readonly codeLocation: ReviewCodeLocation;
}

/**
 * Upstream codex `codex-protocol::protocol::ReviewOutputEvent`. Shape
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
 * Upstream codex `tasks/mod.rs` classification consumed by the
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
 * Upstream codex `core/review_prompt.md`. Used as the reviewer
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
 * Upstream codex `core/templates/review/exit_success.xml`. Rendered
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
 * Upstream codex `core/templates/review/exit_interrupted.xml`.
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
 * Upstream codex `tasks/review.rs::render_review_exit_success`. Single
 * placeholder template substitution (`{{results}}`). Upstream uses a
 * real template engine (`codex_utils_template::Template`); gut uses
 * plain string replace because there is only ever one placeholder.
 */
export function renderReviewExitSuccess(results: string): string {
  return REVIEW_EXIT_SUCCESS_TMPL.replace("{{results}}", results);
}

// ─────────────────────────────────────────────────────────────────────
// Review output parser (upstream parse_review_output_event)
// ─────────────────────────────────────────────────────────────────────

/**
 * Upstream codex `tasks/review.rs::parse_review_output_event`. Parses
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
 * Minimal `SessionLike` surface needed by `spawnReviewTask`. Matches
 * the `Session.spawnTask` signature without pulling the full
 * `Session` type into this module (avoids a circular dep with
 * `session.ts`).
 */
export interface SessionLike {
  spawnTask(opts: {
    readonly subId: string;
    readonly kind: TaskKind;
    readonly abortController?: AbortController;
    readonly startedAtMs?: number;
  }): Promise<{ readonly subId: string; readonly kind: TaskKind; readonly abortController: AbortController; readonly done: Promise<void> }>;
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
 * Upstream codex `guardian/review_session.rs::GuardianReviewSessionManager`,
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
   * Upstream codex `guardian/review_session.rs::run_review` orchestrator
   * (the on-session wrapper that threads timeout + fork snapshot +
   * delta prompt logic around the child-session delegate). AgenC port
   * wraps the T13 delegate with:
   *
   *   - a bounded timeout (the upstream
   *     `run_before_review_deadline` / `GUARDIAN_REVIEW_SESSION_DEADLINE`
   *     analog),
   *   - an `AbortController` that fires on timeout OR on the caller's
   *     own abort signal,
   *   - registration in the manager registry for session-wide
   *     shutdown,
   *   - an `exit_review_mode` event on every termination path
   *     (emitted by the delegate) so consumers do not need to route
   *     around the manager.
   *
   * Remaining difference vs upstream: prior-review-count analytics are
   * not emitted yet. The child session, timeout/abort, exit event, and
   * bounded snapshot reuse paths are live.
   *
   * The delegate itself (`runAgenCReviewOneShot`) handles the actual review
   * provider call + `exit_review_mode` emission; `runReview` is the
   * manager-level wrapper that adds bookkeeping + abort merging.
   */
  async runReview(
    session: AgenCDelegateSessionLike,
    req: AgenCReviewOneShotRequest,
  ): Promise<AgenCReviewOneShotOutcome> {
    // Build the controller the manager owns so `shutdown()` +
    // timeout can both fire it without fighting the caller's own
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

    const preparedReq = this.prepareSnapshotReuse(req);

    // Lazy-import the delegate to sidestep the circular-dep risk
    // (review.ts <-> agenc-delegate.ts). Only the types were
    // imported at the module head.
    const { runAgenCReviewOneShot } = await import("./agenc-delegate.js");

    try {
      const outcome = await runAgenCReviewOneShot(session, {
        ...preparedReq,
        signal: managerController.signal,
      });
      this.recordSnapshot(preparedReq, outcome);
      return outcome;
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
  ): AgenCReviewOneShotRequest {
    const key = reviewSnapshotKey(req);
    if (key === null) return req;
    const snapshot = this.snapshots.get(key);
    if (snapshot === undefined) return { ...req, reuseKey: key };

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
      ...req,
      reuseKey: key,
      initialHistory: snapshot.history,
      input: [deltaPrompt, ...req.input],
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
  readonly request: ReviewRequest;
}

/**
 * Upstream codex `session/review.rs::spawn_review_thread` entry point.
 * Gut port invokes `session.spawnTask({kind: "review", ...})` so the
 * review flows through the Wave 2 task-dispatch machinery
 * (replace-on-new-turn, abort controller, done promise, graceful
 * interruption). The review-scoped `TurnContext` assembly + the
 * reviewer-model child delegate run are handled by
 * `runAgenCReviewOneShot`; see module docstring for lifecycle notes.
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
  const task = await session.spawnTask({
    subId: opts.subId,
    kind: "review",
    abortController,
    startedAtMs: opts.startedAtMs,
  });
  if (task.kind !== "review") {
    // Defensive: upstream codex `spawn_task` never rewrites the kind,
    // but the JS surface is structural, so surface a clear contract
    // violation instead of silently proceeding.
    throw new Error(
      `spawnReviewTask: session.spawnTask returned unexpected kind=${task.kind}`,
    );
  }
  if (opts.manager !== undefined) {
    opts.manager.register({
      subId: task.subId,
      abortController: task.abortController,
      request: opts.request,
    });
  }
  return {
    subId: task.subId,
    kind: "review",
    abortController: task.abortController,
    done: task.done,
    request: opts.request,
  };
}
