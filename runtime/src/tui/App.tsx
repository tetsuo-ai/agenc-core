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
 *   - <MessageList> — AgenC-style semantic transcript rows derived
 *     from `useQuery`'s PhaseEvent stream through the `eventsToMessages`
 *     adapter.
 *   - <Composer> — multi-line prompt input; submit calls
 *     `session.submit?.(...)` when available, cancel calls
 *     the turn-local `session.abortTurnIfActive?.(..., 'interrupted')`
 *     path when a turn is active.
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
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import Box from "./ink/components/Box.js";
import Text from "./ink/components/Text.js";
import { AlternateScreen } from "./ink/components/AlternateScreen.js";
import StdinContext from "./ink/components/StdinContext.js";
import { isMouseTrackingEnabled } from "./ink/vendored/fullscreen.js";

import {
  AgenCAppStateProvider,
  useAgenCAppState,
  type ConfigStoreLike,
  type SessionLike as AppStateSessionLike,
} from "./state/AppState.js";
import {
  KeybindingProvider,
  useKeybinding,
  useSetKeybindingContext,
} from "./keybindings/KeybindingContext.js";
import type {
  BindingContext,
  BindingMap,
} from "./keybindings/defaultBindings.js";
import {
  loadUserBindingsSync,
  watchUserBindings,
} from "./keybindings/loadUserBindings.js";
import { getDisplayForCommand } from "./keybindings/shortcutFormat.js";
import { OverlayProvider, useOverlayStack } from "./overlay/OverlayProvider.js";
import { TasksPanel } from "./components/TasksPanel.js";
import { LiveAgentStatusPanel } from "./components/LiveAgentStatusPanel.js";
import type { TaskStoreOptions } from "../bin/task-store.js";
import {
  DEFAULT_STATUS_LINE_ITEMS,
  StatusLineConfig,
} from "./cockpit/StatusLineConfig.js";
import {
  readRuntimeStatusNoticeWarnings,
  StatusNotices,
} from "./cockpit/StatusNotices.js";
import { MessageList } from "./transcript/MessageList.js";
import {
  Composer,
  type ComposerSession,
} from "./composer/Composer.js";
import { QueuedCommands } from "./composer/QueuedCommands.js";
import {
  InteractiveHandler,
  type InteractivePermissionRequest,
  type InteractiveResolver,
  type OverlayContextLike,
} from "./permissions/InteractiveHandler.js";
import { useQuery, type SessionLike as QuerySessionLike } from "./hooks/useQuery.js";
import {
  eventsToMessages,
} from "./state/events-to-messages.js";
import { readPickerCommandIntent } from "./picker-intents.js";
import { usePickerController } from "./picker-controller.js";
import { useTuiConfigView } from "./config-view.js";
import { useTerminalSize } from "./hooks/useTerminalSize.js";
import {
  buildStatusLineSession,
} from "./status-derivation.js";
import { createVoiceInputService } from "./voice-input.js";
import type { LLMMessage } from "../llm/types.js";
import type { PendingPermissionRequest } from "../permissions/context.js";
import {
  getNextPermissionMode,
  transitionPermissionMode,
  type BypassConsentRequiredError,
} from "../permissions/mode.js";
import type { ToolPermissionContext } from "../permissions/types.js";
import { checkNpmUpdate } from "../utils/auto-updater.js";

const RUNTIME_PACKAGE_NAME = "@tetsuo-ai/runtime";
const RUNTIME_PACKAGE_VERSION = "0.2.0";

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
  /** Model label shown in the default status footer. */
  readonly model?: string;
  /** Optional boot-time prompt forwarded from the CLI TTY router. */
  readonly initialPrompt?: string;
  /** Optional startup multimodal messages forwarded from CLI image flags. */
  readonly initialUserMessages?: readonly LLMMessage[];
  /** Optional boot-time draft captured before Ink mounted. */
  readonly initialComposerText?: string;
}

// ────────────────────────────────────────────────────────────────────────
// Adapters — wrap the structural `PendingPermissionRequest` in the
// `InteractiveResolver` contract that `<InteractiveHandler>` consumes.
// ────────────────────────────────────────────────────────────────────────

/**
 * Shape we expect on a `PendingPermissionRequest` once the evaluator is
 * wired. The evaluator attaches a `resolveOnce` slot so the TUI can
 * deliver the user's decision back to the awaiter. The shape is checked
 * at runtime because the persisted queue interface is intentionally
 * narrower than the live evaluator request.
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

function hasPermissionModeRegistryUpdate(
  registry: AppStateSessionLike["services"]["permissionModeRegistry"],
): registry is AppStateSessionLike["services"]["permissionModeRegistry"] & {
  update(next: ToolPermissionContext): Promise<void> | void;
} {
  return typeof (registry as { readonly update?: unknown }).update === "function";
}

function isBypassConsentRequiredError(
  value: unknown,
): value is BypassConsentRequiredError {
  return (
    value !== null &&
    typeof value === "object" &&
    "error" in value &&
    (value as { readonly error?: unknown }).error === "bypass_consent_required"
  );
}

function peekActiveTurnId(
  session: AppSessionLike,
  fallbackTurnId: string | null,
): string | null {
  try {
    return session.activeTurn?.unsafePeek()?.turnId ?? fallbackTurnId;
  } catch {
    return fallbackTurnId;
  }
}

async function interruptActiveTurn(
  session: AppSessionLike,
  fallbackTurnId: string | null,
): Promise<boolean> {
  const activeTurnId = peekActiveTurnId(session, fallbackTurnId);
  if (activeTurnId === null) {
    return false;
  }

  const abortTurnIfActive = session.abortTurnIfActive;
  if (typeof abortTurnIfActive === "function") {
    try {
      return await Promise.resolve(
        abortTurnIfActive.call(session, activeTurnId, "interrupted"),
      );
    } catch {
      // Fall through to the legacy terminal-level abort below.
    }
  }

  try {
    session.abortTerminal?.("user_interrupt");
    return typeof session.abortTerminal === "function";
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────
// TUIRoot — the real composition
// ────────────────────────────────────────────────────────────────────────

function TUIRoot({
  model,
  initialPrompt,
  initialUserMessages,
  initialComposerText,
}: {
  readonly model?: string;
  readonly initialPrompt?: string;
  readonly initialUserMessages?: readonly LLMMessage[];
  readonly initialComposerText?: string;
}): React.ReactElement {
  const {
    mode,
    session,
    configStore,
    pendingRequests,
    permissionQueueOps,
    setStreaming,
    setExpandedView,
    model: liveModel,
    expandedView,
  } =
    useAgenCAppState();
  // The AppState-side `SessionLike` is intentionally permissive (every
  // hook-only field is optional) so tests can pass a tiny stub. useQuery
  // wants `activeTurn` and `abortTerminal` as required fields; we cast
  // here because the runtime contract (either the real Session or a
  // test stub that implements useQuery's surface) is responsible for
  // providing them. When they're missing, useQuery's internal
  // `warnOnce` path no-ops gracefully.
  const { events, isStreaming, currentTurnId, submit } = useQuery(
    session as unknown as QuerySessionLike,
  );
  const initialPromptSubmittedRef = useRef(false);
  const overlay = useOverlayStack();
  const setKeybindingContext = useSetKeybindingContext();
  const [transcriptMode, setTranscriptMode] = useState(false);
  const [showAllInTranscript, setShowAllInTranscript] = useState(false);
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);
  const { columns } = useTerminalSize();

  // Derive transcript messages from phase events on every render. The
  // adapter is pure and cheap, so useMemo's only job here is to keep
  // referential identity stable for MessageList's sticky-scroll
  // bookkeeping.
  const messages = useMemo(
    () =>
      eventsToMessages(events, {
        includeHidden: transcriptMode && showAllInTranscript,
      }),
    [events, showAllInTranscript, transcriptMode],
  );

  const tuiConfigView = useTuiConfigView(configStore);

  // Source of truth for the per-project task store. `agencHome` falls
  // through to `homedir() + "/.agenc"` inside the store when undefined;
  // the TUI only needs to pin it explicitly when tests or non-default
  // configs override it.
  const taskStoreOptions = useMemo<TaskStoreOptions>(() => {
    const cwd =
      typeof session.cwd === "string" && session.cwd.length > 0
        ? session.cwd
        : process.cwd();
    const explicitAgencHome = (
      session as unknown as {
        sessionConfiguration?: { agencHome?: string };
      }
    ).sessionConfiguration?.agencHome;
    return explicitAgencHome !== undefined
      ? { workspaceRoot: cwd, agencHome: explicitAgencHome }
      : { workspaceRoot: cwd };
  }, [session]);
  const statusLineItems =
    tuiConfigView.statusLineItems ?? DEFAULT_STATUS_LINE_ITEMS;
  const composerAttachmentsConfig = tuiConfigView.composerAttachmentsConfig;
  const layoutConfig = tuiConfigView.tuiLayout;
  const multiPane =
    layoutConfig?.mode === "multi-pane" &&
    (layoutConfig.sidePane ?? "status") !== "none" &&
    columns >= (layoutConfig.minColumns ?? 120);
  const voiceInputService = useMemo(
    () =>
      createVoiceInputService({
        config: tuiConfigView.voiceInput,
        cwd:
          typeof session.cwd === "string" && session.cwd.length > 0
            ? session.cwd
            : process.cwd(),
      }),
    [session.cwd, tuiConfigView.voiceInput],
  );

  useEffect(() => {
    setStreaming(isStreaming);
  }, [isStreaming, setStreaming]);

  useEffect(() => {
    if (tuiConfigView.autoUpdates !== true) {
      setUpdateNotice(null);
      return undefined;
    }
    let alive = true;
    void checkNpmUpdate({
      packageName: RUNTIME_PACKAGE_NAME,
      currentVersion: RUNTIME_PACKAGE_VERSION,
    })
      .then((result) => {
        if (!alive) return;
        setUpdateNotice(
          result.updateAvailable && result.latestVersion
            ? `${result.packageName} ${result.latestVersion} available`
            : null,
        );
      })
      .catch(() => {
        if (alive) setUpdateNotice(null);
      });
    return () => {
      alive = false;
    };
  }, [tuiConfigView.autoUpdates]);

  useEffect(() => {
    if (overlay.overlays.length > 0) return;
    setKeybindingContext(transcriptMode ? "transcript" : "chat");
  }, [overlay.overlays.length, setKeybindingContext, transcriptMode]);

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
      emit: (event, payload) => {
        if (event !== "warning:mention_outside_workspace") return;
        const warning = payload as {
          readonly path?: unknown;
          readonly reason?: unknown;
        } | null;
        const path =
          typeof warning?.path === "string" ? warning.path : "unknown";
        const reason =
          typeof warning?.reason === "string" ? warning.reason : "unreadable";
        emitSessionWarning(
          session,
          "mention_outside_workspace",
          `Dropped @${path}: ${reason}`,
          { path, reason },
        );
      },
      skillsManager: (
        session.services as {
          readonly skillsManager?: ComposerSession["skillsManager"];
        }
      ).skillsManager,
      appsManager: (
        session.services as {
          readonly appsManager?: ComposerSession["appsManager"];
        }
      ).appsManager,
      ...(voiceInputService !== undefined
        ? { voiceInput: () => voiceInputService.transcribeOnce() }
        : {}),
    }),
    [session, voiceInputService],
  );
  // Prefer the live AppState model (updated synchronously by `/model`)
  // over the seeded prop so the status bar refreshes on the next render
  // after a slash-command swap. Mirrors openclaude's
  // `useAppState(s => s.mainLoopModel)` subscription pattern.
  const effectiveModel = liveModel ?? model;
  const statusLineSession = useMemo(
    () => buildStatusLineSession(session, mode, effectiveModel),
    [mode, effectiveModel, session, events.length],
  );
  const statusNoticeWarnings = readRuntimeStatusNoticeWarnings(session);
  const handleCycleMode = useCallback((): void => {
    const registry = session.services.permissionModeRegistry;
    if (!hasPermissionModeRegistryUpdate(registry)) {
      return;
    }
    const current = registry.current() as ToolPermissionContext;
    const nextMode = getNextPermissionMode(current.mode, current);
    let transitioned: ToolPermissionContext | BypassConsentRequiredError;
    try {
      transitioned = transitionPermissionMode(current.mode, nextMode, current, {
        requireBypassConsent: true,
        workspacePath: composerSession.cwd,
      });
    } catch (error) {
      emitSessionWarning(
        session,
        "permission_mode_cycle_failed",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    if (isBypassConsentRequiredError(transitioned)) {
      emitSessionWarning(
        session,
        "bypass_consent_required",
        "Switching to bypassPermissions requires explicit consent. Run /permissions accept-bypass to confirm this workspace will use bypassPermissions mode.",
        {
          workspacePath:
            transitioned.workspacePath ?? composerSession.cwd,
        },
      );
      return;
    }
    void Promise.resolve(registry.update({ ...transitioned, mode: nextMode })).catch(
      (error: unknown) => {
        emitSessionWarning(
          session,
          "permission_mode_cycle_failed",
          error instanceof Error ? error.message : String(error),
        );
      },
    );
  }, [composerSession.cwd, session]);
  useKeybinding("chat:cycleMode", handleCycleMode, "chat");

  const validPendingRequests = useMemo(
    () => pendingRequests.filter(hasInteractiveResolver),
    [pendingRequests],
  );

  const openPickerIntent = usePickerController({
    configStore,
    overlay,
    providerSlug: session.sessionConfiguration?.provider?.slug,
    submit,
  });

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
    const pickerIntent = readPickerCommandIntent(text);
    if (pickerIntent) {
      openPickerIntent(pickerIntent);
      return;
    }
    // `useQuery.submit` is a terminal-safe wrapper that logs if the
    // underlying session doesn't expose a submit hook; dropped input
    // is an observability signal, not a crash.
    void submit(text).catch(() => {
      // Submit failures surface through the session emit channel in
      // real runs; swallow here so a rejected promise doesn't become
      // an unhandled promise rejection in the Ink scheduler.
    });
  };

  const handleInterrupt = useCallback((): void => {
    void interruptActiveTurn(session, currentTurnId);
  }, [currentTurnId, session]);
  useKeybinding("app:interrupt", handleInterrupt, "global");

  const handleToggleTranscript = useCallback((): void => {
    setTranscriptMode((value) => {
      const next = !value;
      if (!next) {
        setShowAllInTranscript(false);
      }
      return next;
    });
  }, []);
  useKeybinding("app:toggleTranscript", handleToggleTranscript, "global");

  const handleToggleTasks = useCallback((): void => {
    setExpandedView(expandedView === "tasks" ? "none" : "tasks");
  }, [expandedView, setExpandedView]);
  useKeybinding("app:toggleTasks", handleToggleTasks, "global");

  const handleTranscriptShowAll = useCallback((): void => {
    setShowAllInTranscript((value) => !value);
  }, []);
  useKeybinding(
    "transcript:toggleShowAll",
    handleTranscriptShowAll,
    "transcript",
  );

  const handleExitTranscript = useCallback((): void => {
    setTranscriptMode(false);
    setShowAllInTranscript(false);
  }, []);
  useKeybinding("transcript:exit", handleExitTranscript, "transcript");

  const handleCancel = (): void => {
    void interruptActiveTurn(session, currentTurnId);
  };

  useEffect(() => {
    if (initialPromptSubmittedRef.current) return;
    const hasInitialPrompt =
      typeof initialPrompt === "string" && initialPrompt.length > 0;
    const startupMessages = initialUserMessages ?? [];
    if (!hasInitialPrompt && startupMessages.length === 0) {
      return;
    }
    initialPromptSubmittedRef.current = true;
    for (const message of startupMessages) {
      session.enqueueIdleInput?.(message);
    }
    void submit(hasInitialPrompt ? initialPrompt : "").catch(() => {
      // Submit failures already surface through session-side logging.
    });
  }, [initialPrompt, initialUserMessages, session, submit]);

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      height="100%"
      width="100%"
    >
      {/* transcript region (middle, flex:1) */}
      <Box
        flexDirection={multiPane ? "row" : "column"}
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
      >
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
          <StatusNotices
            session={statusLineSession}
            messages={messages}
            pendingApprovalCount={pendingRequests.length}
            {...(tuiConfigView.configWarnings !== undefined
              ? { configWarnings: tuiConfigView.configWarnings }
              : {})}
            {...(statusNoticeWarnings.projectMemoryWarnings !== undefined
              ? {
                  projectMemoryWarnings:
                    statusNoticeWarnings.projectMemoryWarnings,
                }
              : {})}
            {...(statusNoticeWarnings.agentDefinitionWarnings !== undefined
              ? {
                  agentDefinitionWarnings:
                    statusNoticeWarnings.agentDefinitionWarnings,
                }
              : {})}
          />
          <MessageList
            messages={messages}
            isStreaming={isStreaming}
            verbose={transcriptMode && showAllInTranscript}
          />
        </Box>
        {multiPane ? (
          <SidePane
            model={effectiveModel}
            mode={mode}
            cwd={composerSession.cwd}
            messageCount={messages.length}
            pendingApprovalCount={pendingRequests.length}
            isStreaming={isStreaming}
          />
        ) : null}
      </Box>

      {/* sticky tasks panel — auto-expanded by TaskCreate, collapsed
          on demand via setExpandedView('none'). Sits between the
          transcript and any overlay/composer so it stays anchored. */}
      {expandedView === "tasks" ? (
        <TasksPanel
          storeOptions={taskStoreOptions}
          session={session}
          onHidden={() => setExpandedView("none")}
        />
      ) : null}

      <LiveAgentStatusPanel session={session} />

      {/* overlay stack rendered above the composer so modals stay inside
          the visible viewport while the transcript flexes around them. */}
      {overlay.overlays.length > 0 ? (
        <Box flexDirection="column" flexShrink={0} width="100%">
          {overlay.overlays.map((entry) => (
            <OverlayFrame key={entry.id}>{entry.node}</OverlayFrame>
          ))}
        </Box>
      ) : null}

      {/* composer region (bottom) */}
      <Box flexDirection="column" flexShrink={0} width="100%">
        {transcriptMode ? (
          <TranscriptModeFooter showAll={showAllInTranscript} />
        ) : null}
        {!transcriptMode ? (
          <>
            <QueuedCommands session={session} isStreaming={isStreaming} />
            <Composer
              session={composerSession}
              config={{
                ...(composerAttachmentsConfig !== undefined
                  ? { attachments: composerAttachmentsConfig }
                  : {}),
                ...(tuiConfigView.editorMode !== undefined
                  ? { editorMode: tuiConfigView.editorMode }
                  : {}),
              }}
              onSubmit={handleSubmit}
              onCancel={handleCancel}
              initialValue={initialComposerText}
            />
            <StatusLineConfig
              items={statusLineItems}
              session={statusLineSession}
              cwd={composerSession.cwd}
            />
            {updateNotice !== null ? (
              <Text dim>{updateNotice}</Text>
            ) : null}
          </>
        ) : null}
      </Box>

      {/* invisible orchestrators — one per pending permission request */}
      {permissionHandlers}
    </Box>
  );
}

function OverlayFrame({ children }: { readonly children: ReactNode }) {
  return <Box flexDirection="column">{children}</Box>;
}

function SidePane({
  model,
  mode,
  cwd,
  messageCount,
  pendingApprovalCount,
  isStreaming,
}: {
  readonly model?: string;
  readonly mode: string;
  readonly cwd: string;
  readonly messageCount: number;
  readonly pendingApprovalCount: number;
  readonly isStreaming: boolean;
}): React.ReactElement {
  const cwdLabel = cwd.split(/[\\/]/u).filter(Boolean).at(-1) ?? cwd;
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      width={32}
      paddingLeft={1}
      borderStyle="single"
      borderColor="ansi:blackBright"
    >
      <Text dim>Session</Text>
      <Text>{model ?? "model unset"}</Text>
      <Text dim>{mode}</Text>
      <Text dim>{cwdLabel}</Text>
      <Text dim>{`${messageCount} messages`}</Text>
      {pendingApprovalCount > 0 ? (
        <Text color="yellow">{`${pendingApprovalCount} approvals`}</Text>
      ) : null}
      {isStreaming ? <Text color="cyan">streaming</Text> : null}
    </Box>
  );
}

function TranscriptModeFooter({
  showAll,
}: {
  readonly showAll: boolean;
}): React.ReactElement {
  const toggleKey =
    getDisplayForCommand("app:toggleTranscript", "global") ?? "Ctrl+O";
  const showAllKey =
    getDisplayForCommand("transcript:toggleShowAll", "transcript") ??
    "Ctrl+E";
  const exitKey =
    getDisplayForCommand("transcript:exit", "transcript") ?? "Esc";

  return (
    <Box flexDirection="row" width="100%">
      <Text dim>
        {`Transcript mode · ${toggleKey}/${exitKey}/q returns · ${showAllKey} ${
          showAll ? "hides lifecycle rows" : "shows lifecycle rows"
        }`}
      </Text>
    </Box>
  );
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
  const [effectiveBindings, setEffectiveBindings] = useState<
    Record<BindingContext, BindingMap>
  >(() => bindings ?? loadUserBindingsSync().bindings);

  useEffect(() => {
    if (bindings) {
      setEffectiveBindings(bindings);
      return;
    }

    setEffectiveBindings(loadUserBindingsSync().bindings);
    return watchUserBindings((next) => {
      setEffectiveBindings(next.bindings);
    });
  }, [bindings]);

  return (
    <KeybindingProvider
      bindings={effectiveBindings}
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
  initialUserMessages,
  initialComposerText,
}) => {
  return (
    <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>
      <AgenCAppStateProvider session={session} configStore={configStore}>
        <KeybindingsFromStdin {...(bindings ? { bindings } : {})}>
          <OverlayProvider>
            <TUIRoot
              model={model}
              initialPrompt={initialPrompt}
              initialUserMessages={initialUserMessages}
              initialComposerText={initialComposerText}
            />
          </OverlayProvider>
        </KeybindingsFromStdin>
      </AgenCAppStateProvider>
    </AlternateScreen>
  );
};

export default App;

// Re-exported so tests can mount the live root composition directly.
export { TUIRoot };
export { readPickerCommandIntent };

/**
 * The remaining evaluator-side work is limited to producing queued
 * requests with a live `resolveOnce: InteractiveResolver`. The TUI now
 * consumes those requests directly, rejects resolver-less entries
 * safely, and routes `plan_*` entries from `session.eventLog` through
 * the dedicated transcript renderer via `useQuery`.
 */
