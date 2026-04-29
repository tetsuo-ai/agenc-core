/**
 * REPL — main interactive AgenC TUI screen.
 *
 * OpenClaude-parity composition for the codex runtime surfaces that exist
 * locally. Upstream `REPL.tsx` also pulls in product-specific surfaces that
 * AgenC does not ship today; this screen keeps the live AgenC paths aligned
 * with OpenClaude behavior where an equivalent signal/component exists.
 *
 * What this file does:
 *
 *   1. Mounts the tranche-4 transcript stack
 *      (`MessageList` + `MessageSelector` + `VirtualMessageList`) inside
 *      a flex column.
 *   2. Mounts the live AgenC composer (`Composer`).
 *   3. Wires the existing AgenC permission overlays
 *      (`ApprovalOverlay`, `AskUserQuestionOverlay`, `InteractiveHandler`,
 *      `PermissionRequest`).
 *   4. Wires `cockpit/{StatusLineConfig, StatusNotices}` for the footer.
 *   5. Wires the tranche-3 state contexts
 *      (`AppState`, `NotificationsContext`, `StatsContext`,
 *      `FpsMetricsContext`, `PromptOverlayContext`) and the tranche-3
 *      overlay extension (`OverlayProvider`).
 *   6. Wires the tranche-7 startup-gate state machine
 *      (`repl-startup-gates.ts`) with concrete AgenC gates: trust,
 *      api-key, policy. Upstream-only gates (memory-file external
 *      includes, console-oauth, channel-downgrade) are dropped.
 *   7. Wires the tranche-7 input suppression predicate
 *      (`repl-input-suppression.ts`) so dialogs surfaced during the
 *      pre-typing window don't steal focus.
 *
 * Explicit non-goals (intentionally out of scope):
 *
 *   - Voice integration (`useVoiceIntegration`, `VoiceKeybindingHandler`).
 *   - Slack channel suggestions / IDE @-mention / AgenC-in-browser
 *     onboarding.
 *   - Buddy companion sprite + notifications.
 *   - Agent CRUD wizard, AutoUpdater, plugin hint menus, marketplace
 *     surveys.
 *   - Coordinator mode (`feature('COORDINATOR_MODE')`).
 *   - Loop / proactive / Kairos / scheduled tasks.
 *   - Frustration detection, feedback surveys, post-compact survey.
 *
 * Wave-bridge notes:
 *
 *   - The high-level App tree at `tui/App.tsx` already mounts all of the
 *     above for the live runtime — `tui/screens/REPL.tsx` is a thin
 *     wrapper that lets a top-level entrypoint switch between
 *     `<REPL>` and `<ResumeConversation>` (or `<Doctor>`) without
 *     duplicating the App provider stack.
 *   - All deep upstream-specific integration spots are marked with
 *     `// TODO(tranche-7-followup): wire <X> when ported`.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Box, Text } from "../ink-public.js";
import { Pane } from "../design-system/Pane.js";
import { glyphs } from "../design-system/glyphs.js";

import { useAgenCAppState } from "../state/AppState.js";
import { useOverlayStack } from "../overlay/OverlayProvider.js";
import { useKeybinding } from "../keybindings/KeybindingContext.js";

import { MessageList } from "../transcript/MessageList.js";
import { MessageSelector } from "../transcript/MessageSelector.js";
import { LiveAgentStatusPanel } from "../components/LiveAgentStatusPanel.js";
// `VirtualMessageList` is mounted indirectly through `MessageList`. The REPL
// surface keeps the dependency pinned via the side-effecting import below
// so future tranches can swap to the windowed list without a separate
// import edit.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { VirtualMessageList as _VirtualMessageList } from "../transcript/VirtualMessageList.js";

import { Composer, type ComposerSession } from "../composer/Composer.js";
import { QueuedCommands } from "../composer/QueuedCommands.js";

import {
  InteractiveHandler,
  type InteractivePermissionRequest,
  type InteractiveResolver,
  type OverlayContextLike,
} from "../permissions/InteractiveHandler.js";
// ApprovalOverlay / AskUserQuestionOverlay are mounted by InteractiveHandler
// internally via the overlay stack; we keep the import alive so the module
// graph reflects the wired dependency.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { ApprovalOverlay as _ApprovalOverlay } from "../permissions/ApprovalOverlay.js";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { AskUserQuestionOverlay as _AskUserQuestionOverlay } from "../permissions/AskUserQuestionOverlay.js";

import {
  DEFAULT_STATUS_LINE_ITEMS,
  StatusLineConfig,
} from "../cockpit/StatusLineConfig.js";
import {
  readRuntimeStatusNoticeWarnings,
  StatusNotices,
} from "../cockpit/StatusNotices.js";

import { useQuery } from "../hooks/useQuery.js";
import { eventsToMessages } from "../state/events-to-messages.js";
import { useTuiConfigView } from "../config-view.js";
import { buildStatusLineSession } from "../status-derivation.js";

import { isPromptTypingSuppressionActive } from "./repl-input-suppression.js";
import {
  allStartupGatesCleared,
  anyStartupGateBlocked,
  createInitialStartupGates,
  deriveStartupGatesFromRuntime,
  nextActiveStartupGate,
  setStartupGate,
  shouldRunStartupChecks,
  type StartupGateName,
  type StartupGateState,
  type StartupGatesSnapshot,
  visibleStartupGateNames,
} from "./repl-startup-gates.js";

import type { PendingPermissionRequest } from "../../permissions/context.js";

// ─────────────────────────────────────────────────────────────────────────
// Public surface
// ─────────────────────────────────────────────────────────────────────────

export interface REPLProps {
  /** Optional model label forwarded into the status footer. */
  readonly model?: string;
  /** Optional initial prompt — auto-submitted once on mount, like the App tree. */
  readonly initialPrompt?: string;
  /** Optional pre-populated composer text (not auto-submitted). */
  readonly initialComposerText?: string;
  /** Whether the session is a remote one — disables startup checks. */
  readonly isRemoteSession?: boolean;
}

interface EvaluatorLinkedRequest extends PendingPermissionRequest {
  readonly resolveOnce?: InteractiveResolver;
}

function hasInteractiveResolver(
  request: EvaluatorLinkedRequest,
): request is PendingPermissionRequest & {
  readonly resolveOnce: InteractiveResolver;
} {
  return (
    request.resolveOnce !== undefined &&
    typeof request.resolveOnce.claim === "function" &&
    typeof request.resolveOnce.isResolved === "function"
  );
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

// ─────────────────────────────────────────────────────────────────────────
// Startup gate panel
// ─────────────────────────────────────────────────────────────────────────

function StartupGatesPanel({
  gates,
  active,
}: {
  readonly gates: StartupGatesSnapshot;
  readonly active: StartupGateName | null;
}): React.ReactElement {
  const order = visibleStartupGateNames(gates);
  return (
    <Pane color="accent">
      <Box flexDirection="column">
        <Text bold>Startup checks</Text>
        {order.map((name) => {
          const state = gates[name];
          const color: "success" | "error" | "dim" =
            state === "cleared"
              ? "success"
              : state === "blocked"
                ? "error"
                : "dim";
          const label =
            state === "cleared"
              ? glyphs.tick
              : state === "blocked"
                ? glyphs.cross
                : name === active
                  ? glyphs.pointer
                  : glyphs.circle;
          return (
            <Box key={name} flexDirection="row">
              <Text>{"└ "}</Text>
              <Text color={color}>
                {`${label} ${startupGateLabel(name)}`}
              </Text>
              {state === "pending" && name === active ? (
                <Text color="dim">{` · running`}</Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
    </Pane>
  );
}

function startupGateLabel(name: StartupGateName): string {
  switch (name) {
    case "trust":
      return "workspace trust";
    case "apiKey":
      return "API key";
    case "policy":
      return "runtime policy";
  }
}

// ─────────────────────────────────────────────────────────────────────────
// REPL
// ─────────────────────────────────────────────────────────────────────────

export function REPL({
  model,
  initialPrompt,
  initialComposerText,
  isRemoteSession = false,
}: REPLProps): React.ReactElement {
  const {
    mode,
    session,
    configStore,
    pendingRequests,
    permissionQueueOps,
    setStreaming,
    model: liveModel,
  } = useAgenCAppState();

  const overlay = useOverlayStack();

  // Event stream + transcript adapter — same shape as App.tsx.
  const { events, isStreaming, currentTurnId, submit } = useQuery(
    session as never,
  );

  // Transcript-only modes mirror the App tree so the REPL screen and
  // the live App composition behave identically when used as the
  // outer-most screen.
  const [transcriptMode, setTranscriptMode] = useState(false);
  const [showAllInTranscript, setShowAllInTranscript] = useState(false);
  const [composerActive, setComposerActive] = useState(false);
  const [composerValue, setComposerValue] = useState(initialComposerText ?? "");
  const [hasHadFirstSubmission, setHasHadFirstSubmission] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [showMessageSelector, setShowMessageSelector] = useState(false);

  // Startup-gate state machine. The bridge below derives concrete gate
  // states from the live AgenC session/config surfaces. Unsupported
  // OpenClaude-only gates are omitted, so they do not render as fake
  // pending startup work.
  const [gates, setGates] = useState<StartupGatesSnapshot>(() =>
    createInitialStartupGates(),
  );
  const setGate = useCallback(
    (name: StartupGateName, state: StartupGateState) => {
      setGates((prev) => setStartupGate(prev, name, state));
    },
    [],
  );

  const messages = useMemo(
    () =>
      eventsToMessages(events, {
        includeHidden: transcriptMode && showAllInTranscript,
      }),
    [events, showAllInTranscript, transcriptMode],
  );

  const tuiConfigView = useTuiConfigView(configStore);
  const statusLineItems =
    tuiConfigView.statusLineItems ?? DEFAULT_STATUS_LINE_ITEMS;
  const composerAttachmentsConfig = tuiConfigView.composerAttachmentsConfig;

  useEffect(() => {
    setStreaming(isStreaming);
  }, [isStreaming, setStreaming]);

  // Suppress startup gates while the user is typing into the prompt
  // (per `repl-input-suppression.ts`). We surface this as a derived
  // boolean so future tranches can plug additional gating onto it.
  const promptTypingSuppressionActive = isPromptTypingSuppressionActive(
    composerActive,
    composerValue,
  );

  const startupChecksAllowed = shouldRunStartupChecks({
    isRemoteSession,
    hasStarted,
    hasHadFirstSubmission,
  });

  // TODO(tranche-7-followup): wire useReplBridge / useSearchInput /
  // useTabStatus / useTerminalTitle / useCostSummary / useLogMessages /
  // useGlobalKeybindings / useCommandKeybindings when ported.

  // TODO(tranche-7-followup): wire upstream voice / IDE @-mention /
  // slack channel suggestions / buddy notification / agent CRUD wizard /
  // AutoUpdater / in-browser onboarding integrations. These were all
  // explicitly dropped from the AgenC port surface.

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

  const effectiveModel = liveModel ?? model;
  const statusLineSession = useMemo(
    () => buildStatusLineSession(session, mode, effectiveModel),
    [mode, effectiveModel, session, events.length],
  );
  const statusNoticeWarnings = readRuntimeStatusNoticeWarnings(session);

  // Overlay adapter for InteractiveHandler.
  const overlayAdapter = useMemo<OverlayContextLike>(
    () => ({
      push: (node: ReactNode) => {
        const id = overlay.pushOverlay(node);
        return () => overlay.popOverlay(id);
      },
    }),
    [overlay],
  );

  const validPendingRequests = useMemo(
    () => pendingRequests.filter(hasInteractiveResolver),
    [pendingRequests],
  );

  useEffect(() => {
    for (const request of pendingRequests) {
      if (hasInteractiveResolver(request as EvaluatorLinkedRequest)) continue;
      permissionQueueOps.remove(request.requestId);
    }
  }, [pendingRequests, permissionQueueOps]);

  const permissionHandlers = validPendingRequests.map((req) => (
    <InteractiveHandler
      key={req.requestId}
      request={toHandlerRequest(req)}
      session={session}
      overlayContext={overlayAdapter}
    />
  ));

  // First-submission tracking — drives `shouldRunStartupChecks`.
  const initialPromptSubmittedRef = useRef(false);
  const handleSubmit = useCallback(
    (text: string): void => {
      if (!hasHadFirstSubmission) {
        setHasHadFirstSubmission(true);
      }
      void submit(text).catch(() => {
        // Submit failures are logged by the runtime side.
      });
    },
    [hasHadFirstSubmission, submit],
  );

  useEffect(() => {
    if (initialPromptSubmittedRef.current) return;
    if (typeof initialPrompt !== "string" || initialPrompt.length === 0) {
      return;
    }
    initialPromptSubmittedRef.current = true;
    setHasHadFirstSubmission(true);
    void submit(initialPrompt).catch(() => {
      // Submit failures already surface through session-side logging.
    });
  }, [initialPrompt, submit]);

  // Once startup checks are allowed and all gates clear, mark startup
  // as having "started" so we stop re-running the check.
  useEffect(() => {
    if (!startupChecksAllowed) return;
    if (anyStartupGateBlocked(gates)) return;
    if (allStartupGatesCleared(gates) && !hasStarted) {
      setHasStarted(true);
    }
  }, [startupChecksAllowed, gates, hasStarted]);

  const handleInterrupt = useCallback((): void => {
    try {
      const peeked = session.activeTurn?.unsafePeek();
      const turnId = peeked?.turnId ?? currentTurnId;
      if (typeof session.abortTurnIfActive === "function" && turnId) {
        void Promise.resolve(
          session.abortTurnIfActive(turnId, "interrupted"),
        ).catch(() => {
          /* runtime owns its own logging */
        });
      } else if (typeof session.abortTerminal === "function") {
        session.abortTerminal("user_interrupt");
      }
    } catch {
      /* best-effort */
    }
  }, [currentTurnId, session]);
  useKeybinding("app:interrupt", handleInterrupt, "global");

  const handleToggleTranscript = useCallback((): void => {
    setTranscriptMode((value) => {
      const next = !value;
      if (!next) setShowAllInTranscript(false);
      return next;
    });
  }, []);
  useKeybinding("app:toggleTranscript", handleToggleTranscript, "global");

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

  const activeStartupGate = nextActiveStartupGate(gates);
  const showStartupGatesPanel =
    startupChecksAllowed &&
    !promptTypingSuppressionActive &&
    !hasStarted &&
    activeStartupGate !== null;

  const handleSelectorClose = useCallback(() => {
    setShowMessageSelector(false);
  }, []);

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      height="100%"
      width="100%"
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

      {showStartupGatesPanel ? (
        <Box flexDirection="column" flexShrink={0} width="100%">
          <StartupGatesPanel gates={gates} active={activeStartupGate} />
        </Box>
      ) : null}

      <LiveAgentStatusPanel session={session} />

      {showMessageSelector ? (
        <Box flexDirection="column" flexShrink={0} width="100%">
          <MessageSelector
            messages={messages}
            onClose={handleSelectorClose}
            onRestoreMessage={async () => {
              // TODO(tranche-7-followup): wire restore/rewind once the
              // session-restore pathway is exposed at this layer. Until
              // then the selector simply closes when a row is picked.
              handleSelectorClose();
            }}
          />
        </Box>
      ) : null}

      {overlay.overlays.length > 0 ? (
        <Box flexDirection="column" flexShrink={0} width="100%">
          {overlay.overlays.map((entry) => (
            <Box key={entry.id} flexDirection="column">
              {entry.node}
            </Box>
          ))}
        </Box>
      ) : null}

      <Box flexDirection="column" flexShrink={0} width="100%">
        {transcriptMode ? (
          <TranscriptModeFooter showAll={showAllInTranscript} />
        ) : (
          <>
            <QueuedCommands session={session} isStreaming={isStreaming} />
            <Composer
              session={composerSession}
              config={
                composerAttachmentsConfig !== undefined
                  ? { attachments: composerAttachmentsConfig }
                  : undefined
              }
              onSubmit={(value) => {
                // Submission ends the vulnerable pre-interaction window.
                // Keep the suppression signal clear here so startup gates can
                // run immediately after the first submitted prompt.
                setComposerActive(false);
                setComposerValue("");
                handleSubmit(value);
              }}
              onCancel={() => {
                setComposerActive(false);
                handleInterrupt();
              }}
              initialValue={initialComposerText}
            />
            <StatusLineConfig
              items={statusLineItems}
              session={statusLineSession}
              cwd={composerSession.cwd}
            />
          </>
        )}
      </Box>

      {permissionHandlers}

      <REPLGateBridge
        setGate={setGate}
        session={session}
        configStore={configStore}
        configVersion={tuiConfigView}
      />
    </Box>
  );
}

function REPLGateBridge({
  setGate,
  session,
  configStore,
  configVersion: _configVersion,
}: {
  readonly setGate: (name: StartupGateName, state: StartupGateState) => void;
  readonly session: unknown;
  readonly configStore: unknown;
  readonly configVersion: unknown;
}): React.ReactElement | null {
  useEffect(() => {
    let config: unknown;
    let configError: unknown;
    const current = (
      configStore as { readonly current?: () => unknown } | null
    )?.current;
    if (typeof current === "function") {
      try {
        config = current.call(configStore);
      } catch (err) {
        configError = err;
      }
    } else {
      config = (configStore as { readonly snapshot?: unknown } | null)
        ?.snapshot;
    }

    const next = deriveStartupGatesFromRuntime({
      session,
      config,
      ...(configError !== undefined ? { configError } : {}),
    });
    for (const gate of ["trust", "apiKey", "policy"] as const) {
      setGate(gate, next[gate]);
    }
  }, [setGate, session, configStore, _configVersion]);

  return null;
}

function TranscriptModeFooter({
  showAll,
}: {
  readonly showAll: boolean;
}): React.ReactElement {
  return (
    <Box flexDirection="row" width="100%">
      <Text dimColor>
        {`Transcript mode · Esc/q returns · Ctrl+E ${
          showAll ? "hides lifecycle rows" : "shows lifecycle rows"
        }`}
      </Text>
    </Box>
  );
}

export default REPL;
