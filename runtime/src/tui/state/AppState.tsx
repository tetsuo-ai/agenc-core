/**
 * AgenC TUI app state context.
 *
 * Exposes the subset of session state the TUI needs to render and
 * react to lifecycle events: current permission mode, streaming flag,
 * and the live pending-permission queue that the evaluator pushes into.
 *
 * Tests feed in a minimal stub that only implements
 * `services.permissionModeRegistry` (see `SessionLike` below); the real
 * {@link Session} class satisfies it automatically.
 *
 * Pending-permission queue ownership
 * ----------------------------------
 * T11 ships `PermissionQueueOps` (runtime/src/permissions/context.ts)
 * as a tiny push/remove/update surface. The queue items themselves
 * are meant to live in whatever store the TUI or daemon provides.
 * T12 owns the TUI-side store: `AgenCAppStateProvider` holds an array
 * of `PendingPermissionRequest` in React state and exposes
 * `permissionQueueOps` so the evaluator (wired in T12b/T13) can push
 * new items from anywhere without importing React. The provider also
 * accepts an optional `permissionQueueOpsRef` prop so callers that
 * construct the ops outside of React (e.g. the daemon bridge) can
 * receive the live ops handle without a ref plumbing dance.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { PermissionMode } from "../../permissions/types.js";
import type { PhaseEvent } from "../../phases/events.js";
import type {
  Event,
  EventMsg,
  PlanApprovalOutcome,
} from "../../session/event-log.js";
import type { AgenCConfig } from "../../config/index.js";
import type { ReviewDecision } from "../../permissions/review-decision.js";
import {
  createPermissionQueueOps,
  type PendingPermissionRequest,
  type PermissionQueueOps,
} from "../../permissions/context.js";
import type { ApprovalResolver } from "../_deps/orchestrator-types.js";

/**
 * Minimum shape the TUI cares about from the runtime session. Using a
 * structural type here lets tests pass a tiny stub that only implements
 * `services.permissionModeRegistry` without having to fabricate a full
 * `Session`.
 */
export interface PermissionModeRegistryLike {
  current(): { readonly mode: PermissionMode };
  subscribeToModeChange(
    cb: (next: PermissionMode, previous: PermissionMode) => void,
  ): () => void;
}

/**
 * Minimum session surface the AgenC TUI consumes. Widened in T12 to
 * include the optional event-stream hooks that `useQuery` +
 * `InteractiveHandler` consume so App.tsx can forward a single
 * `session` prop through the full tree without per-consumer casts.
 *
 * Every field below is optional except `services.permissionModeRegistry`,
 * which is the only field this provider actually reads. Consumers
 * further down the tree tolerate `undefined` on their own fields (e.g.
 * `useQuery.submit` warns once when missing rather than throwing).
 */
export interface SessionLike {
  readonly services: {
    readonly permissionModeRegistry: PermissionModeRegistryLike;
  };
  /**
   * Optional pre-built queue ops handle. When the daemon/runtime
   * constructs the ops externally (so non-React callers can push into
   * the queue without reaching into the provider), it can pass the
   * handle through here. Wave 2 leaves it optional — the provider
   * falls back to owning the ops itself when the session doesn't
   * carry one.
   */
  readonly permissionQueueOps?: PermissionQueueOps;
  /** Active turn slot consumed by `useQuery` and `InteractiveHandler`. */
  readonly activeTurn?: {
    unsafePeek(): { readonly turnId: string } | null;
  } | null;
  /** AbortController surfaced by `InteractiveHandler.resolveWithGrace`. */
  readonly abortController?: { readonly signal: AbortSignal };
  /** Working directory — Composer reads this for mention validation. */
  readonly cwd?: string;
  /** Home directory — Composer falls back to `process.env.HOME` if absent. */
  readonly home?: string;
  /** Live session config snapshot used by slash palette provider/model discovery. */
  readonly sessionConfiguration?: {
    readonly provider?: { readonly slug?: string };
    readonly collaborationMode?: { readonly model?: string };
  };
  /** Session-owned event emission path used by the TUI warning flow. */
  readonly emit?: (event: Event | { readonly kind: string; readonly [key: string]: unknown }) => void;
  /** Event id allocator for session-owned warning/event envelopes. */
  nextInternalSubId?(): string;
  /** Optional permission rule persistence hook. */
  readonly addPermissionRule?: (rule: unknown) => void;
  /** Optional tool-permission-context getter used by the classifier. */
  readonly getToolPermissionContext?: () => import("../../permissions/types.js").ToolPermissionContext;
  /** Optional event-stream subscription used by `useQuery`. */
  subscribeToEvents?(cb: (event: PhaseEvent) => void): () => void;
  /** Optional submit hook driven from the Composer. */
  submit?(message: string): Promise<void>;
  /** Turn-local interrupt hook used by Ctrl+C / Esc while a turn is active. */
  abortTurnIfActive?(
    turnId: string,
    reason: "interrupted",
  ): Promise<boolean> | boolean;
  /** Required by `useQuery`. `InteractiveHandler` calls it on cancel. */
  abortTerminal?(reason: string): void;
}

/**
 * Matching minimum for the config store. Wave 2 only needs a read-only
 * handle; future waves will add listeners when they wire config-reload
 * UX.
 */
export interface ConfigStoreLike {
  readonly snapshot?: unknown;
  current?(): AgenCConfig;
}

type InteractiveResolverPayload =
  | { readonly behavior: "allow"; readonly source?: string }
  | {
      readonly behavior: "allow-session";
      readonly addRule?: boolean;
      readonly source?: string;
    }
  | { readonly behavior: "deny"; readonly source?: string }
  | { readonly behavior: "abort"; readonly source?: string };

interface InteractiveResolverLike {
  claim(payload: InteractiveResolverPayload): boolean;
  isResolved(): boolean;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function deriveApprovalToolInput(ctx: {
  readonly invocation?: { readonly payload?: unknown };
}): unknown {
  const payload = (
    ctx.invocation?.payload ?? null
  ) as
    | {
        readonly kind?: string;
        readonly arguments?: string;
        readonly rawArguments?: string;
        readonly input?: string;
        readonly params?: Record<string, unknown>;
      }
    | null;
  if (!payload || typeof payload.kind !== "string") return {};
  switch (payload.kind) {
    case "function":
      return parseJsonObject(payload.arguments ?? "");
    case "mcp":
      return parseJsonObject(payload.rawArguments ?? "");
    case "custom":
      return { input: payload.input ?? "" };
    case "tool_search":
      return payload.arguments ?? {};
    case "local_shell":
      return payload.params ?? {};
    default:
      return {};
  }
}

function isExitPlanTool(toolName: string): boolean {
  return toolName === "ExitPlanMode";
}

function planApprovalStats(input: unknown): {
  readonly planFilePath?: string;
  readonly planLengthChars: number;
  readonly allowedPromptCount: number;
} {
  const record =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const plan = typeof record.plan === "string" ? record.plan : "";
  const planFilePath =
    typeof record.planFilePath === "string" ? record.planFilePath : undefined;
  const allowedPromptCount = Array.isArray(record.allowedPrompts)
    ? record.allowedPrompts.length
    : 0;
  return {
    ...(planFilePath !== undefined ? { planFilePath } : {}),
    planLengthChars: plan.length,
    allowedPromptCount,
  };
}

function reviewOutcome(decision: ReviewDecision): PlanApprovalOutcome {
  switch (decision.kind) {
    case "approved":
      return "approved";
    case "approved_for_session":
    case "approved_execpolicy_amendment":
    case "network_policy_amendment":
      return decision.kind === "network_policy_amendment" &&
        decision.amendment.action === "deny"
        ? "denied"
        : "approved_for_session";
    case "denied":
    case "timed_out":
      return "denied";
    case "abort":
      return "aborted";
  }
}

function emitSessionTelemetry(
  session: SessionLike,
  msg: EventMsg,
): void {
  if (typeof session.emit !== "function") return;
  const id =
    typeof session.nextInternalSubId === "function"
      ? session.nextInternalSubId()
      : `tui-${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;
  session.emit({ id, msg });
}

function reviewDecisionFromPayload(
  payload: InteractiveResolverPayload,
): ReviewDecision {
  switch (payload.behavior) {
    case "allow":
      return { kind: "approved" };
    case "allow-session":
      return { kind: "approved_for_session" };
    case "deny":
      return { kind: "denied" };
    case "abort":
      return { kind: "abort" };
  }
}

function createTuiApprovalResolver(
  queueOps: PermissionQueueOps,
  session: SessionLike,
): ApprovalResolver {
  return {
    request(ctx) {
      return new Promise<ReviewDecision>((resolve) => {
        const requestId = ctx.callId;
        let settled = false;
        const submittedAt = Date.now();
        const toolInput = deriveApprovalToolInput(ctx);
        const planStats = planApprovalStats(toolInput);
        const isPlanApproval = isExitPlanTool(ctx.toolName);

        if (isPlanApproval) {
          emitSessionTelemetry(session, {
            type: "plan_approval_requested",
            payload: {
              requestId,
              turnId: ctx.turnId,
              ...planStats,
              requestedAt: submittedAt,
            },
          });
        }

        const cleanupAbort = (): void => {
          ctx.signal?.removeEventListener("abort", onAbort);
        };

        const settle = (
          decision: ReviewDecision,
          opts: { readonly removeFromQueue?: boolean } = {},
        ): boolean => {
          if (settled) return false;
          settled = true;
          cleanupAbort();
          if (opts.removeFromQueue === true) {
            queueOps.remove(requestId);
          }
          if (isPlanApproval) {
            const completedAt = Date.now();
            emitSessionTelemetry(session, {
              type: "plan_approval_completed",
              payload: {
                requestId,
                turnId: ctx.turnId,
                ...planStats,
                outcome: reviewOutcome(decision),
                durationMs: completedAt - submittedAt,
                completedAt,
              },
            });
          }
          resolve(decision);
          return true;
        };

        const onAbort = (): void => {
          settle({ kind: "abort" }, { removeFromQueue: true });
        };

        if (ctx.signal?.aborted) {
          settle({ kind: "abort" });
          return;
        }

        const resolveOnce: InteractiveResolverLike = {
          claim(payload) {
            return settle(reviewDecisionFromPayload(payload));
          },
          isResolved() {
            return settled;
          },
        };

        queueOps.push({
          requestId,
          toolName: ctx.toolName,
          toolInput,
          message: `Permission required to use ${ctx.toolName}`,
          submittedAt,
          turnId: ctx.turnId,
          resolveOnce,
        } as PendingPermissionRequest);

        ctx.signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

export interface AgenCAppStateValue {
  readonly mode: PermissionMode;
  readonly session: SessionLike;
  readonly configStore: ConfigStoreLike;
  readonly isStreaming: boolean;
  /**
   * Active model slug surfaced to the status bar. Mirrors AgenC's
   * `useAppState(s => s.mainLoopModel)` (`hooks/useMainLoopModel.ts:14`).
   * Updated by the `/model` slash command via `setModel` so the status
   * bar refreshes synchronously rather than waiting for the next turn's
   * `consumePendingProviderSwitch` to land the authoritative value.
   */
  readonly model: string | undefined;
  /** Full live permission queue in FIFO order. */
  readonly permissionQueue: readonly PendingPermissionRequest[];
  /** Live queue of pending permission requests awaiting operator review. */
  readonly pendingRequests: readonly PendingPermissionRequest[];
  /** Request id currently surfaced to the approval UI, if any. */
  readonly activePermissionRequestId: string | null;
  /** Total queued permission requests, including the active one. */
  readonly queuedPermissionCount: number;
  /** Bump `isStreaming` on so the composer/status footer tracks active turns. */
  setStreaming: (next: boolean) => void;
  /**
   * Update the visible model slug (status bar). Slash-command path uses
   * this for synchronous parity with AgenC `setAppState({...prev,
   * mainLoopModel: model})` at `commands/model/model.tsx:59-63`.
   */
  setModel: (next: string) => void;
  /**
   * Queue ops exposed so non-React callers (evaluator, daemon bridge,
   * tests) can push pending requests without going through React
   * state setters directly. Always bound to the React-owned queue.
   */
  readonly permissionQueueOps: PermissionQueueOps;
}

const AgenCAppStateContext = createContext<AgenCAppStateValue | null>(null);

export interface AgenCAppStateProviderProps {
  readonly session: SessionLike;
  readonly configStore: ConfigStoreLike;
  readonly children: ReactNode;
}

export function AgenCAppStateProvider({
  session,
  configStore,
  children,
}: AgenCAppStateProviderProps): React.ReactElement {
  // Seed from whatever the registry reports right now so the very first
  // render already shows the correct mode indicator instead of flashing
  // the "default" mode for a frame.
  const [mode, setMode] = useState<PermissionMode>(
    () => session.services.permissionModeRegistry.current().mode,
  );
  // Seed from the session's collaboration-mode model slug so the very
  // first render already has the right value; `/model` then overwrites
  // it synchronously (no waiting for the next turn-bound consume).
  const [model, setModel] = useState<string | undefined>(() => {
    const sc = (session as unknown as {
      sessionConfiguration?: { collaborationMode?: { model?: string } };
    }).sessionConfiguration;
    return sc?.collaborationMode?.model;
  });
  const [isStreaming, setStreaming] = useState<boolean>(false);
  const [permissionQueue, setPermissionQueue] = useState<
    readonly PendingPermissionRequest[]
  >([]);

  useEffect(() => {
    const registry = session.services.permissionModeRegistry;
    // Pick up whatever the registry thinks is current right now, in
    // case the session rotated modes between construction and mount.
    setMode(registry.current().mode);
    const unsubscribe = registry.subscribeToModeChange((next) => {
      setMode(next);
    });
    return () => {
      unsubscribe();
    };
  }, [session]);

  // Build the queue ops once per provider lifetime. The setter updater
  // signature matches what `createPermissionQueueOps` expects — it
  // always gets a fresh immutable array back.
  //
  // We pin the ops behind a ref so non-React callers that captured the
  // handle early still interact with the live provider state, not a
  // stale closure from the first render.
  const opsRef = useRef<PermissionQueueOps | null>(null);
  if (opsRef.current === null) {
    opsRef.current = createPermissionQueueOps((updater) => {
      setPermissionQueue((prev) => updater(prev));
    });
  }

  const exposedOps = opsRef.current;

  const pendingRequests = useMemo<readonly PendingPermissionRequest[]>(
    () => (permissionQueue.length > 0 ? [permissionQueue[0]!] : []),
    [permissionQueue],
  );
  const activePermissionRequestId = pendingRequests[0]?.requestId ?? null;

  const memoSetStreaming = useCallback((next: boolean) => {
    setStreaming(next);
  }, []);
  const memoSetModel = useCallback((next: string) => {
    setModel(next);
  }, []);

  useEffect(() => {
    // The live evaluator/runtime bridge needs a session-level handle it
    // can push into without importing React. Publish the provider-owned
    // ops onto the session for the lifetime of this mount so every
    // external push lands back in the React queue the TUI renders.
    const sessionWithQueueOps = session as SessionLike & {
      services: SessionLike["services"] & {
        approvalResolver?: ApprovalResolver;
      };
      permissionQueueOps?: PermissionQueueOps;
      appStateBridge?: { setModel?: (next: string) => void };
    };
    const previous = sessionWithQueueOps.permissionQueueOps;
    const previousApprovalResolver =
      sessionWithQueueOps.services.approvalResolver;
    const previousBridge = sessionWithQueueOps.appStateBridge;
    sessionWithQueueOps.permissionQueueOps = exposedOps;
    sessionWithQueueOps.services.approvalResolver =
      createTuiApprovalResolver(exposedOps, session);
    // Publish the React-side setters so non-React callers (the slash
    // dispatcher in `bin/agenc.ts`) can refresh AppState synchronously
    // — mirrors AgenC's `setAppState({...prev, mainLoopModel})`
    // pattern adapted to AgenC's session-as-bridge convention.
    sessionWithQueueOps.appStateBridge = { setModel: memoSetModel };
    return () => {
      if (sessionWithQueueOps.permissionQueueOps === exposedOps) {
        sessionWithQueueOps.permissionQueueOps = previous;
      }
      if (
        sessionWithQueueOps.services.approvalResolver !==
        previousApprovalResolver
      ) {
        sessionWithQueueOps.services.approvalResolver =
          previousApprovalResolver;
      }
      sessionWithQueueOps.appStateBridge = previousBridge;
    };
  }, [session, exposedOps, memoSetModel]);

  const value = useMemo<AgenCAppStateValue>(
    () => ({
      mode,
      session,
      configStore,
      isStreaming,
      model,
      permissionQueue,
      pendingRequests,
      activePermissionRequestId,
      queuedPermissionCount: permissionQueue.length,
      setStreaming: memoSetStreaming,
      setModel: memoSetModel,
      permissionQueueOps: exposedOps,
    }),
    [
      mode,
      session,
      configStore,
      isStreaming,
      model,
      permissionQueue,
      pendingRequests,
      activePermissionRequestId,
      memoSetStreaming,
      memoSetModel,
      exposedOps,
    ],
  );

  return (
    <AgenCAppStateContext.Provider value={value}>
      {children}
    </AgenCAppStateContext.Provider>
  );
}

/**
 * Read the current AgenC TUI app state. Throws when called outside the
 * provider so consumer bugs surface early.
 */
export function useAgenCAppState(): AgenCAppStateValue {
  const ctx = useContext(AgenCAppStateContext);
  if (ctx === null) {
    throw new Error(
      "useAgenCAppState must be used inside <AgenCAppStateProvider>",
    );
  }
  return ctx;
}

/**
 * Optional variant for leaf components that can render outside the app-state
 * provider in focused unit tests.
 */
export function useOptionalAgenCAppState(): AgenCAppStateValue | null {
  return useContext(AgenCAppStateContext);
}

/**
 * Legacy pass-through. App.tsx historically imported `KeybindingProvider`
 * from this module while Wave 2-B's real provider was still landing. The
 * real provider now ships in
 * `runtime/src/tui/keybindings/KeybindingContext.tsx`; this alias stays
 * only so any older test import keeps working. App.tsx imports the
 * real one directly.
 *
 * @deprecated Import {@link
 * ../keybindings/KeybindingContext.js#KeybindingProvider} instead.
 */
export interface KeybindingProviderProps {
  readonly bindings: unknown;
  readonly children: ReactNode;
}

export const KeybindingProvider: React.FC<KeybindingProviderProps> = ({
  children,
}) => {
  return <>{children}</>;
};
