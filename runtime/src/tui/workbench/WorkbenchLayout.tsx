import React, { useMemo, type RefObject } from "react";

import { Box, NoSelect, Text } from "../ink.js";
import { ModalContext } from "../context/modalContext.js";
import { ContentWidthProvider } from "../context/contentWidthContext.js";
import { useAppState, useAppStateMaybeOutsideOfProvider } from "../state/AppState.js";
import type { AppState } from "../state/AppStateStore.js";
import {
  getDefaultMainLoopModelSetting,
  parseUserSpecifiedModel,
  renderModelName,
} from "../../utils/model/model.js";
import { permissionModeShortTitle } from "../../permissions/mode-display.js";
import type { PermissionMode } from "../../permissions/types.js";
import type { ScrollBoxHandle } from "../ink/components/ScrollBox.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { useKeybindings } from "../keybindings/useKeybinding.js";
import { useRegisterKeybindingContext } from "../keybindings/KeybindingContext.js";
import { PromptDialogOverlay, PromptSuggestionsOverlay } from "../components/PromptOverlaySurfaces.js";
import type { PendingRequest } from "../permission-requests.js";
import type { SpinnerMode } from "../components/spinner/types.js";
import { AgentsRail } from "./agents/AgentsRail.js";
import { PreviewSurface } from "./surfaces/PreviewSurface.js";
import { isDangerousPermissionMode } from "./WorkbenchContextStrip.js";
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
  /**
   * Current streaming phase, or null when the session is idle. Drives the
   * always-visible "working" indicator in the status bar.
   */
  readonly activityMode?: SpinnerMode | null;
  /**
   * Real context-window usage label (e.g. "ctx 42%") computed by the caller
   * from the last assistant usage block; null when no usage data exists yet.
   * Rendered in the status bar next to the model/mode/cwd strip.
   */
  readonly contextPctLabel?: string | null;
};

function selectComposerMode(state: AppState): PermissionMode {
  return state.toolPermissionContext.mode;
}

function selectComposerModel(state: AppState): string {
  return (
    state.mainLoopModelForSession ??
    state.mainLoopModel ??
    getDefaultMainLoopModelSetting()
  );
}

/**
 * Always-visible composer context row: `mode · model · ctx%` directly above
 * the composer box — where the eyes already are while typing. The top status
 * bar carries the same facts, but the composer is the point of input: the
 * permission mode is safety-relevant (dangerous modes in warning color, plan
 * mode in teal) and the ctx label is the real context-window usage computed
 * by the caller (null until the first assistant usage block lands — never a
 * fabricated number).
 */
function ComposerContextRow({
  contextPctLabel,
}: {
  readonly contextPctLabel: string | null;
}): React.ReactElement {
  const mode =
    useAppStateMaybeOutsideOfProvider(selectComposerMode) ?? "default";
  const modelSetting =
    useAppStateMaybeOutsideOfProvider(selectComposerModel) ??
    getDefaultMainLoopModelSetting();
  const modelLabel = renderModelName(parseUserSpecifiedModel(modelSetting));
  const modeLabel = permissionModeShortTitle(mode).toLowerCase();
  const dangerous = isDangerousPermissionMode(mode);
  return (
    <Box flexDirection="row" paddingX={1} height={1} overflowY="hidden">
      <Text color={mode === "plan" ? "planMode" : dangerous ? "warning" : "inactive"}>
        {modeLabel}
      </Text>
      <Text color="inactive" wrap="truncate-end">
        {` · ${modelLabel}${contextPctLabel !== null ? ` · ${contextPctLabel}` : ""}`}
      </Text>
    </Box>
  );
}

export function WorkbenchLayout({
  transcript,
  composer,
  overlay,
  modal,
  modalScrollRef,
  pendingApproval,
  scrollRef,
  atWelcome,
  activityMode = null,
  contextPctLabel = null,
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
  // The Agents rail auto-hides only while the REVIEW rail is open and there
  // are no agent tasks to show: an empty "No background agents" column next
  // to a file under review is dead space the file can use. Without a review
  // rail open, the Agents rail keeps its always-on contract in wide layouts.
  const hasAgentTasks = useAppState((s) =>
    Object.values(s.tasks ?? {}).some((task: any) => task.type !== "local_bash"),
  );
  const showAgents = workbench.agentsVisible && layoutSize === "wide" &&
    (hasAgentTasks || workbench.fileRailPath === null);
  // The review rail (ctrl+r) lives only at wide widths — below that the chat
  // would be squeezed to nothing, and the preview surface is the better fit.
  const showRail = workbench.fileRailPath !== null && layoutSize === "wide";
  // Review rail width: share the space fairly with the chat instead of a
  // fixed narrow strip. 45% of the terminal, clamped below by the original
  // 44-col rail and above so the chat always keeps a workable ~46 columns
  // (and the rail never gets absurd on ultrawide).
  const railWidth = showRail
    ? Math.min(
        88,
        Math.max(44, Math.floor(columns * 0.45)),
        columns - (showExplorer ? explorerWidth : 0) - (showAgents ? agentsWidth : 0) - 46,
      )
    : 44;
  const surfaceWidth = Math.max(
    1,
    columns - (showExplorer ? explorerWidth : 0) - (showAgents ? agentsWidth : 0) - (showRail ? railWidth : 0),
  );
  const surfaceContentWidth = Math.max(1, surfaceWidth - 2);
  const visiblePanes = useMemo(
    () => visiblePaneList(showExplorer, showAgents, showRail),
    [showExplorer, showAgents, showRail],
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
      // ctrl+r — move the open file into the right-hand review rail (or close
      // it): the chat keeps the center pane so the user can chat, code, and
      // review the file at the same time.
      "workbench:toggleFileRail": () => {
        if (workbench.fileRailPath !== null) {
          dispatch({ type: "toggleFileRail" });
          return;
        }
        const path = workbench.activeFilePath;
        if (path === null) return;
        dispatch({ type: "toggleFileRail", path });
        if (workbench.activeSurfaceMode === "buffer" || workbench.activeSurfaceMode === "preview") {
          dispatch({ type: "closeSurface" });
        }
        // closeSurface moves focus to the transcript surface; the user just
        // asked to keep CHATTING beside the rail, so hand the keyboard back
        // to the composer or they can't type.
        dispatch({ type: "focus", pane: "composer" });
      },
    },
    { context: "Workbench", isActive: !editorOwnsKeys },
  );

  return (
    <Box flexDirection="column" width="100%" height={rows} overflow="hidden">
      {rows >= 8 ? <WorkbenchStatusBar activityMode={activityMode} columns={columns} contextPctLabel={contextPctLabel} /> : null}
      {/* On the cold-start welcome the surface row sizes to its content so the
          composer sits directly under the welcome panel instead of pinned to
          the bottom of a tall terminal with a dead gulf between them; the
          spacer after the footer absorbs the remaining rows. Once messages
          arrive the row grows again and the composer returns to the bottom. */}
      <Box flexDirection="row" flexGrow={atWelcome ? 0 : 1} flexShrink={1} overflow="hidden">
        {showExplorer ? (
          <NoSelect flexShrink={0} width={explorerWidth} height="100%">
            <ProjectExplorer focused={focusedPane === "explorer"} width={explorerWidth} />
          </NoSelect>
        ) : null}
        <ContentWidthProvider width={surfaceContentWidth}>
          <ActiveWorkSurface focused={focusedPane === "surface"} transcript={transcript} pendingApproval={pendingApproval} scrollRef={scrollRef} atWelcome={atWelcome} />
        </ContentWidthProvider>
        {showRail ? (
          <NoSelect flexShrink={0} width={railWidth} height="100%">
            <PreviewSurface focused={focusedPane === "rail"} pathOverride={workbench.fileRailPath} />
          </NoSelect>
        ) : null}
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
        <ComposerContextRow contextPctLabel={contextPctLabel} />
        <PromptSuggestionsOverlay />
        <WorkbenchComposerFocusProvider active={focusedPane === "composer"}>
          {composer}
        </WorkbenchComposerFocusProvider>
      </Box>
      <PromptDialogOverlay />
      {rows >= 5 ? <WorkbenchFooter /> : null}
      {atWelcome ? <Box flexGrow={1} /> : null}
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

function visiblePaneList(showExplorer: boolean, showAgents: boolean, showRail: boolean): readonly WorkbenchPane[] {
  return [
    ...(showExplorer ? ["explorer" as const] : []),
    "surface" as const,
    ...(showRail ? ["rail" as const] : []),
    ...(showAgents ? ["agents" as const] : []),
    "composer" as const,
  ];
}

function nextRightPane(current: WorkbenchPane, showAgents: boolean): WorkbenchPane {
  if (current === "explorer") return "surface";
  if (current === "surface" && showAgents) return "agents";
  return "surface";
}
