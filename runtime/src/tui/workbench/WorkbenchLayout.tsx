// @ts-nocheck
import React, { useMemo } from "react";

import { Box, Text } from "../ink.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { useKeybindings } from "../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../keybindings/KeybindingContext.js";
import { PromptDialogOverlay, PromptSuggestionsOverlay } from "../components/PromptOverlaySurfaces.js";
import type { PendingRequest } from "../permission-requests.js";
import { AgentsRail } from "./agents/AgentsRail.js";
import { ProjectExplorer } from "./project-tree/ProjectExplorer.js";
import { ActiveWorkSurface } from "./surfaces/ActiveWorkSurface.js";
import { WorkbenchComposerFocusProvider } from "./composerFocusContext.js";
import { useWorkbenchDispatch, useWorkbenchState } from "./state.js";
import type { WorkbenchLayoutSize, WorkbenchPane } from "./types.js";
import { WorkbenchFooter } from "./WorkbenchFooter.js";
import { WorkbenchStatusBar } from "./WorkbenchStatusBar.js";

type Props = {
  readonly transcript: React.ReactNode;
  readonly composer: React.ReactNode;
  readonly overlay?: React.ReactNode;
  readonly modal?: React.ReactNode;
  readonly pendingApproval?: PendingRequest | null;
};

export function WorkbenchLayout({
  transcript,
  composer,
  overlay,
  modal,
  pendingApproval,
}: Props): React.ReactElement {
  const { columns, rows } = useTerminalSize();
  const workbench = useWorkbenchState();
  const dispatch = useWorkbenchDispatch();
  const layoutSize = layoutSizeForColumns(columns);
  const showExplorer = workbench.explorerVisible && layoutSize !== "narrow";
  const showAgents = workbench.agentsVisible && layoutSize === "wide";
  const visiblePanes = useMemo(
    () => visiblePaneList(showExplorer, showAgents),
    [showExplorer, showAgents],
  );

  useRegisterKeybindingContext("Workbench", true);
  useRegisterKeybindingContext("Composer", workbench.focusedPane === "composer");
  useKeybindings(
    {
      "workbench:focusExplorer": () => dispatch({ type: "focus", pane: "explorer" }),
      "workbench:focusSurface": () => dispatch({ type: "focus", pane: nextRightPane(workbench.focusedPane, showAgents) }),
      "workbench:focusAgents": () => dispatch({ type: "focus", pane: "agents" }),
      "workbench:focusComposer": () => dispatch({ type: "focus", pane: "composer" }),
      "workbench:focusUp": () => dispatch({ type: "focus", pane: "surface" }),
      "workbench:focusNext": () => dispatch({ type: "focusNext", visiblePanes }),
      "workbench:openDiff": () => dispatch({ type: "openDiff", focus: true }),
      "workbench:openSearch": () => dispatch({ type: "openSearch" }),
    },
    { context: "Workbench", isActive: true },
  );

  const explorerWidth = layoutSize === "wide" ? 30 : 26;
  const agentsWidth = 30;

  return (
    <Box flexDirection="column" width="100%" height={rows} overflow="hidden">
      {rows >= 8 ? <WorkbenchStatusBar columns={columns} /> : null}
      <Box flexDirection="row" flexGrow={1} overflow="hidden">
        {showExplorer ? <ProjectExplorer focused={workbench.focusedPane === "explorer"} width={explorerWidth} /> : null}
        <ActiveWorkSurface focused={workbench.focusedPane === "surface"} transcript={transcript} pendingApproval={pendingApproval} />
        {showAgents ? <AgentsRail focused={workbench.focusedPane === "agents"} width={agentsWidth} /> : null}
      </Box>
      {overlay ? (
        <Box flexDirection="column" borderColor="warning" borderTop paddingX={1}>
          {overlay}
        </Box>
      ) : null}
      <Box flexDirection="column" flexShrink={0} borderTop borderColor={workbench.focusedPane === "composer" ? "suggestion" : "gray"}>
        <PromptSuggestionsOverlay />
        <WorkbenchComposerFocusProvider active={workbench.focusedPane === "composer"}>
          {composer}
        </WorkbenchComposerFocusProvider>
      </Box>
      <PromptDialogOverlay />
      {rows >= 5 ? <WorkbenchFooter /> : null}
      {layoutSize !== "wide" && workbench.focusedPane === "agents" ? (
        <Box position="absolute" right={0} top={1} bottom={2} width={Math.min(34, columns)} opaque>
          <AgentsRail focused={true} width={Math.min(34, columns)} />
        </Box>
      ) : null}
      {layoutSize === "narrow" && workbench.focusedPane === "explorer" ? (
        <Box position="absolute" left={0} top={1} bottom={2} width={Math.min(34, columns)} opaque>
          <ProjectExplorer focused={true} width={Math.min(34, columns)} />
        </Box>
      ) : null}
      {modal ? (
        <Box position="absolute" left={0} right={0} bottom={0} flexDirection="column" opaque borderTop borderColor="gray" paddingX={1}>
          {modal}
        </Box>
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
