import React, { useMemo, type RefObject } from "react";

import { Box, NoSelect, Text } from "../ink.js";
import { ModalContext } from "../context/modalContext.js";
import { ContentWidthProvider } from "../context/contentWidthContext.js";
import type { ScrollBoxHandle } from "../ink/components/ScrollBox.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { useKeybindings } from "../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../keybindings/KeybindingContext.js";
import { PromptDialogOverlay, PromptSuggestionsOverlay } from "../components/PromptOverlaySurfaces.js";
import type { PendingRequest } from "../permission-requests.js";
import { AgentsRail } from "./agents/AgentsRail.js";
import { ProjectExplorer } from "./project-tree/ProjectExplorer.js";
import { ActiveWorkSurface } from "./surfaces/ActiveWorkSurface.js";
import { WorkbenchComposerFocusProvider } from "./composerFocusContext.js";
import { visibleWorkbenchPane } from "./reducer.js";
import { useWorkbenchDispatch, useWorkbenchState } from "./state.js";
import type { WorkbenchLayoutSize, WorkbenchPane } from "./types.js";
import { WorkbenchFooter } from "./WorkbenchFooter.js";
import { WorkbenchStatusBar } from "./WorkbenchStatusBar.js";

type Props = {
  readonly transcript: React.ReactNode;
  readonly composer: React.ReactNode;
  readonly overlay?: React.ReactNode;
  readonly modal?: React.ReactNode;
  readonly modalScrollRef?: RefObject<ScrollBoxHandle | null>;
  readonly pendingApproval?: PendingRequest | null;
  readonly scrollRef?: RefObject<ScrollBoxHandle | null>;
  /**
   * Cold-start/empty transcript. Forwarded to the transcript surface so the
   * welcome hero starts at the top instead of being pinned to the bottom on a
   * short viewport. See TranscriptSurface for the full rationale.
   */
  readonly atWelcome?: boolean;
};

export function WorkbenchLayout({
  transcript,
  composer,
  overlay,
  modal,
  modalScrollRef,
  pendingApproval,
  scrollRef,
  atWelcome,
}: Props): React.ReactElement {
  const { columns, rows } = useTerminalSize();
  const workbench = useWorkbenchState();
  const dispatch = useWorkbenchDispatch();
  const layoutSize = layoutSizeForColumns(columns);
  const focusedPane = visibleWorkbenchPane(workbench);
  const editorOwnsKeys = focusedPane === "surface" && workbench.activeSurfaceMode === "buffer";
  const explorerWidth = layoutSize === "wide" ? 30 : 26;
  const agentsWidth = 30;
  const showExplorer = workbench.explorerVisible && layoutSize !== "narrow";
  const showAgents = workbench.agentsVisible && layoutSize === "wide";
  const surfaceWidth = Math.max(
    1,
    columns - (showExplorer ? explorerWidth : 0) - (showAgents ? agentsWidth : 0),
  );
  const surfaceContentWidth = Math.max(1, surfaceWidth - 2);
  const visiblePanes = useMemo(
    () => visiblePaneList(showExplorer, showAgents),
    [showExplorer, showAgents],
  );

  useRegisterKeybindingContext("Workbench", !editorOwnsKeys);
  useRegisterKeybindingContext("Composer", focusedPane === "composer");
  useKeybindings(
    {
      "workbench:focusExplorer": () => dispatch({ type: "focus", pane: "explorer" }),
      "workbench:focusSurface": () => dispatch({ type: "focus", pane: nextRightPane(focusedPane, showAgents) }),
      "workbench:focusAgents": () => dispatch({ type: "focus", pane: "agents" }),
      "workbench:focusComposer": () => dispatch({ type: "focus", pane: "composer" }),
      "workbench:focusUp": () => dispatch({ type: "focus", pane: "surface" }),
      "workbench:focusNext": () => dispatch({ type: "focusNext", visiblePanes }),
      "workbench:openDiff": () => dispatch({ type: "openDiff", focus: true }),
      "workbench:openSearch": () => dispatch({ type: "openSearch" }),
    },
    { context: "Workbench", isActive: !editorOwnsKeys },
  );

  return (
    <Box flexDirection="column" width="100%" height={rows} overflow="hidden">
      {rows >= 8 ? <WorkbenchStatusBar /> : null}
      <Box flexDirection="row" flexGrow={1} overflow="hidden">
        {showExplorer ? (
          <NoSelect flexShrink={0} width={explorerWidth} height="100%">
            <ProjectExplorer focused={focusedPane === "explorer"} width={explorerWidth} />
          </NoSelect>
        ) : null}
        <ContentWidthProvider width={surfaceContentWidth}>
          <ActiveWorkSurface focused={focusedPane === "surface"} transcript={transcript} pendingApproval={pendingApproval} scrollRef={scrollRef} atWelcome={atWelcome} />
        </ContentWidthProvider>
        {showAgents ? (
          <NoSelect flexShrink={0} width={agentsWidth} height="100%">
            <AgentsRail focused={focusedPane === "agents"} width={agentsWidth} />
          </NoSelect>
        ) : null}
      </Box>
      {overlay ? (
        <Box flexDirection="column" borderColor="warning" borderTop paddingX={1}>
          {overlay}
        </Box>
      ) : null}
      <Box flexDirection="column" flexShrink={0} borderTop borderColor={focusedPane === "composer" ? "suggestion" : "gray"}>
        <PromptSuggestionsOverlay />
        <WorkbenchComposerFocusProvider active={focusedPane === "composer"}>
          {composer}
        </WorkbenchComposerFocusProvider>
      </Box>
      <PromptDialogOverlay />
      {rows >= 5 ? <WorkbenchFooter /> : null}
      {layoutSize !== "wide" && workbench.agentsVisible && focusedPane === "agents" ? (
        <Box position="absolute" right={0} top={1} bottom={2} width={Math.min(34, columns)} opaque>
          <NoSelect width={Math.min(34, columns)} height="100%">
            <AgentsRail focused={true} width={Math.min(34, columns)} />
          </NoSelect>
        </Box>
      ) : null}
      {layoutSize === "narrow" && workbench.explorerVisible && focusedPane === "explorer" ? (
        <Box position="absolute" left={0} top={1} bottom={2} width={Math.min(34, columns)} opaque>
          <NoSelect width={Math.min(34, columns)} height="100%">
            <ProjectExplorer focused={true} width={Math.min(34, columns)} />
          </NoSelect>
        </Box>
      ) : null}
      {modal ? (
        <ModalContext value={{
          rows: Math.max(0, rows - 4),
          columns: Math.max(0, columns - 2),
          scrollRef: modalScrollRef ?? null,
        }}>
          <Box position="absolute" left={0} right={0} bottom={0} flexDirection="column" opaque borderTop borderColor="gray" paddingX={1}>
            {modal}
          </Box>
        </ModalContext>
      ) : null}
      {workbench.pendingBlockedOverlay ? (
        <Box position="absolute" left={0} right={0} top={1} flexDirection="column" opaque borderColor="warning" borderBottom paddingX={1}>
          <Text color="warning" wrap="truncate-end">
            Approval required before {workbench.pendingBlockedOverlay.attemptedAction}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function layoutSizeForColumns(columns: number): WorkbenchLayoutSize {
  if (columns >= 130) return "wide";
  if (columns >= 100) return "medium";
  return "narrow";
}

function visiblePaneList(showExplorer: boolean, showAgents: boolean): readonly WorkbenchPane[] {
  return [
    ...(showExplorer ? ["explorer" as const] : []),
    "surface" as const,
    ...(showAgents ? ["agents" as const] : []),
    "composer" as const,
  ];
}

function nextRightPane(current: WorkbenchPane, showAgents: boolean): WorkbenchPane {
  if (current === "explorer") return "surface";
  if (current === "surface" && showAgents) return "agents";
  return "surface";
}
