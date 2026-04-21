/**
 * Wave 5-A: InteractiveHandler — orchestrates a single pending permission
 * request through the I-44 stale-turn drop and finally the
 * {@link ApprovalOverlay} modal.
 *
 * Lifecycle (mount effect):
 *
 *   1. I-44 stale-drop. If `request.turnId !== session.activeTurn.turnId`,
 *      the modal never mounts. We emit `warning:stale_pending_dropped`
 *      via `session.emit?.(...)` when available, then call
 *      `request.resolveOnce.claim({behavior: 'deny', source: 'stale_pending_dropped'})`.
 *
 *   2. Modal mount. We push an {@link ApprovalOverlay} onto the overlay
 *      stack, wiring `onResolve` to:
 *        - pop the overlay,
 *        - persist the session rule if `allow-session` + `addRule`,
 *        - call `request.resolveOnce.claim(decision)`.
 *
 *   3. Unmount cleanup. If the handler unmounts with an unresolved
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
import { useOptionalAgenCAppState } from "../state/AppState.js";

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

// ───────────────────────────────────────────────────────────────────────
// resolveWithGrace — exported for tests
// ───────────────────────────────────────────────────────────────────────

export type ResolveWithGraceOutcome =
  | { readonly bypassedModal: true; readonly reason: string }
  | { readonly bypassedModal: false };

/**
 * Pure variant of the handler's pre-modal phase. Exercises only the I-44
 * stale-turn drop. Pending permission requests are already evaluator-owned;
 * the TUI never reclassifies them.
 *
 * Never mounts UI. Never throws.
 */
export async function resolveWithGrace(
  request: InteractivePermissionRequest,
  session: SessionLike,
  _opts?: { readonly graceMs?: number },
): Promise<ResolveWithGraceOutcome> {
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
  const appState = useOptionalAgenCAppState();
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
      if (outcome.bypassedModal) {
        appState?.permissionQueueOps.remove(request.requestId);
        return;
      }

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

        appState?.permissionQueueOps.remove(request.requestId);

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
            requestId: request.requestId,
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
      appState?.permissionQueueOps.remove(request.requestId);
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
