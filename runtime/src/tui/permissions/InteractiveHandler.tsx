/**
 * Wave 5-A: InteractiveHandler — orchestrates a single pending permission
 * request through the 200 ms classifier grace window, the I-44 stale-turn
 * drop, and finally the {@link ApprovalOverlay} modal.
 *
 * Lifecycle (mount effect):
 *
 *   1. I-44 stale-drop. If `request.turnId !== session.activeTurn.turnId`,
 *      the modal never mounts. We emit `warning:stale_pending_dropped`
 *      via `session.emit?.(...)` when available, then call
 *      `request.resolveOnce.claim({behavior: 'deny', source: 'stale_pending_dropped'})`.
 *
 *   2. 200 ms classifier grace race. We call `classifyYoloAction` and
 *      race it against a 200 ms timer. If the classifier returns a
 *      deterministic allow within the window
 *      (`shouldBlock === false && !unavailable`), we auto-approve,
 *      emit `warning:classifier_auto_approved`, and resolve with
 *      `{behavior: 'allow'}`. Otherwise — timeout, unavailable, or
 *      block — we fall through to the modal.
 *
 *      Note: T11's stub classifier returns `{shouldBlock:false, unavailable:true}`
 *      instantly, which means the current behavior is "always show the
 *      modal". T13 will replace the stub with a real xAI call and the
 *      auto-approve path will start firing.
 *
 *      Classifier errors are caught and treated as `unavailable: true`
 *      so a thrown classifier can never silently auto-approve a
 *      dangerous action; the modal always takes over on error.
 *
 *   3. Modal mount. We push an {@link ApprovalOverlay} onto the overlay
 *      stack, wiring `onResolve` to:
 *        - pop the overlay,
 *        - persist the session rule if `allow-session` + `addRule`,
 *        - call `request.resolveOnce.claim(decision)`.
 *
 *   4. Unmount cleanup. If the handler unmounts with an unresolved
 *      request (operator closed the UI abruptly), we claim `abort`
 *      so the evaluator's awaiter doesn't deadlock.
 *
 * The core decision logic is also exported as {@link resolveWithGrace}
 * so tests can exercise the race and I-44 paths without mounting React.
 *
 * @module
 */

import React, { useEffect, useRef, type ReactNode } from "react";

import {
  ApprovalOverlay,
  type ApprovalDecision,
} from "./ApprovalOverlay.js";
import {
  classifyYoloAction,
  type YoloClassifierResult,
} from "../../permissions/classifier.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "../../permissions/types.js";

// ───────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────

/**
 * Minimal session surface consumed by the handler. Real runtime sessions
 * (and the T11 evaluator's session abstraction) are larger than this; we
 * only ask for the fields we actually read so tests can supply light
 * fixtures.
 */
export interface SessionLike {
  readonly activeTurn?: {
    unsafePeek(): { readonly turnId: string } | null;
  } | null;
  readonly abortController?: { readonly signal: AbortSignal };
  readonly cwd?: string;
  readonly emit?: (event: { readonly kind: string; [k: string]: unknown }) => void;
  readonly addPermissionRule?: (rule: unknown) => void;
  /**
   * Optional permission-context getter used when invoking the classifier.
   * Defaults to a minimal stand-in when absent.
   */
  readonly getToolPermissionContext?: () => ToolPermissionContext;
}

/**
 * Handler-side resolve slot. T11's `createResolveOnce` is a different
 * shape (its `claim()` takes no arguments and it owns the resolve
 * callback internally). InteractiveHandler wants a "claim this decision
 * once" primitive so the orchestrator can convert a user decision into a
 * ReviewDecision downstream of the UI — hence this narrower contract.
 *
 * `claim(payload)` returns true iff this caller was the first to mark
 * the slot; subsequent callers get `false` and the payload is dropped.
 */
export interface InteractiveResolver {
  claim(payload: ResolverPayload): boolean;
  isResolved(): boolean;
}

/**
 * Decision payload handed to {@link InteractiveResolver.claim}. This is
 * the narrower UI-side union; the runtime converts this to a
 * `ReviewDecision` / `PermissionDecision` at the evaluator boundary.
 */
export type ResolverPayload =
  | { readonly behavior: "allow"; readonly source?: string }
  | {
      readonly behavior: "allow-session";
      readonly addRule?: boolean;
      readonly source?: string;
    }
  | { readonly behavior: "deny"; readonly source?: string }
  | { readonly behavior: "abort"; readonly source?: string };

/**
 * Pending permission request as seen by the interactive UI layer.
 * Structurally compatible with T11's `PendingPermissionRequest`
 * (requestId, toolName, toolInput, turnId) plus the UI-side
 * {@link InteractiveResolver}. Keeping this type local to the TUI
 * layer avoids backfitting T11's frozen context module.
 */
export interface InteractivePermissionRequest {
  readonly requestId: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly turnId: string;
  readonly message?: string;
  readonly reason?: string;
  readonly resolveOnce: InteractiveResolver;
}

export interface OverlayContextLike {
  /** Pushes a React node onto the stack. Returns a disposer. */
  push(node: ReactNode): () => void;
}

export interface InteractiveHandlerProps {
  readonly request: InteractivePermissionRequest;
  readonly session: SessionLike;
  readonly overlayContext: OverlayContextLike;
  /** Override for the grace window length. Defaults to 200 ms. */
  readonly graceMs?: number;
}

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

const DEFAULT_GRACE_MS = 200;

/**
 * Minimal permission context used when the session doesn't provide one.
 * The stub classifier ignores it entirely; real classifiers (T13) must
 * receive the live context from the session.
 */
function defaultToolPermissionContext(): ToolPermissionContext {
  return createEmptyToolPermissionContext();
}

/**
 * Async helper: races the grace timer against the classifier call.
 * Returns `"timeout"` when the timer wins, otherwise the classifier
 * result. Any thrown error is normalized into an `unavailable: true`
 * record so a classifier crash can never silently auto-approve.
 */
function raceClassifierAgainstGrace(
  request: InteractivePermissionRequest,
  session: SessionLike,
  graceMs: number,
): Promise<YoloClassifierResult | "timeout"> {
  const signal = session.abortController?.signal;

  // Build a classifier promise that never rejects. Errors (including
  // synchronous throws from a test mock) become a sentinel
  // `unavailable: true` so the orchestrator falls through to the modal.
  const classifierPromise: Promise<YoloClassifierResult> = (async () => {
    try {
      return await classifyYoloAction({
        messages: [],
        action: {
          toolName: request.toolName,
          input: request.toolInput,
        },
        tools: [],
        permissionContext: session.getToolPermissionContext
          ? session.getToolPermissionContext()
          : defaultToolPermissionContext(),
        signal,
      });
    } catch {
      return {
        shouldBlock: true,
        reason: "classifier_error",
        unavailable: true,
        model: "error",
        usage: null,
        durationMs: 0,
        stage: "fast" as const,
      };
    }
  })();

  // Unref the timer so it doesn't keep an event loop alive in tests
  // using real timers.
  const timeoutPromise: Promise<"timeout"> = new Promise((resolve) => {
    const handle = setTimeout(() => resolve("timeout"), graceMs);
    if (typeof (handle as unknown as { unref?: () => void }).unref === "function") {
      (handle as unknown as { unref: () => void }).unref();
    }
  });

  return Promise.race([classifierPromise, timeoutPromise]);
}

// ───────────────────────────────────────────────────────────────────────
// resolveWithGrace — exported for tests
// ───────────────────────────────────────────────────────────────────────

export type ResolveWithGraceOutcome =
  | { readonly bypassedModal: true; readonly reason: string }
  | { readonly bypassedModal: false };

/**
 * Pure variant of the handler's pre-modal phase. Exercises the I-44
 * check and the 200 ms classifier race without touching React or the
 * overlay stack. If the classifier auto-approves inside the grace
 * window, the request is resolved here; otherwise the caller should
 * mount the modal.
 *
 * Never mounts UI. Never throws.
 */
export async function resolveWithGrace(
  request: InteractivePermissionRequest,
  session: SessionLike,
  opts?: { readonly graceMs?: number },
): Promise<ResolveWithGraceOutcome> {
  const graceMs = opts?.graceMs ?? DEFAULT_GRACE_MS;

  // ── I-44 stale-turn drop ────────────────────────────────────────────
  const currentTurnId = session.activeTurn?.unsafePeek()?.turnId;
  if (
    typeof currentTurnId === "string" &&
    currentTurnId.length > 0 &&
    currentTurnId !== request.turnId
  ) {
    if (request.resolveOnce.claim({
      behavior: "deny",
      source: "stale_pending_dropped",
    })) {
      session.emit?.({
        kind: "warning:stale_pending_dropped",
        requestId: request.requestId,
        toolName: request.toolName,
        expectedTurnId: request.turnId,
        actualTurnId: currentTurnId,
      });
    }
    return { bypassedModal: true, reason: "stale_pending_dropped" };
  }

  // ── 200 ms classifier grace race ────────────────────────────────────
  const raced = await raceClassifierAgainstGrace(request, session, graceMs);

  if (raced === "timeout") {
    return { bypassedModal: false };
  }

  if (!raced.shouldBlock && raced.unavailable !== true) {
    if (request.resolveOnce.claim({
      behavior: "allow",
      source: "classifier_auto_approved",
    })) {
      session.emit?.({
        kind: "warning:classifier_auto_approved",
        requestId: request.requestId,
        toolName: request.toolName,
        model: raced.model,
      });
    }
    return { bypassedModal: true, reason: "classifier_auto_approved" };
  }

  // shouldBlock / unavailable → ask the user.
  return { bypassedModal: false };
}

// ───────────────────────────────────────────────────────────────────────
// InteractiveHandler
// ───────────────────────────────────────────────────────────────────────

export const InteractiveHandler: React.FC<InteractiveHandlerProps> = ({
  request,
  session,
  overlayContext,
  graceMs = DEFAULT_GRACE_MS,
}) => {
  // Track the overlay disposer so unmount can pop the modal if still
  // visible. Also record the cancellation flag for an in-flight grace
  // race so an unmount before modal push doesn't leak an overlay.
  const disposeRef = useRef<(() => void) | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    // Run the pre-modal phase asynchronously. This effect deliberately
    // returns the sync cleanup function below; the async body captures
    // `cancelledRef` to detect unmount between phases.
    void (async () => {
      const outcome = await resolveWithGrace(request, session, { graceMs });
      if (cancelledRef.current) return;
      if (outcome.bypassedModal) return;

      // Mount the approval modal and wire resolution back through the
      // request's resolve slot.
      const abortSignal =
        session.abortController?.signal ?? new AbortController().signal;
      const workspacePath = session.cwd ?? "";

      const handleResolve = (decision: ApprovalDecision): void => {
        // Pop the overlay first so the UI is gone before any downstream
        // observers see the decision fire.
        if (disposeRef.current) {
          try {
            disposeRef.current();
          } finally {
            disposeRef.current = null;
          }
        }

        if (
          decision.behavior === "allow-session" &&
          decision.addRule === true
        ) {
          try {
            session.addPermissionRule?.({
              toolName: request.toolName,
              requestId: request.requestId,
            });
          } catch {
            // Rule persistence failures must never block claiming the
            // decision. Higher layers are responsible for their own
            // failure reporting.
          }
        }

        request.resolveOnce.claim({
          behavior: decision.behavior,
          addRule: decision.addRule,
          source: "user",
        } as ResolverPayload);
      };

      disposeRef.current = overlayContext.push(
        <ApprovalOverlay
          request={{
            tool: request.toolName,
            args: (request.toolInput ?? {}) as Record<string, unknown>,
            workspacePath,
            reason: request.reason ?? request.message,
            turnId: request.turnId,
          }}
          onResolve={handleResolve}
          abortSignal={abortSignal}
        />,
      );
    })();

    return () => {
      // Unmount path. Mark the async race as cancelled and tear down
      // any mounted overlay. If the request is still unresolved, claim
      // `abort` so evaluator awaiters unstick.
      cancelledRef.current = true;
      if (disposeRef.current) {
        try {
          disposeRef.current();
        } catch {
          // Ignore disposer errors during unmount; nothing we can do.
        }
        disposeRef.current = null;
      }
      if (!request.resolveOnce.isResolved()) {
        request.resolveOnce.claim({
          behavior: "abort",
          source: "component_unmounted",
        });
      }
    };
    // `request` and `session` are treated as stable for the lifetime of a
    // single mount — the orchestrator spawns a fresh handler per pending
    // request. Re-running the effect on identity changes would replay
    // the grace race and double-prompt the operator.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // InteractiveHandler renders nothing itself; all visual output flows
  // through the overlay stack. Returning `null` keeps the tree flat.
  return null;
};

export default InteractiveHandler;
