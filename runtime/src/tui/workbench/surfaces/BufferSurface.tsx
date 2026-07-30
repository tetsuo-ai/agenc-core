import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { basename, relative } from "node:path";

import type { WorkspaceEditorRecoveredTopologyMutation } from "../../../app-server/protocol/index.js";
import { peekLSPDiagnosticsForFile } from "../../../services/lsp/LSPDiagnosticRegistry.js";
import { peekAmbientRuntimeSession } from "../../../session/current-session.js";
import type { DiagnosticEntry } from "../../../services/lsp/types.js";
import { logError } from "../../../utils/log.js";
import type { DOMElement } from "../../ink/dom.js";
import type { InputEvent } from "../../ink/events/input-event.js";
import { nodeCache } from "../../ink/node-cache.js";
import { stringWidth } from "../../ink/stringWidth.js";
import { setClipboard } from "../../ink/termio/osc.js";
import { Box, measureElement, Text } from "../../ink.js";
import { useRegisterKeybindingContext } from "../../keybindings/KeybindingContext.js";
import {
  useInputCapture,
  useKeybindings,
} from "../../keybindings/useKeybinding.js";
import { useAppState } from "../../state/AppState.js";
import { taskMayReferencePath } from "../agents/activity.js";
import {
  type BufferVimCommand,
  type BufferVisibleLine,
} from "../buffer/BufferStore.js";
import { highlightBufferVisibleLines } from "../buffer/highlight.js";
import { getWorkbenchBufferProviderController } from "../buffer/providers/BufferProviderController.js";
import { BufferLine, NeovimGridView } from "../buffer/render.js";
import { useBufferStore } from "../buffer/useBufferStore.js";
import { bufferIntegrationIntentCommand } from "../commands.js";
import { useWorkbenchDispatch, useWorkbenchState } from "../state.js";
import { EmptySurface, SurfaceHeader } from "./PreviewSurface.js";
import { wheelInputIsInsideNode as wheelInputIsInsideNodeImpl } from "./wheelInput.js";
import type { WorkbenchCommand } from "../types.js";
import type {
  BufferCodePrediction,
  BufferCodePredictionContext,
  BufferCodePredictionFeedback,
  BufferIntegrationIntent,
  BufferProviderBuffer,
  BufferProviderSnapshot,
} from "../buffer/providers/types.js";

const EMPTY_HIGHLIGHTS: ReadonlyMap<number, string> = new Map();
const INITIAL_CONTENT_SIZE = { rows: 1, columns: 1 } as const;

export type BufferCodePredictionUi = {
  readonly enabled: boolean;
  readonly debounceMs: number;
  readonly complete: (
    context: BufferCodePredictionContext,
    generation: number,
  ) => Promise<BufferCodePrediction | null>;
  readonly cancel: () => void;
  readonly onDisplayed: (prediction: BufferCodePrediction) => void;
  readonly onFeedback: (feedback: BufferCodePredictionFeedback) => void;
};

export type BufferTopologyRecoveryUi = {
  readonly mutation: WorkspaceEditorRecoveredTopologyMutation;
  readonly onResolveUnknown: () => Promise<void>;
};

export function BufferSurface({
  focused,
  onEditorInteraction,
  codePrediction,
  mutationBlockedReason = null,
  topologyRecovery,
}: {
  readonly focused: boolean;
  readonly onEditorInteraction?: (intent: BufferIntegrationIntent) => void;
  readonly codePrediction?: BufferCodePredictionUi;
  readonly mutationBlockedReason?: string | null;
  readonly topologyRecovery?: BufferTopologyRecoveryUi;
}): React.ReactElement {
  const workbench = useWorkbenchState();
  const dispatch = useWorkbenchDispatch();
  const snapshot = useBufferStore();
  const store = getWorkbenchBufferProviderController();
  const tasks = useAppState((state) => state.tasks);
  const activePath = workbench.activeFilePath;
  const activeIdentity = bufferSurfaceActiveIdentity(snapshot, activePath);
  const activeLine = workbench.activeFileLine ?? 1;
  const activeOpenRequestId = workbench.bufferOpenRequestId;
  const lastOpenRequest = useRef<string | null>(null);
  const pendingHostOpen = useRef<{
    readonly requestKey: string;
    readonly path: string;
    readonly line: number;
    inFlight: boolean;
  } | null>(null);
  const contentRef = useRef<DOMElement | null>(null);
  const measuredContentSize = useRef<{
    readonly rows: number;
    readonly columns: number;
  } | null>(null);
  const inputContentSize = useRef<{
    readonly rows: number;
    readonly columns: number;
  }>(INITIAL_CONTENT_SIZE);
  const [contentSize, setContentSize] = useState<{
    readonly rows: number;
    readonly columns: number;
  }>(INITIAL_CONTENT_SIZE);
  const [recoveryDiscardArmed, setRecoveryDiscardArmed] = useState(false);
  const [topologyRecoveryArmed, setTopologyRecoveryArmed] = useState(false);
  const [topologyRecoveryWorking, setTopologyRecoveryWorking] = useState(false);
  const topologyRecoveryArmedRef = useRef(false);
  const [predictionFeedbackRevision, setPredictionFeedbackRevision] =
    useState(0);
  const predictionGenerationRef = useRef(0);
  const stagedPredictionRef = useRef<{
    readonly requestId: string;
    readonly generation: number;
  } | null>(null);
  const clearStagedPrediction = useCallback((): void => {
    const stagedPrediction = stagedPredictionRef.current;
    if (stagedPrediction === null) return;
    stagedPredictionRef.current = null;
    void store.clearCodePrediction(stagedPrediction.requestId).catch(logError);
  }, [store]);
  const inFlightAgent = useMemo(
    () =>
      Object.values(tasks).find(
        (task) =>
          task.type !== "local_bash" &&
          (task.status === "running" || task.status === "pending") &&
          taskMayReferencePath(task, activeIdentity.referencePath),
      ),
    [activeIdentity.referencePath, tasks],
  );
  const diagnostics = snapshot.absolutePath
    ? peekLSPDiagnosticsForFile(
        snapshot.absolutePath,
        peekAmbientRuntimeSession()?.services.sandboxExecutionBroker,
      )
    : [];
  const visibleLines = store.getVisibleLines();
  const tabs = (snapshot.buffers ?? []).filter(
    (buffer) => buffer.listed && buffer.loaded && buffer.bufferType === "",
  );
  const tabLabels = bufferTabLabels(tabs);
  const tabCharacters = tabs.reduce(
    (total, buffer) =>
      total +
      stringWidth(tabLabels.get(buffer.handle) ?? "") +
      (buffer.modified ? 2 : 0) +
      2,
    0,
  );
  const orderedTabs =
    tabCharacters > contentSize.columns ? rotateActiveTabFirst(tabs) : tabs;
  const showTabsMode = store.getShowTabsMode();
  const showTabs =
    tabs.length > 0 &&
    (showTabsMode === "always" || (showTabsMode === "auto" && tabs.length > 1));
  const highlightedLines = useBufferHighlightedLines(
    activeIdentity.referencePath,
    visibleLines,
  );
  const currentLineDiagnostic = diagnostics.find((diagnostic) =>
    diagnosticCoversLine(diagnostic, snapshot.position.line),
  );
  const crashed =
    snapshot.providerStatus === "closed" &&
    snapshot.providerExit?.kind === "crash";
  const crashDetails = crashed
    ? formatProviderCrashDetails(snapshot.providerExit)
    : "";
  const recoveryPending =
    snapshot.recovery?.status === "pending" ||
    snapshot.recovery?.status === "working";
  const attemptHostOpen = useCallback(
    (request: NonNullable<typeof pendingHostOpen.current>): void => {
      if (request.inFlight) return;
      request.inFlight = true;
      void store
        .open(request.path, request.line)
        .catch(logError)
        .finally(() => {
          if (pendingHostOpen.current !== request) return;
          request.inFlight = false;
          const current = store.getSnapshot();
          if (current.filePath === request.path || !current.dirty) {
            pendingHostOpen.current = null;
          }
        });
    },
    [store],
  );
  useEffect(() => {
    setRecoveryDiscardArmed(false);
  }, [snapshot.recovery?.status, snapshot.recovery?.swapFiles]);
  useEffect(() => {
    topologyRecoveryArmedRef.current = false;
    setTopologyRecoveryArmed(false);
    setTopologyRecoveryWorking(false);
  }, [topologyRecovery?.mutation.tokenId]);
  const resolveRecovery = useCallback(
    (action: "recover" | "compare" | "save-copy" | "discard"): void => {
      if (snapshot.recovery?.status !== "pending") return;
      if (action === "discard" && !recoveryDiscardArmed) {
        setRecoveryDiscardArmed(true);
        return;
      }
      void store.resolveRecovery(action).catch(logError);
    },
    [recoveryDiscardArmed, snapshot.recovery?.status, store],
  );
  const restartAfterCrash = useCallback(
    (mode: "configured" | "clean" | "inline"): void => {
      void store.restartAfterCrash(mode).catch(logError);
    },
    [store],
  );
  const copyCrashDetails = useCallback((): void => {
    if (crashDetails) void setClipboard(crashDetails).catch(logError);
  }, [crashDetails]);
  const resolveTopologyRecovery = useCallback((): void => {
    if (topologyRecovery === undefined || topologyRecoveryWorking) return;
    if (!topologyRecoveryArmedRef.current) {
      topologyRecoveryArmedRef.current = true;
      setTopologyRecoveryArmed(true);
      return;
    }
    setTopologyRecoveryWorking(true);
    void topologyRecovery
      .onResolveUnknown()
      .catch(logError)
      .finally(() => {
        setTopologyRecoveryWorking(false);
      });
  }, [topologyRecovery, topologyRecoveryWorking]);

  useEffect(() => {
    if (!activePath) return;
    const requestKey = `${activePath}\u0000${activeLine}\u0000${activeOpenRequestId}`;
    const isNewRequest = lastOpenRequest.current !== requestKey;
    if (isNewRequest) {
      lastOpenRequest.current = requestKey;
      const request = {
        requestKey,
        path: activePath,
        line: activeLine,
        inFlight: false,
      };
      pendingHostOpen.current = request;
      attemptHostOpen(request);
      return;
    }
    const pending = pendingHostOpen.current;
    if (
      pending &&
      pending.requestKey === requestKey &&
      !pending.inFlight &&
      snapshot.status !== "loading" &&
      !snapshot.dirty &&
      !recoveryPending
    ) {
      attemptHostOpen(pending);
    }
  }, [
    activeLine,
    activeOpenRequestId,
    activePath,
    attemptHostOpen,
    recoveryPending,
    snapshot.dirty,
    snapshot.status,
  ]);

  useEffect(() => {
    if (
      workbench.activeSurfaceMode !== "buffer" ||
      workbench.pendingBlockedOverlay !== null ||
      recoveryPending ||
      snapshot.provider.kind !== "neovim" ||
      snapshot.providerStatus !== "ready" ||
      snapshot.filePath === null
    ) {
      return;
    }
    const pending = pendingHostOpen.current;
    if (pending?.path === snapshot.filePath) {
      pendingHostOpen.current = null;
    } else if (pending) {
      return;
    }
    if (snapshot.filePath === activePath) return;
    const line = Math.max(1, snapshot.position.line);
    // Mark this provider-originated path as observed before updating host
    // state, otherwise the next render would mistake :edit/:bnext for a new
    // explorer request and reopen the previous file.
    lastOpenRequest.current = `${snapshot.filePath}\u0000${line}\u0000${activeOpenRequestId}`;
    dispatch({
      type: "syncBufferPath",
      path: snapshot.filePath,
      line,
    });
  }, [
    activeOpenRequestId,
    activePath,
    dispatch,
    recoveryPending,
    snapshot.filePath,
    snapshot.position.line,
    snapshot.provider.kind,
    snapshot.providerStatus,
    workbench.activeSurfaceMode,
    workbench.pendingBlockedOverlay,
  ]);

  // BUFFER occupies only the center workbench pane. Global terminal dimensions
  // are wrong as soon as the explorer, agents, review rail, composer, or a
  // status row is visible. Measure the actual editor content box after Yoga
  // lays it out and keep Neovim's grid exactly aligned with those cells.
  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const measured = measureElement(node);
    if (measured.width <= 0 || measured.height <= 0) return;
    const next = {
      rows: Math.max(1, Math.floor(measured.height)),
      columns: Math.max(1, Math.floor(measured.width)),
    };
    const previous = measuredContentSize.current;
    if (previous?.rows === next.rows && previous.columns === next.columns)
      return;
    measuredContentSize.current = next;
    inputContentSize.current = next;
    setContentSize(next);
    store.resize(next);
  });

  useEffect(() => {
    store.focus(focused && mutationBlockedReason === null);
    return () => {
      if (focused) store.focus(false);
    };
  }, [focused, mutationBlockedReason, store]);

  useEffect(() => {
    if (!focused) return;
    if (workbench.activeSurfaceMode !== "buffer") return;
    if (snapshot.provider.kind !== "neovim") return;
    if (snapshot.providerStatus !== "closed") return;
    if (snapshot.providerExit?.kind === "crash") return;
    dispatch({ type: "closeSurface" });
  }, [
    dispatch,
    focused,
    snapshot.provider.kind,
    snapshot.providerExit?.kind,
    snapshot.providerStatus,
    workbench.activeSurfaceMode,
  ]);

  useEffect(
    () => () => {
      store.focus(false);
    },
    [store],
  );

  useEffect(
    () =>
      store.subscribeIntegrationIntents((intent) => {
        if (mutationBlockedReason !== null) return;
        const needsComposer =
          intent.kind === "attach" ||
          ((intent.kind === "ask" ||
            intent.kind === "edit" ||
            intent.kind === "refactor" ||
            intent.kind === "review") &&
            !intent.prompt?.trim());
        if (!needsComposer && onEditorInteraction) {
          onEditorInteraction(intent);
          return;
        }
        dispatch(bufferIntegrationIntentCommand(intent));
      }),
    [
      dispatch,
      mutationBlockedReason,
      onEditorInteraction,
      snapshot.provider.kind,
      store,
    ],
  );

  useEffect(
    () =>
      store.subscribeCodePredictionFeedback((feedback) => {
        if (
          feedback.kind !== "partially_accepted" &&
          stagedPredictionRef.current?.requestId === feedback.requestId
        ) {
          stagedPredictionRef.current = null;
          setPredictionFeedbackRevision((revision) => revision + 1);
        }
        codePrediction?.onFeedback(feedback);
      }),
    [codePrediction, snapshot.provider.kind, store],
  );

  const activePredictionBuffer = snapshot.buffers.find(
    (buffer) => buffer.handle === snapshot.activeBufferHandle,
  );
  const activePredictionChangedtick =
    activePredictionBuffer?.changedtick ?? null;
  const predictionMode = snapshot.terminal?.mode ?? "";
  const predictionEligible =
    codePrediction?.enabled === true &&
    mutationBlockedReason === null &&
    focused &&
    workbench.activeWorkspaceView === "editor" &&
    workbench.activeSurfaceMode === "buffer" &&
    snapshot.provider.kind === "neovim" &&
    snapshot.providerStatus === "ready" &&
    snapshot.activeBufferHandle !== null &&
    activePredictionChangedtick !== null &&
    isCodePredictionInsertMode(predictionMode);

  useEffect(
    () => () => {
      clearStagedPrediction();
    },
    [clearStagedPrediction, codePrediction],
  );

  useEffect(() => {
    if (predictionEligible) return;
    clearStagedPrediction();
  }, [clearStagedPrediction, predictionEligible]);

  useEffect(() => {
    const generation = predictionGenerationRef.current + 1;
    predictionGenerationRef.current = generation;
    codePrediction?.cancel();

    if (!predictionEligible || codePrediction === undefined) return;
    // Neovim owns the staged prediction's changedtick/cursor revision. A
    // partial acceptance advances both while retaining the same request ID
    // for the remaining ghost text, so ordinary snapshot updates must not
    // clear or replace that remainder.
    if (stagedPredictionRef.current !== null) return;

    let disposed = false;
    const timer = setTimeout(
      () => {
        void (async () => {
          const context = await store.captureCodePredictionContext();
          if (
            disposed ||
            predictionGenerationRef.current !== generation ||
            context === null ||
            context.bufferHandle !== snapshot.activeBufferHandle ||
            context.changedtick !== activePredictionChangedtick
          ) {
            return;
          }
          const prediction = await codePrediction.complete(context, generation);
          if (
            disposed ||
            predictionGenerationRef.current !== generation ||
            prediction === null ||
            prediction.bufferHandle !== context.bufferHandle ||
            prediction.changedtick !== context.changedtick
          ) {
            return;
          }
          if (!(await store.stageCodePrediction(prediction))) return;
          if (disposed || predictionGenerationRef.current !== generation) {
            void store
              .clearCodePrediction(prediction.requestId)
              .catch(logError);
            return;
          }
          stagedPredictionRef.current = {
            requestId: prediction.requestId,
            generation,
          };
          codePrediction.onDisplayed(prediction);
        })().catch(logError);
      },
      Math.max(0, codePrediction.debounceMs),
    );

    return () => {
      disposed = true;
      clearTimeout(timer);
      codePrediction.cancel();
    };
  }, [
    activePredictionChangedtick,
    codePrediction,
    focused,
    mutationBlockedReason,
    predictionEligible,
    predictionFeedbackRevision,
    predictionMode,
    snapshot.activeBufferHandle,
    snapshot.position.column,
    snapshot.position.line,
    snapshot.provider.kind,
    snapshot.providerStatus,
    store,
    workbench.activeSurfaceMode,
    workbench.activeWorkspaceView,
  ]);

  const keybindingContext = snapshot.provider.capabilities.terminalUi
    ? "BufferHost"
    : "Buffer";
  useRegisterKeybindingContext(keybindingContext, focused);
  const hasInFlightAgent = Boolean(inFlightAgent);
  const keyHandlers = useMemo(
    () =>
      createBufferSurfaceKeyHandlers({
        store,
        snapshot,
        hasInFlightAgent,
        dispatch,
        railOpen: workbench.rail !== null,
        mutationBlocked: mutationBlockedReason !== null,
      }),
    [
      dispatch,
      hasInFlightAgent,
      mutationBlockedReason,
      snapshot,
      store,
      workbench.rail,
    ],
  );
  useKeybindings(keyHandlers, {
    context: keybindingContext,
    isActive: focused,
  });

  const executeVimCommand = useCallback(
    (command: BufferVimCommand): void => {
      if (mutationBlockedReason !== null && command.type !== "quit") return;
      executeBufferVimCommand(command, {
        store,
        dispatch,
        hasInFlightAgent,
      });
    },
    [dispatch, hasInFlightAgent, mutationBlockedReason, store],
  );

  useInputCapture(
    useCallback(
      (input, key, event) => {
        if (recoveryPending) {
          const action = input.toLowerCase();
          if (action === "r") resolveRecovery("recover");
          else if (action === "c") resolveRecovery("compare");
          else if (action === "s") resolveRecovery("save-copy");
          else if (action === "d") resolveRecovery("discard");
          return true;
        }
        if (crashed) {
          const action = input.toLowerCase();
          if (action === "r") {
            restartAfterCrash("configured");
            return true;
          }
          if (action === "k") {
            restartAfterCrash("clean");
            return true;
          }
          if (action === "i") {
            restartAfterCrash("inline");
            return true;
          }
          if (action === "c") {
            copyCrashDetails();
            return true;
          }
        }
        if (topologyRecovery !== undefined) {
          if (input.toLowerCase() === "u") resolveTopologyRecovery();
          return true;
        }
        if (mutationBlockedReason !== null) return true;
        // BufferHost normally resolves Ctrl+S before this capture. Keep the
        // save boundary here as well so a provider transition cannot expose a
        // one-render window where raw editor capture is registered before its
        // matching host action handler/context. Ctrl+S must never leak through
        // to embedded Neovim as native input.
        if (
          snapshot.provider.capabilities.terminalUi &&
          isBufferHostSaveInput(input, key)
        ) {
          void store.save({ hasInFlightAgent }).catch(logError);
          return true;
        }
        if (
          (key.wheelUp || key.wheelDown) &&
          !wheelInputIsInsideNode(event, contentRef.current)
        ) {
          return false;
        }
        return store.handleInput(
          input,
          key,
          inputContentSize.current,
          executeVimCommand,
          event.keypress.isPasted,
        );
      },
      [
        copyCrashDetails,
        crashed,
        executeVimCommand,
        hasInFlightAgent,
        mutationBlockedReason,
        recoveryPending,
        resolveRecovery,
        resolveTopologyRecovery,
        restartAfterCrash,
        snapshot.provider.capabilities.terminalUi,
        store,
        topologyRecovery,
      ],
    ),
    { context: keybindingContext, isActive: focused },
  );

  if (
    !activePath &&
    snapshot.status === "idle" &&
    topologyRecovery === undefined
  ) {
    return <EmptySurface title="BUFFER" message="No file selected" />;
  }

  const status = bufferStatusLabel(snapshot, Boolean(inFlightAgent));
  const modeLabel =
    snapshot.vimCommandLine !== null
      ? "command"
      : snapshot.vimMode.toLowerCase();
  const terminal = snapshot.terminal;
  return (
    <Box flexDirection="column" width="100%" height="100%" overflow="hidden">
      <SurfaceHeader
        title="BUFFER"
        detail={`${activeIdentity.displayPath} [${snapshot.provider.label}, ${modeLabel}, ${status}] ${snapshot.position.line}:${snapshot.position.column}`}
        focused={focused}
      />
      {snapshot.provider.fallbackReason ? (
        <Box height={1} flexShrink={0}>
          <Text color="warning" wrap="truncate-end">
            {snapshot.provider.fallbackReason}
          </Text>
        </Box>
      ) : null}
      {snapshot.providerMessage ? (
        <Box height={1} flexShrink={0}>
          <Text dimColor wrap="truncate-end">
            {snapshot.providerMessage}
          </Text>
        </Box>
      ) : null}
      {mutationBlockedReason !== null ? (
        <Box minHeight={1} flexShrink={0}>
          <Text color="error" wrap="wrap">
            {mutationBlockedReason}
          </Text>
        </Box>
      ) : null}
      {snapshot.error ? (
        <Box height={1} flexShrink={0}>
          <Text
            color={snapshot.status === "conflict" ? "warning" : "error"}
            wrap="truncate-end"
          >
            {snapshot.error}
          </Text>
        </Box>
      ) : null}
      {diagnostics.length > 0 ? (
        <Box height={1} flexShrink={0}>
          <Text color="warning" wrap="truncate-end">
            {diagnostics.length} diagnostic{diagnostics.length === 1 ? "" : "s"}
            {currentLineDiagnostic ? ` - ${currentLineDiagnostic.message}` : ""}
          </Text>
        </Box>
      ) : null}
      {inFlightAgent ? (
        <Box height={1} flexShrink={0}>
          <Text color="warning" wrap="truncate-end">
            agent edit in flight:{" "}
            {inFlightAgent.description ?? inFlightAgent.id}
          </Text>
        </Box>
      ) : null}
      {snapshot.hoverText ? (
        <Box height={1} flexShrink={0}>
          <Text dimColor wrap="truncate-end">
            {oneLine(snapshot.hoverText)}
          </Text>
        </Box>
      ) : null}
      {showTabs ? (
        <Box height={1} flexShrink={0} overflow="hidden">
          {orderedTabs.map((buffer) => (
            <Box
              key={buffer.handle}
              paddingX={1}
              backgroundColor={buffer.current ? "#262626" : undefined}
              onClick={(event) => {
                event.stopImmediatePropagation();
                dispatch({ type: "focus", pane: "surface" });
                if (mutationBlockedReason !== null) return;
                void store.selectBuffer(buffer.handle).catch(logError);
              }}
            >
              <Text
                bold={buffer.current}
                color={
                  buffer.modified
                    ? "warning"
                    : buffer.current
                      ? "text"
                      : "inactive"
                }
                wrap="truncate-end"
              >
                {`${buffer.modified ? "● " : ""}${tabLabels.get(buffer.handle) ?? "[No Name]"}`}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}
      <Box
        ref={contentRef}
        flexDirection="column"
        flexGrow={1}
        overflow="hidden"
        onClick={(event) => {
          event.stopImmediatePropagation();
          dispatch({ type: "focus", pane: "surface" });
          if (recoveryPending || crashed || mutationBlockedReason !== null)
            return;
          store.click(event.localRow, event.localCol);
        }}
      >
        {recoveryPending && snapshot.recovery ? (
          <NeovimRecoveryCard
            status={snapshot.recovery.status}
            swapFiles={snapshot.recovery.swapFiles}
            error={snapshot.recovery.error}
            discardArmed={recoveryDiscardArmed}
            onRecover={() => resolveRecovery("recover")}
            onCompare={() => resolveRecovery("compare")}
            onSaveCopy={() => resolveRecovery("save-copy")}
            onDiscard={() => resolveRecovery("discard")}
          />
        ) : crashed ? (
          <NeovimCrashCard
            details={crashDetails}
            onRestart={() => restartAfterCrash("configured")}
            onRestartClean={() => restartAfterCrash("clean")}
            onUseInline={() => restartAfterCrash("inline")}
            onCopy={copyCrashDetails}
          />
        ) : topologyRecovery ? (
          <RecoveredTopologyCard
            mutation={topologyRecovery.mutation}
            armed={topologyRecoveryArmed}
            working={topologyRecoveryWorking}
            onResolve={resolveTopologyRecovery}
          />
        ) : snapshot.status === "loading" ? (
          <Text dimColor>Loading...</Text>
        ) : null}
        {!recoveryPending && !crashed && !topologyRecovery && terminal ? (
          <NeovimGridView
            terminal={terminal}
            focused={focused && mutationBlockedReason === null}
          />
        ) : !recoveryPending && !crashed && !topologyRecovery ? (
          visibleLines.map((line) => (
            <BufferLine
              key={line.number}
              line={line}
              snapshot={snapshot}
              width={contentSize.columns}
              focused={focused}
              highlightedText={highlightedLines.get(line.number)}
            />
          ))
        ) : null}
      </Box>
      <Box height={1}>
        <Text dimColor wrap="truncate-end">
          {recoveryPending
            ? recoveryDiscardArmed
              ? "Press D again to discard recovery  R recover  C compare  S save copy"
              : "R recover  C compare  S save copy  D discard"
            : crashed
              ? "R restart  K restart clean  I use inline  C copy details"
              : topologyRecovery
                ? topologyRecoveryWorking
                  ? "AUDITING UNKNOWN OUTCOME…"
                  : topologyRecoveryArmed
                    ? "Press U again to mark outcome unknown and resynchronize"
                    : "U review and resolve interrupted path operation"
                : mutationBlockedReason !== null
                  ? "EDITOR READ-ONLY  alt+h explorer  shift+tab composer  alt+q hide"
                  : terminal
                    ? `${terminal.mode.toUpperCase()}  ctrl+s save  ctrl+r redo${workbench.rail !== null ? "  alt+l AI" : ""}  alt+r rail  shift+tab composer  alt+z ${workbench.surfaceMaximized ? "restore" : "maximize"}  alt+h explorer  alt+e external`
                    : snapshot.vimCommandLine !== null
                      ? `:${snapshot.vimCommandLine}`
                      : snapshot.vimMode === "VISUAL"
                        ? "VISUAL  h/j/k/l move  y yank  d delete  c change  p paste  esc normal"
                        : snapshot.vimMode === "NORMAL"
                          ? "BASIC FALLBACK  v visual  y/p register  : command  i/a/o insert  ctrl+r rail  esc composer"
                          : "INSERT  esc normal"}
        </Text>
      </Box>
    </Box>
  );
}

export function isCodePredictionInsertMode(mode: string): boolean {
  const normalized = mode.trim().toLowerCase();
  return normalized === "i" || normalized.startsWith("insert");
}

export function bufferTabLabels(
  buffers: readonly BufferProviderBuffer[],
): ReadonlyMap<number, string> {
  const baseLabels = buffers.map((buffer) => {
    const path = buffer.filePath ?? buffer.name;
    return basename(path) || "[No Name]";
  });
  const counts = new Map<string, number>();
  for (const label of baseLabels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return new Map(
    buffers.map((buffer, index) => {
      const baseLabel = baseLabels[index] ?? "[No Name]";
      if ((counts.get(baseLabel) ?? 0) <= 1) {
        return [buffer.handle, baseLabel] as const;
      }
      const path = buffer.filePath ?? buffer.name;
      return [
        buffer.handle,
        path.length > 0 ? path : `[No Name] #${buffer.handle}`,
      ] as const;
    }),
  );
}

export function bufferSurfaceActiveIdentity(
  snapshot: Pick<
    BufferProviderSnapshot,
    "activeBufferHandle" | "buffers" | "filePath"
  >,
  hostPath: string | null,
): {
  readonly displayPath: string;
  readonly referencePath: string | null;
} {
  const active =
    snapshot.buffers.find(
      (buffer) => buffer.handle === snapshot.activeBufferHandle,
    ) ?? snapshot.buffers.find((buffer) => buffer.current);
  if (active) {
    const referencePath = active.filePath ?? active.absolutePath;
    if (referencePath) {
      return { displayPath: referencePath, referencePath };
    }
    if (active.name) {
      return { displayPath: active.name, referencePath: null };
    }
    const unnamedCount = snapshot.buffers.filter(
      (buffer) =>
        buffer.listed &&
        buffer.loaded &&
        buffer.bufferType === "" &&
        buffer.name.length === 0,
    ).length;
    return {
      displayPath:
        unnamedCount > 1 ? `[No Name] #${active.handle}` : "[No Name]",
      referencePath: null,
    };
  }
  const fallback = snapshot.filePath ?? hostPath;
  return {
    displayPath: fallback ?? "loading",
    referencePath: fallback,
  };
}

function rotateActiveTabFirst(
  buffers: readonly BufferProviderBuffer[],
): readonly BufferProviderBuffer[] {
  const activeIndex = buffers.findIndex((buffer) => buffer.current);
  if (activeIndex <= 0) return buffers;
  return [...buffers.slice(activeIndex), ...buffers.slice(0, activeIndex)];
}

function NeovimCrashCard({
  details,
  onRestart,
  onRestartClean,
  onUseInline,
  onCopy,
}: {
  readonly details: string;
  readonly onRestart: () => void;
  readonly onRestartClean: () => void;
  readonly onUseInline: () => void;
  readonly onCopy: () => void;
}): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text color="error" bold>
        Embedded Neovim stopped unexpectedly
      </Text>
      <Text dimColor wrap="wrap">
        {details}
      </Text>
      <Box flexDirection="row" marginTop={1}>
        <Box borderStyle="single" paddingX={1} onClick={onRestart}>
          <Text>R Restart</Text>
        </Box>
        <Box borderStyle="single" paddingX={1} onClick={onRestartClean}>
          <Text>K Restart clean</Text>
        </Box>
        <Box borderStyle="single" paddingX={1} onClick={onUseInline}>
          <Text>I Use inline</Text>
        </Box>
        <Box borderStyle="single" paddingX={1} onClick={onCopy}>
          <Text>C Copy details</Text>
        </Box>
      </Box>
    </Box>
  );
}

function RecoveredTopologyCard({
  mutation,
  armed,
  working,
  onResolve,
}: {
  readonly mutation: WorkspaceEditorRecoveredTopologyMutation;
  readonly armed: boolean;
  readonly working: boolean;
  readonly onResolve: () => void;
}): React.ReactElement {
  const paths = mutation.targets
    .map((target) => {
      const workspacePath = relative(mutation.workspaceRoot, target.path);
      const label = workspacePath.length > 0 ? workspacePath : ".";
      return `${label}${target.includeDescendants === true ? "/…" : ""}`;
    })
    .join(", ");
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text color="warning" bold>
        Interrupted Editor rename or delete needs reconciliation
      </Text>
      <Text dimColor wrap="wrap">
        {paths}
      </Text>
      {working ? (
        <Text>Persisting an unknown-outcome audit and resynchronizing…</Text>
      ) : armed ? (
        <Text color="warning" wrap="wrap">
          Press U again to record that the disk outcome is unknown. AgenC will
          keep the operation audited, reload affected clean buffers, and then
          resynchronize Editor authority.
        </Text>
      ) : (
        <Text dimColor wrap="wrap">
          AgenC cannot know whether this path operation reached disk before the
          prior process stopped. Inspect the paths above, then explicitly
          resolve the durable safety fence.
        </Text>
      )}
      <Box
        borderStyle="single"
        paddingX={1}
        marginTop={1}
        onClick={working ? undefined : onResolve}
      >
        <Text color={armed ? "warning" : undefined}>
          {working
            ? "Resolving…"
            : armed
              ? "U Confirm unknown outcome"
              : "U Resolve as unknown"}
        </Text>
      </Box>
    </Box>
  );
}

function NeovimRecoveryCard({
  status,
  swapFiles,
  error,
  discardArmed,
  onRecover,
  onCompare,
  onSaveCopy,
  onDiscard,
}: {
  readonly status: "pending" | "working";
  readonly swapFiles: readonly string[];
  readonly error?: string;
  readonly discardArmed: boolean;
  readonly onRecover: () => void;
  readonly onCompare: () => void;
  readonly onSaveCopy: () => void;
  readonly onDiscard: () => void;
}): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text color="warning" bold>
        Unresolved Neovim recovery data found
      </Text>
      <Text dimColor wrap="wrap">
        {swapFiles.map((path) => basename(path)).join(", ")}
      </Text>
      {error ? (
        <Text color="error" wrap="wrap">
          {error}
        </Text>
      ) : null}
      {status === "working" ? (
        <Text>Applying recovery choice…</Text>
      ) : discardArmed ? (
        <Text color="error">
          Press D again to permanently discard the recovery swap.
        </Text>
      ) : (
        <Text dimColor>
          Recover restores edits in BUFFER. Compare opens recovered and disk
          contents side by side. Save Copy preserves recovery without replacing
          disk. Discard restores disk.
        </Text>
      )}
      <Box flexDirection="row" marginTop={1}>
        <Box borderStyle="single" paddingX={1} onClick={onRecover}>
          <Text>R Recover</Text>
        </Box>
        <Box borderStyle="single" paddingX={1} onClick={onCompare}>
          <Text>C Compare</Text>
        </Box>
        <Box borderStyle="single" paddingX={1} onClick={onSaveCopy}>
          <Text>S Save Copy</Text>
        </Box>
        <Box borderStyle="single" paddingX={1} onClick={onDiscard}>
          <Text color={discardArmed ? "error" : undefined}>D Discard</Text>
        </Box>
      </Box>
    </Box>
  );
}

export function formatProviderCrashDetails(exit: {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrTail: string;
}): string {
  const summary =
    [
      exit.signal ? `signal ${exit.signal}` : null,
      exit.code !== null ? `exit ${exit.code}` : null,
    ]
      .filter(Boolean)
      .join(", ") || "exit status unavailable";
  return exit.stderrTail ? `${summary}\n${exit.stderrTail}` : summary;
}

export function wheelInputIsInsideNode(
  event: InputEvent,
  node: DOMElement | null,
): boolean {
  // Implementation moved to ./wheelInput.js (kept as a re-export so existing
  // imports from this module keep working).
  return wheelInputIsInsideNodeImpl(event, node);
}

export function isBufferHostSaveInput(
  input: string,
  key: {
    readonly ctrl: boolean;
    readonly shift: boolean;
    readonly meta: boolean;
    readonly super: boolean;
  },
): boolean {
  return (
    input.toLowerCase() === "s" &&
    key.ctrl &&
    !key.shift &&
    !key.meta &&
    !key.super
  );
}

type BufferSurfaceStore = Pick<
  ReturnType<typeof getWorkbenchBufferProviderController>,
  | "save"
  | "revert"
  | "openExternalEditor"
  | "undo"
  | "redo"
  | "move"
  | "requestHover"
  | "goToDefinition"
>;

export type BufferSurfaceActionOptions = {
  readonly store: BufferSurfaceStore;
  readonly snapshot: ReturnType<typeof useBufferStore>;
  readonly hasInFlightAgent: boolean;
  readonly dispatch: (command: WorkbenchCommand) => void;
  /** Whether the Editor currently has a transcript/proposal rail to focus. */
  readonly railOpen?: boolean;
  /** Fail-closed daemon authority gate for provider-mutating actions. */
  readonly mutationBlocked?: boolean;
};

export function createBufferSurfaceKeyHandlers({
  store,
  snapshot,
  hasInFlightAgent,
  dispatch,
  railOpen = false,
  mutationBlocked = false,
}: BufferSurfaceActionOptions): Record<
  string,
  () => void | false | Promise<void>
> {
  return {
    "buffer:save": () => {
      if (mutationBlocked) return;
      void store.save({ hasInFlightAgent }).catch(logError);
    },
    "workbench:focusExplorer": () => {
      dispatch({ type: "focus", pane: "explorer" });
    },
    "workbench:focusAgents": () => {
      dispatch({ type: "focus", pane: "agents" });
    },
    "workbench:focusRail": () => {
      // Preserve Neovim's native Alt+L mapping when there is no host panel.
      // Once Explain/Ask/a proposal opens the panel, Alt+L crosses the
      // explicit host boundary and moves focus into its pager.
      if (!railOpen) return false;
      dispatch({ type: "focus", pane: "rail" });
    },
    "workbench:focusComposer": () => {
      dispatch({ type: "focus", pane: "composer" });
    },
    "workbench:toggleSurfaceMaximized": () => {
      dispatch({ type: "toggleSurfaceMaximized" });
    },
    // The inline editor uses Ctrl+R for the review rail; embedded Neovim uses
    // Alt+R so its native Ctrl+R redo reaches the provider. The dirty-buffer
    // guard still protects unsaved edits via applyWorkbenchCommand.
    "workbench:toggleFileRail": () => {
      const path = snapshot.filePath;
      if (path === null) return;
      dispatch({ type: "moveFileToRail", path });
    },
    "buffer:revert": () => {
      if (mutationBlocked) return;
      if (snapshot.provider.capabilities.terminalUi) return false;
      void store.revert().catch(logError);
    },
    "buffer:close": () => {
      dispatch({ type: "closeSurface" });
    },
    "buffer:closeDiscard": () => {
      // Deliberately route through the same reviewed leave transaction. A
      // single shortcut must never bypass the double-confirmed Discard All.
      dispatch({ type: "closeSurface" });
    },
    "buffer:externalEditor": () => {
      if (mutationBlocked) return;
      void store.openExternalEditor().catch(logError);
    },
    "buffer:undo": () => {
      if (mutationBlocked) return;
      return snapshot.provider.capabilities.terminalUi ? false : store.undo();
    },
    // Inline fallback owns this host redo action. Embedded Neovim's native
    // Ctrl+R is deliberately passed through by BufferHost instead.
    "buffer:redo": () => {
      if (mutationBlocked) return;
      return store.redo();
    },
    "buffer:hover": () => {
      if (snapshot.provider.capabilities.terminalUi) return false;
      void store.requestHover().catch(logError);
    },
    "buffer:definition": () => {
      if (snapshot.provider.capabilities.terminalUi) return false;
      void store.goToDefinition().catch(logError);
    },
    "buffer:passthrough": () => false,
    "buffer:up": () => store.move("up"),
    "buffer:down": () => store.move("down"),
    "buffer:left": () => store.move("left"),
    "buffer:right": () => store.move("right"),
    "buffer:pageUp": () =>
      store.move("up", { pageSize: Math.max(1, snapshot.viewportRows - 1) }),
    "buffer:pageDown": () =>
      store.move("down", { pageSize: Math.max(1, snapshot.viewportRows - 1) }),
    "buffer:lineStart": () => store.move("lineStart"),
    "buffer:lineEnd": () => store.move("lineEnd"),
    "buffer:top": () => store.move("top"),
    "buffer:bottom": () => store.move("bottom"),
    "buffer:selectUp": () => store.move("up", { extend: true }),
    "buffer:selectDown": () => store.move("down", { extend: true }),
    "buffer:selectLeft": () => store.move("left", { extend: true }),
    "buffer:selectRight": () => store.move("right", { extend: true }),
    "buffer:selectLineStart": () => store.move("lineStart", { extend: true }),
    "buffer:selectLineEnd": () => store.move("lineEnd", { extend: true }),
  };
}

export function executeBufferVimCommand(
  command: BufferVimCommand,
  {
    store,
    dispatch,
    hasInFlightAgent,
  }: Pick<
    BufferSurfaceActionOptions,
    "store" | "dispatch" | "hasInFlightAgent"
  >,
): void {
  switch (command.type) {
    case "save":
      void store
        .save({ hasInFlightAgent, force: command.force })
        .catch(logError);
      break;
    case "quit":
      dispatch({ type: "closeSurface" });
      break;
    case "saveQuit":
      void (async () => {
        const saved = await store.save({
          hasInFlightAgent,
          force: command.force,
        });
        if (saved) dispatch({ type: "closeSurface" });
      })().catch(logError);
      break;
  }
}

export function bufferStatusLabel(
  snapshot: ReturnType<typeof useBufferStore>,
  hasInFlightAgent: boolean,
): string {
  const parts = [snapshot.status];
  if (snapshot.dirty) parts.push("dirty");
  if (hasInFlightAgent) parts.push("agent");
  if (snapshot.encoding) parts.push(snapshot.encoding);
  if (snapshot.lineEndings) parts.push(snapshot.lineEndings);
  return parts.join(", ");
}

export function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function diagnosticCoversLine(
  diagnostic: DiagnosticEntry,
  line: number,
): boolean {
  const range = diagnostic.range;
  if (!range) return false;
  const targetLine = line - 1;
  const startLine = range.start.line;
  const endLine =
    range.end.line > startLine && range.end.character === 0
      ? range.end.line - 1
      : range.end.line;
  return targetLine >= startLine && targetLine <= endLine;
}

function useBufferHighlightedLines(
  filePath: string | null,
  visibleLines: readonly BufferVisibleLine[],
): ReadonlyMap<number, string> {
  const [highlightedLines, setHighlightedLines] =
    useState<ReadonlyMap<number, string>>(EMPTY_HIGHLIGHTS);
  const highlightKey = useMemo(
    () =>
      `${filePath ?? ""}\u0000${visibleLines.map((line) => `${line.number}:${line.text}`).join("\u0000")}`,
    [filePath, visibleLines],
  );
  const linesForHighlight = useMemo(
    () => visibleLines.map((line) => ({ ...line })),
    [highlightKey],
  );

  useEffect(() => {
    let active = true;
    setHighlightedLines(EMPTY_HIGHLIGHTS);
    void highlightBufferVisibleLines(filePath, linesForHighlight).then(
      (result) => {
        if (active) setHighlightedLines(result);
      },
    );
    return () => {
      active = false;
    };
  }, [filePath, highlightKey, linesForHighlight]);

  return highlightedLines;
}
