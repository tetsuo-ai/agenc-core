import React, { useMemo, type RefObject } from "react";

import { Box, NoSelect, Text } from "../ink.js";
import { ModalContext } from "../context/modalContext.js";
import { ContentWidthProvider } from "../context/contentWidthContext.js";
import { useAppState } from "../state/AppState.js";
import type { ScrollBoxHandle } from "../ink/components/ScrollBox.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { useKeybindings } from "../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../keybindings/KeybindingContext.js";
import {
  PromptDialogOverlay,
  PromptSuggestionsOverlay,
} from "../components/PromptOverlaySurfaces.js";
import type { PendingRequest } from "../permission-requests.js";
import type { SpinnerMode } from "../components/spinner/types.js";
import { AgentsRail } from "./agents/AgentsRail.js";
import { DiffSurface } from "./surfaces/DiffSurface.js";
import { PreviewSurface } from "./surfaces/PreviewSurface.js";
import { TranscriptSurface } from "./surfaces/TranscriptSurface.js";
import { ProjectExplorer } from "./project-tree/ProjectExplorer.js";
import { ActiveWorkSurface } from "./surfaces/ActiveWorkSurface.js";
import type {
  BufferCodePredictionUi,
  BufferStaleAuthorityRecoveryUi,
  BufferTopologyRecoveryUi,
} from "./surfaces/BufferSurface.js";
import { WorkbenchComposerFocusProvider } from "./composerFocusContext.js";
import { visibleWorkbenchPane } from "./reducer.js";
import { useWorkbenchDispatch, useWorkbenchState } from "./state.js";
import { WorkbenchTranscriptLayoutProvider } from "./transcriptLayoutContext.js";
import type {
  WorkbenchLayoutSize,
  WorkbenchPane,
  WorkbenchRail,
} from "./types.js";
import { WorkbenchFooter } from "./WorkbenchFooter.js";
import { WorkbenchStatusBar } from "./WorkbenchStatusBar.js";
import { DirtyBufferLeaveOverlay } from "./DirtyBufferLeaveOverlay.js";
import { GitDetailOverlay } from "./GitDetailOverlay.js";
import { useProjectTree } from "./project-tree/useProjectTree.js";
import { WorkspaceTabs } from "./WorkspaceTabs.js";
import { EditorProposalRail } from "./EditorProposalRail.js";
import type { BufferIntegrationIntent } from "./buffer/providers/types.js";
import type { ModelDisplayReadContext } from "../../utils/model/model.js";

type Props = {
  readonly transcript: React.ReactNode;
  readonly composer: React.ReactNode;
  readonly overlay?: React.ReactNode;
  readonly modal?: React.ReactNode;
  readonly modalScrollRef?: RefObject<ScrollBoxHandle | null>;
  readonly pendingApproval?: PendingRequest | null;
  readonly scrollRef?: RefObject<ScrollBoxHandle | null>;
  /** Independent scroll owner for the Editor AI/review panel. */
  readonly panelScrollRef?: RefObject<ScrollBoxHandle | null>;
  /**
   * Cold-start/empty transcript. Forwarded to the transcript surface so the
   * welcome hero starts at the top instead of being pinned to the bottom on a
   * short viewport. See TranscriptSurface for the full rationale.
   */
  readonly atWelcome?: boolean;
  /**
   * Current streaming phase, or null when the session is idle. Drives the
   * always-visible "working" indicator in the status bar.
   */
  readonly activityMode?: SpinnerMode | null;
  /**
   * Real context-window usage label (e.g. "ctx 42%") computed by the caller
   * from the last assistant usage block; null when no usage data exists yet.
   * Rendered in the status bar between the model and runtime version.
   */
  readonly contextPctLabel?: string | null;
  readonly modelDisplayContext?: ModelDisplayReadContext;
  /** Live cumulative spend projected from bridge `token_count` events. */
  readonly sessionCostUsd?: number;
  readonly onEditorInteraction?: (intent: BufferIntegrationIntent) => void;
  readonly codePrediction?: BufferCodePredictionUi;
  readonly editorMutationBlockedReason?: string | null;
  readonly editorTopologyRecovery?: BufferTopologyRecoveryUi;
  readonly editorStaleAuthorityRecovery?: BufferStaleAuthorityRecoveryUi;
};

export function WorkbenchLayout({
  transcript,
  composer,
  overlay,
  modal,
  modalScrollRef,
  pendingApproval,
  scrollRef,
  panelScrollRef,
  atWelcome,
  activityMode = null,
  contextPctLabel = null,
  modelDisplayContext,
  sessionCostUsd = 0,
  onEditorInteraction,
  codePrediction,
  editorMutationBlockedReason = null,
  editorTopologyRecovery,
  editorStaleAuthorityRecovery,
}: Props): React.ReactElement {
  const { columns, rows } = useTerminalSize();
  const workbench = useWorkbenchState();
  const dispatch = useWorkbenchDispatch();
  const projectTree = useProjectTree();
  const layoutSize = layoutSizeForColumns(columns);
  const focusedPane = visibleWorkbenchPane(workbench);
  const editorOwnsKeys =
    workbench.activeWorkspaceView === "editor" &&
    focusedPane === "surface" &&
    workbench.activeSurfaceMode === "buffer";
  // The outer shell owns one row of breathing room above and below the frame
  // when the viewport can afford it. Give the framed workbench an explicit
  // drawable height instead of `100%`: percentage height plus padding can
  // extend the bottom border past the live terminal viewport. Tiny terminals
  // drop the decorative inset and shortcut strip so the work surface and
  // composer retain usable rows.
  const showFullChrome = rows >= 14;
  const frameRows = Math.max(1, rows - (showFullChrome ? 2 : 0));
  const surfaceMaximized =
    workbench.surfaceMaximized && workbench.activeSurfaceMode === "buffer";
  // One terminal-cell breathing room around the frame plus the frame's own
  // left/right border leaves four columns unavailable to the pane grid.
  const frameColumns = Math.max(1, columns - 4);
  // Keep completion popups inside the framed workbench on short terminals.
  // Four rows belong to the outer padding/frame; at most half of the remaining
  // content may float above the composer.
  const suggestionOverlayRows = Math.max(
    0,
    Math.ceil(Math.max(0, rows - 4) / 2),
  );
  // The reference uses a balanced 20 / 61 / 19 split. Keeping the side rails
  // proportional on ultrawide terminals avoids the old tiny-islands-at-the-
  // edges look while the minimums preserve usability at the wide breakpoint.
  const explorerWidth =
    layoutSize === "wide" ? Math.max(26, Math.floor(frameColumns * 0.2)) : 26;
  const agentsWidth = Math.max(24, Math.floor(frameColumns * 0.19));
  const showExplorer =
    !surfaceMaximized && workbench.explorerVisible && layoutSize !== "narrow";
  // The Agents rail auto-hides only while the REVIEW rail is open and there
  // are no agent tasks to show: an empty "No background agents" column next
  // to a file under review is dead space the file can use. Without a review
  // rail open, the Agents rail keeps its always-on contract in wide layouts.
  const hasAgentTasks = useAppState((s) =>
    Object.values(s.tasks ?? {}).some(
      (task: any) => task.type !== "local_bash",
    ),
  );
  const showAgents =
    workbench.activeWorkspaceView === "agent" &&
    !surfaceMaximized &&
    workbench.agentsVisible &&
    layoutSize === "wide" &&
    (hasAgentTasks || workbench.rail === null);
  // Wide terminals dock the rail beside the buffer. Medium/narrow terminals
  // keep the same rail as a full-height overlay; it remains a real focusable
  // pane in both layouts.
  const railAvailable = !surfaceMaximized && workbench.rail !== null;
  const showRail = railAvailable && layoutSize === "wide";
  // Review rail width: share the space fairly with the chat instead of a
  // fixed narrow strip. 45% of the terminal, clamped below by the original
  // 44-col rail and above so the chat always keeps a workable ~46 columns
  // (and the rail never gets absurd on ultrawide).
  const railWidth = showRail
    ? Math.min(
        88,
        Math.max(44, Math.floor(frameColumns * 0.45)),
        frameColumns -
          (showExplorer ? explorerWidth : 0) -
          (showAgents ? agentsWidth : 0) -
          46,
      )
    : 44;
  const surfaceWidth = Math.max(
    1,
    frameColumns -
      (showExplorer ? explorerWidth : 0) -
      (showAgents ? agentsWidth : 0) -
      (showRail ? railWidth : 0),
  );
  const surfaceContentWidth = Math.max(1, surfaceWidth - 2);
  const visiblePanes = useMemo(
    () => visiblePaneList(showExplorer, showAgents, railAvailable),
    [railAvailable, showAgents, showExplorer],
  );

  useRegisterKeybindingContext("Workbench", !editorOwnsKeys);
  useRegisterKeybindingContext("Composer", focusedPane === "composer");
  useKeybindings(
    {
      "workbench:focusExplorer": () =>
        dispatch({
          type: "focus",
          pane: nextLeftPane(focusedPane, showExplorer, railAvailable),
        }),
      "workbench:focusSurface": () =>
        dispatch({
          type: "focus",
          pane: nextRightPane(focusedPane, railAvailable, showAgents),
        }),
      "workbench:focusRail": () => {
        if (!railAvailable) return false;
        dispatch({ type: "focus", pane: "rail" });
      },
      "workbench:focusAgents": () =>
        dispatch({ type: "focus", pane: "agents" }),
      "workbench:focusComposer": () =>
        dispatch({ type: "focus", pane: "composer" }),
      "workbench:focusUp": () => dispatch({ type: "focus", pane: "surface" }),
      "workbench:focusNext": () =>
        dispatch({ type: "focusNext", visiblePanes }),
      "workbench:openDiff": () => dispatch({ type: "openDiff", focus: true }),
      "workbench:openSearch": () => dispatch({ type: "openSearch" }),
      // ctrl+r — move the open file into the right-hand review rail (or close
      // it): the chat keeps the center pane so the user can chat, code, and
      // review the file at the same time.
      "workbench:toggleFileRail": () => {
        if (workbench.rail !== null) {
          dispatch({ type: "toggleFileRail" });
          return;
        }
        const path = workbench.activeFilePath;
        if (path === null) return;
        if (workbench.activeWorkspaceView === "editor") {
          dispatch({ type: "toggleFileRail", path });
          dispatch({ type: "focus", pane: "rail" });
          return;
        }
        if (workbench.activeSurfaceMode === "preview") {
          dispatch({ type: "moveFileToRail", path });
          return;
        }
        dispatch({ type: "toggleFileRail", path });
        dispatch({ type: "focus", pane: "composer" });
      },
    },
    { context: "Workbench", isActive: !editorOwnsKeys },
  );

  return (
    <Box
      width="100%"
      height={rows}
      paddingX={1}
      paddingY={showFullChrome ? 1 : 0}
      backgroundColor="#000000"
    >
      <Box
        flexDirection="column"
        width="100%"
        height={frameRows}
        overflow="hidden"
        backgroundColor="#000000"
        borderStyle="single"
        borderColor="lineSoft"
      >
        {rows >= 8 ? (
          <WorkbenchStatusBar
            activityMode={activityMode}
            columns={frameColumns}
            contextPctLabel={contextPctLabel}
            modelDisplayContext={modelDisplayContext}
          />
        ) : null}
        <WorkspaceTabs
          activityMode={activityMode}
          pendingApproval={pendingApproval != null}
          columns={frameColumns}
          hidden={rows < 8}
        />
        <Box
          flexDirection="row"
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          minHeight={0}
          overflow="hidden"
        >
          {showExplorer ? (
            <NoSelect flexShrink={0} width={explorerWidth} height="100%">
              <ProjectExplorer
                focused={focusedPane === "explorer"}
                width={explorerWidth}
              />
            </NoSelect>
          ) : null}
          <ContentWidthProvider width={surfaceContentWidth}>
            <ActiveWorkSurface
              focused={focusedPane === "surface"}
              transcript={transcript}
              pendingApproval={pendingApproval}
              scrollRef={scrollRef}
              atWelcome={atWelcome}
              onEditorInteraction={onEditorInteraction}
              codePrediction={codePrediction}
              editorMutationBlockedReason={editorMutationBlockedReason}
              editorTopologyRecovery={editorTopologyRecovery}
              editorStaleAuthorityRecovery={editorStaleAuthorityRecovery}
            />
          </ContentWidthProvider>
          {showRail ? (
            <NoSelect
              flexShrink={0}
              width={railWidth}
              height="100%"
              onClick={(event) => {
                event.stopImmediatePropagation();
                dispatch({ type: "focus", pane: "rail" });
              }}
            >
              <WorkbenchRailSurface
                rail={workbench.rail!}
                focused={focusedPane === "rail"}
                transcript={transcript}
                pendingApproval={pendingApproval}
                scrollRef={
                  workbench.activeWorkspaceView === "editor"
                    ? panelScrollRef
                    : scrollRef
                }
              />
            </NoSelect>
          ) : null}
          {showAgents ? (
            <NoSelect flexShrink={0} width={agentsWidth} height="100%">
              <AgentsRail
                focused={focusedPane === "agents"}
                width={agentsWidth}
                sessionCostUsd={sessionCostUsd}
              />
            </NoSelect>
          ) : null}
        </Box>
        {overlay ? (
          <Box
            flexDirection="column"
            borderColor="warning"
            borderTop
            paddingX={1}
          >
            {overlay}
          </Box>
        ) : null}
        {!surfaceMaximized ? (
          <Box
            flexDirection="column"
            flexShrink={0}
            paddingTop={1}
            backgroundColor="#000000"
            borderTop
            borderTopColor="lineSoft"
            opaque
          >
            <PromptSuggestionsOverlay
              availableColumns={frameColumns}
              availableRows={suggestionOverlayRows}
            />
            <ContentWidthProvider width={frameColumns}>
              <WorkbenchComposerFocusProvider
                active={focusedPane === "composer"}
              >
                {composer}
              </WorkbenchComposerFocusProvider>
            </ContentWidthProvider>
          </Box>
        ) : null}
        <PromptDialogOverlay />
        {showFullChrome && !surfaceMaximized ? <WorkbenchFooter /> : null}
        {!surfaceMaximized &&
        workbench.activeWorkspaceView === "agent" &&
        layoutSize !== "wide" &&
        workbench.agentsVisible &&
        focusedPane === "agents" ? (
          <Box
            position="absolute"
            right={0}
            top={3}
            bottom={2}
            width={Math.min(34, frameColumns)}
            opaque
          >
            <NoSelect width={Math.min(34, frameColumns)} height="100%">
              <AgentsRail
                focused={true}
                width={Math.min(34, frameColumns)}
                sessionCostUsd={sessionCostUsd}
              />
            </NoSelect>
          </Box>
        ) : null}
        {!surfaceMaximized &&
        layoutSize === "narrow" &&
        workbench.explorerVisible &&
        focusedPane === "explorer" ? (
          <Box
            position="absolute"
            left={0}
            top={3}
            bottom={2}
            width={Math.min(34, frameColumns)}
            opaque
          >
            <NoSelect width={Math.min(34, frameColumns)} height="100%">
              <ProjectExplorer
                focused={true}
                width={Math.min(34, frameColumns)}
              />
            </NoSelect>
          </Box>
        ) : null}
        {railAvailable && !showRail && focusedPane === "rail" ? (
          <Box
            position="absolute"
            right={0}
            top={3}
            bottom={2}
            width={Math.min(
              layoutSize === "narrow" ? frameColumns : 64,
              frameColumns,
            )}
            opaque
            borderLeft
            borderColor="lineSoft"
            backgroundColor="surfaceBackground"
          >
            <NoSelect
              width="100%"
              height="100%"
              onClick={(event) => {
                event.stopImmediatePropagation();
                dispatch({ type: "focus", pane: "rail" });
              }}
            >
              <WorkbenchRailSurface
                rail={workbench.rail}
                focused={focusedPane === "rail"}
                transcript={transcript}
                pendingApproval={pendingApproval}
                scrollRef={
                  workbench.activeWorkspaceView === "editor"
                    ? panelScrollRef
                    : scrollRef
                }
              />
            </NoSelect>
          </Box>
        ) : null}
        {modal ? (
          <ModalContext
            value={{
              rows: Math.max(0, rows - 6),
              columns: Math.max(0, frameColumns - 2),
              scrollRef: modalScrollRef ?? null,
            }}
          >
            <Box
              position="absolute"
              left={0}
              right={0}
              bottom={0}
              flexDirection="column"
              opaque
              borderTop
              borderColor="lineSoft"
              paddingX={1}
            >
              {modal}
            </Box>
          </ModalContext>
        ) : null}
        {workbench.pendingBlockedOverlay ? (
          <Box
            position="absolute"
            left={0}
            right={0}
            top={3}
            flexDirection="column"
            opaque
            borderColor="warning"
            borderBottom
            paddingX={1}
          >
            <DirtyBufferLeaveOverlay />
          </Box>
        ) : null}
        {workbench.gitPanelOpen ? (
          <Box
            position="absolute"
            left={0}
            right={0}
            top={3}
            flexDirection="column"
            opaque
            borderColor="agenc"
            borderBottom
            paddingX={1}
          >
            <GitDetailOverlay
              cwd={projectTree.cwd}
              git={projectTree.git}
              onClose={() => dispatch({ type: "toggleGitPanel", open: false })}
            />
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

function WorkbenchRailSurface({
  rail,
  focused,
  transcript,
  pendingApproval,
  scrollRef,
}: {
  readonly rail: Exclude<WorkbenchRail, null>;
  readonly focused: boolean;
  readonly transcript: React.ReactNode;
  readonly pendingApproval?: PendingRequest | null;
  readonly scrollRef?: RefObject<ScrollBoxHandle | null>;
}): React.ReactElement {
  switch (rail.kind) {
    case "file":
      return <PreviewSurface focused={focused} pathOverride={rail.path} />;
    case "transcript":
      return (
        <Box
          flexDirection="column"
          width="100%"
          height="100%"
          overflow="hidden"
        >
          <Box
            flexShrink={0}
            paddingX={1}
            borderBottom
            borderColor={focused ? "text" : "lineSoft"}
          >
            <Text
              bold={focused}
              color={focused ? "text" : "inactive"}
              wrap="truncate-end"
            >
              {focused
                ? "AI · PgUp/PgDn scroll · Ctrl+W H editor"
                : "AI · Alt+L focus and scroll"}
            </Text>
          </Box>
          <WorkbenchTranscriptLayoutProvider>
            <TranscriptSurface scrollRef={scrollRef}>
              {transcript}
            </TranscriptSurface>
          </WorkbenchTranscriptLayoutProvider>
        </Box>
      );
    case "change-review":
      return (
        <DiffSurface focused={focused} pendingApproval={pendingApproval} />
      );
    case "editor-proposal":
      return (
        <EditorProposalRail
          proposalId={rail.proposalId}
          focused={focused}
          scrollRef={scrollRef}
        />
      );
  }
}

export function layoutSizeForColumns(columns: number): WorkbenchLayoutSize {
  if (columns >= 130) return "wide";
  if (columns >= 100) return "medium";
  return "narrow";
}

function visiblePaneList(
  showExplorer: boolean,
  showAgents: boolean,
  railAvailable: boolean,
): readonly WorkbenchPane[] {
  return [
    ...(showExplorer ? ["explorer" as const] : []),
    "surface" as const,
    ...(railAvailable ? ["rail" as const] : []),
    ...(showAgents ? ["agents" as const] : []),
    "composer" as const,
  ];
}

function nextRightPane(
  current: WorkbenchPane,
  railAvailable: boolean,
  showAgents: boolean,
): WorkbenchPane {
  if (current === "explorer") return "surface";
  if (current === "surface" && railAvailable) return "rail";
  if (current === "surface" && showAgents) return "agents";
  if (current === "rail" && showAgents) return "agents";
  if (current === "composer") return "surface";
  return "surface";
}

function nextLeftPane(
  current: WorkbenchPane,
  showExplorer: boolean,
  railAvailable: boolean,
): WorkbenchPane {
  if (current === "rail") return "surface";
  if (current === "agents") return railAvailable ? "rail" : "surface";
  if (current === "surface" && showExplorer) return "explorer";
  if (current === "composer") return showExplorer ? "explorer" : "surface";
  return "surface";
}
