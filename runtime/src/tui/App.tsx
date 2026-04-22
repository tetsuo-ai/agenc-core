/**
 * AgenC TUI root React component.
 *
 * T12 closure: this module replaces the placeholder `[transcript]` /
 * `[composer]` slots with the real, production-wired composition:
 *
 *     <AgenCAppStateProvider>
 *       <KeybindingProvider bindings={...}>
 *         <OverlayProvider>
 *           <TUIRoot />
 *         </OverlayProvider>
 *       </KeybindingProvider>
 *     </AgenCAppStateProvider>
 *
 * `TUIRoot` itself now mounts:
 *   - <Banner> — cockpit status row (mode/model/phase/plan/streaming).
 *   - <MessageList> — transcript derived from `useQuery`'s PhaseEvent
 *     stream through the `eventsToMessages` adapter.
 *   - <Composer> — multi-line prompt input; submit calls
 *     `session.submit?.(...)` when available, cancel calls
 *     `session.abortTerminal?.('user_cancel')`.
 *   - One <InteractiveHandler> per live pending permission request —
 *     these are invisible orchestrators; the visible overlay is
 *     pushed onto the overlay stack from inside the handler.
 *   - The overlay stack itself, rendered after the main column so
 *     modals (approval dialog, etc.) layer on top in document order
 *     (Ink has no true absolute positioning).
 *
 * The real `KeybindingProvider` ships in
 * `runtime/src/tui/keybindings/KeybindingContext.tsx`; the passthrough
 * stub that used to live in `state/AppState.tsx` is retained only as a
 * deprecated alias for legacy imports.
 */

import React, {
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import Box from "./ink/components/Box.js";
import StdinContext from "./ink/components/StdinContext.js";

import {
  AgenCAppStateProvider,
  useAgenCAppState,
  type ConfigStoreLike,
  type SessionLike as AppStateSessionLike,
} from "./state/AppState.js";
import { KeybindingProvider } from "./keybindings/KeybindingContext.js";
import type {
  BindingContext,
  BindingMap,
} from "./keybindings/defaultBindings.js";
import { OverlayProvider, useOverlayStack } from "./overlay/OverlayProvider.js";
import { Banner } from "./cockpit/Banner.js";
import { MessageList } from "./transcript/MessageList.js";
import { Composer, type ComposerSession } from "./composer/Composer.js";
import {
  InteractiveHandler,
  type InteractivePermissionRequest,
  type InteractiveResolver,
  type OverlayContextLike,
} from "./permissions/InteractiveHandler.js";
import { useQuery, type SessionLike as QuerySessionLike } from "./hooks/useQuery.js";
import { eventsToMessages } from "./state/events-to-messages.js";
import { isPlanActive, type PlanEvent } from "./state/plan-state.js";
import type { PendingPermissionRequest } from "../permissions/context.js";

// ────────────────────────────────────────────────────────────────────────
// Public surface
// ────────────────────────────────────────────────────────────────────────

/**
 * Structural type for the `<App>` `session` prop.
 *
 * The three nested consumers (`useQuery`, `InteractiveHandler`,
 * `AgenCAppStateProvider`) each declare their own `SessionLike` with
 * slightly different required/optional shapes for `activeTurn`. The
 * widened `AppStateSessionLike` from `state/AppState.tsx` already
 * declares every hook-only field as optional, which matches
 * `InteractiveHandler`'s expectations and is structurally compatible
 * with `useQuery` as long as the runtime actually wires those fields
 * (the real Session class does; test stubs forward what they need).
 *
 * Rather than force every test stub to declare a non-null `activeTurn`
 * and a required `abortTerminal`, App.tsx narrow-casts to the
 * stricter `useQuery` shape at its single use site. `AppSessionLike`
 * stays the widened alias so consumers like `main.tsx`'s
 * `StdinLossSession` keep passing verbatim.
 */
export type AppSessionLike = AppStateSessionLike;

export interface AppProps {
  readonly session: AppSessionLike;
  readonly configStore: ConfigStoreLike;
  /** Optional binding overrides. Forwarded to the real KeybindingProvider. */
  readonly bindings?: Record<BindingContext, BindingMap>;
  /** Model label shown in the cockpit banner. */
  readonly model?: string;
  /** Optional boot-time prompt forwarded from the CLI TTY router. */
  readonly initialPrompt?: string;
}

// ────────────────────────────────────────────────────────────────────────
// Adapters — wrap the structural `PendingPermissionRequest` in the
// `InteractiveResolver` contract that `<InteractiveHandler>` consumes.
// ────────────────────────────────────────────────────────────────────────

/**
 * Shape we expect on a `PendingPermissionRequest` once the evaluator is
 * wired. The evaluator attaches a `resolveOnce` slot so the TUI can
 * deliver the user's decision back to the awaiter. The shape is checked
 * at runtime because T11's frozen `PendingPermissionRequest` interface
 * does not yet declare the slot.
 */
interface EvaluatorLinkedRequest extends PendingPermissionRequest {
  readonly resolveOnce?: InteractiveResolver;
}

/**
 * Runtime gate for approval requests. Requests without a live
 * `resolveOnce` slot must not render a dead overlay: there is nobody to
 * receive the user's decision, so the safest behavior is to drop the
 * request + emit a warning.
 */
function hasInteractiveResolver(
  request: EvaluatorLinkedRequest,
): request is PendingPermissionRequest & { readonly resolveOnce: InteractiveResolver } {
  return (
    request.resolveOnce !== undefined &&
    typeof request.resolveOnce.claim === "function" &&
    typeof request.resolveOnce.isResolved === "function"
  );
}

function emitSessionWarning(
  session: AppSessionLike,
  cause: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  const nextInternalSubId =
    typeof session.nextInternalSubId === "function"
      ? session.nextInternalSubId.bind(session)
      : null;
  if (typeof session.emit !== "function" || nextInternalSubId === null) {
    session.emit?.({
      kind: `warning:${cause}`,
      cause,
      message,
      ...extra,
    });
    return;
  }
  session.emit({
    id: nextInternalSubId(),
    msg: {
      type: "warning",
      payload: {
        cause,
        message,
        ...extra,
      },
    },
  });
}

function toHandlerRequest(
  request: PendingPermissionRequest & {
    readonly resolveOnce: InteractiveResolver;
  },
): InteractivePermissionRequest {
  return {
    requestId: request.requestId,
    toolName: request.toolName,
    toolInput: request.toolInput,
    turnId: request.turnId,
    message: request.message,
    resolveOnce: request.resolveOnce,
  };
}

// ────────────────────────────────────────────────────────────────────────
// TUIRoot — the real composition
// ────────────────────────────────────────────────────────────────────────

function TUIRoot({
  model,
  initialPrompt,
}: {
  readonly model?: string;
  readonly initialPrompt?: string;
}): React.ReactElement {
  const { mode, session, pendingRequests, permissionQueueOps } = useAgenCAppState();
  // The AppState-side `SessionLike` is intentionally permissive (every
  // hook-only field is optional) so tests can pass a tiny stub. useQuery
  // wants `activeTurn` and `abortTerminal` as required fields; we cast
  // here because the runtime contract (either the real Session or a
  // test stub that implements useQuery's surface) is responsible for
  // providing them. When they're missing, useQuery's internal
  // `warnOnce` path no-ops gracefully.
  const { events, isStreaming, submit } = useQuery(
    session as unknown as QuerySessionLike,
  );
  const initialPromptSubmittedRef = useRef(false);
  const overlay = useOverlayStack();

  // Derive transcript messages from phase events on every render. The
  // adapter is pure and cheap, so useMemo's only job here is to keep
  // referential identity stable for MessageList's sticky-scroll
  // bookkeeping.
  const messages = useMemo(() => eventsToMessages(events), [events]);

  // Plan events live on the broader EventMsg stream, not PhaseEvent. The
  // session will surface them through a parallel subscription once T13
  // lands; for now we filter defensively so a future addition to
  // PhaseEvent picks up automatically.
  const planEvents = useMemo<readonly PlanEvent[]>(() => {
    const out: PlanEvent[] = [];
    for (const ev of events as readonly { readonly type?: unknown }[]) {
      const type = (ev as { readonly type?: unknown }).type;
      if (typeof type !== "string" || !type.startsWith("plan_")) continue;
      // Translate event-log style `{type, payload}` rows into the
      // PlanEvent-side `{kind, ...}` shape. Missing payloads leave the
      // event on the cutting-room floor.
      const payload = (ev as { readonly payload?: unknown }).payload;
      if (payload && typeof payload === "object") {
        out.push({ kind: type, ...(payload as object) } as PlanEvent);
      }
    }
    return out;
  }, [events]);
  const hasPlanActive = isPlanActive(planEvents);

  // Overlay context adapter. `InteractiveHandler` wants a minimal
  // `push(node) => dispose` surface; the OverlayProvider exposes
  // `pushOverlay(node) => id` + `popOverlay(id)`. Wrapping once here
  // keeps the contract narrow for the handler.
  const overlayAdapter = useMemo<OverlayContextLike>(
    () => ({
      push: (node: ReactNode) => {
        const id = overlay.pushOverlay(node);
        return () => overlay.popOverlay(id);
      },
    }),
    [overlay],
  );

  // Build the Composer session adapter from whatever the caller passed.
  // Composer needs `cwd` + optional `home`; the wider Session shape
  // provides both when they're set. We fall back to `process.cwd()` so
  // mention validation has something deterministic to work with.
  const composerSession = useMemo<ComposerSession>(
    () => ({
      cwd:
        typeof session.cwd === "string" && session.cwd.length > 0
          ? session.cwd
          : process.cwd(),
      home:
        typeof (session as { readonly home?: unknown }).home === "string"
          ? ((session as { readonly home?: string }).home as string)
          : undefined,
    }),
    [session],
  );

  const validPendingRequests = useMemo(
    () => pendingRequests.filter(hasInteractiveResolver),
    [pendingRequests],
  );

  useEffect(() => {
    for (const request of pendingRequests) {
      if (hasInteractiveResolver(request as EvaluatorLinkedRequest)) continue;
      permissionQueueOps.remove(request.requestId);
      emitSessionWarning(
        session,
        "approval_resolver_missing",
        `dropped approval request ${request.requestId} because no live resolver was attached`,
        {
          requestId: request.requestId,
          toolName: request.toolName,
          turnId: request.turnId,
        },
      );
    }
  }, [pendingRequests, permissionQueueOps, session]);

  // Mount one InteractiveHandler per pending request. Each handler
  // owns its own lifecycle (grace race → overlay push → resolve), so
  // a render pass with N pending items gives us N orchestrators.
  const permissionHandlers = validPendingRequests.map((req) => (
    <InteractiveHandler
      key={req.requestId}
      request={toHandlerRequest(req)}
      session={session}
      overlayContext={overlayAdapter}
    />
  ));

  const handleSubmit = (text: string): void => {
    // `useQuery.submit` is a terminal-safe wrapper that logs if the
    // underlying session doesn't expose a submit hook; dropped input
    // is an observability signal, not a crash.
    void submit(text).catch(() => {
      // Submit failures surface through the session emit channel in
      // real runs; swallow here so a rejected promise doesn't become
      // an unhandled promise rejection in the Ink scheduler.
    });
  };

  const handleCancel = (): void => {
    try {
      session.abortTerminal?.("user_cancel");
    } catch {
      // abortTerminal is best-effort; the composer already cleared
      // its local buffer before calling us.
    }
  };

  useEffect(() => {
    if (initialPromptSubmittedRef.current) return;
    if (typeof initialPrompt !== "string" || initialPrompt.length === 0) {
      return;
    }
    initialPromptSubmittedRef.current = true;
    void submit(initialPrompt).catch(() => {
      // Submit failures already surface through session-side logging.
    });
  }, [initialPrompt, submit]);

  return (
    <Box flexDirection="column">
      {/* cockpit region (top) */}
      <Box flexDirection="column">
        <Banner
          mode={mode}
          model={model}
          isStreaming={isStreaming}
          hasPlanActive={hasPlanActive}
        />
      </Box>

      {/* transcript region (middle, flex:1) */}
      <Box flexDirection="column" flexGrow={1}>
        <MessageList messages={messages} isStreaming={isStreaming} />
      </Box>

      {/* composer region (bottom) */}
      <Box flexDirection="column">
        <Composer
          session={composerSession}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
        />
      </Box>

      {/* invisible orchestrators — one per pending permission request */}
      {permissionHandlers}

      {/* overlay stack rendered after the main column so modals appear
          last in document order (Ink has no absolute positioning) */}
      {overlay.overlays.map((entry) => (
        <OverlayFrame key={entry.id}>{entry.node}</OverlayFrame>
      ))}
    </Box>
  );
}

function OverlayFrame({ children }: { readonly children: ReactNode }) {
  return <Box flexDirection="column">{children}</Box>;
}

// ────────────────────────────────────────────────────────────────────────
// App provider stack
// ────────────────────────────────────────────────────────────────────────

/**
 * Tiny adapter component: reads Ink's `StdinContext` (provided by the
 * Ink root) and forwards its `internal_eventEmitter` to the AgenC
 * `KeybindingProvider` so keypresses flow into the binding registry in
 * production. When the Ink root isn't present (default context value),
 * the default context's `internal_eventEmitter` is still a valid
 * `EventEmitter` — it just never emits — so the provider safely
 * no-ops until a real Ink root mounts above.
 */
function KeybindingsFromStdin({
  bindings,
  children,
}: {
  readonly bindings?: Record<BindingContext, BindingMap>;
  readonly children: ReactNode;
}): React.ReactElement {
  const stdinCtx = useContext(StdinContext);
  const emitter = stdinCtx.internal_eventEmitter;
  return (
    <KeybindingProvider
      {...(bindings ? { bindings } : {})}
      stdinContext={{ internal_eventEmitter: emitter }}
    >
      {children}
    </KeybindingProvider>
  );
}

export const App: React.FC<AppProps> = ({
  session,
  configStore,
  bindings,
  model,
  initialPrompt,
}) => {
  return (
    <AgenCAppStateProvider session={session} configStore={configStore}>
      <KeybindingsFromStdin {...(bindings ? { bindings } : {})}>
        <OverlayProvider>
          <TUIRoot model={model} initialPrompt={initialPrompt} />
        </OverlayProvider>
      </KeybindingsFromStdin>
    </AgenCAppStateProvider>
  );
};

export default App;

// Re-exported so tests that want to poke at the placeholder renderer
// (or extend it with extra decorations like an ArtPanel) have a clean
// import path.
export { TUIRoot };

/**
 * The remaining evaluator-side work is limited to producing queued
 * requests with a live `resolveOnce: InteractiveResolver`. The TUI now
 * consumes those requests directly, rejects resolver-less entries
 * safely, and already consumes `plan_*` entries from `session.eventLog`
 * via `useQuery`.
 */
