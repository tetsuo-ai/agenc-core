import type {
  ActiveSurfaceMode,
  WorkbenchAttachment,
  WorkbenchCommand,
  WorkbenchPane,
  WorkbenchState,
} from "./types.js";

export function getDefaultWorkbenchState(): WorkbenchState {
  return {
    focusedPane: "surface",
    explorerVisible: true,
    agentsVisible: true,
    activeSurfaceMode: "transcript",
    activeFilePath: null,
    activeFileLine: null,
    selectedAgentTaskId: null,
    selectedShellTaskId: null,
    openDiffId: null,
    searchQuery: "",
    selectedSearchMatchId: null,
    composerAttachmentIds: [],
    attachments: [],
    pendingBlockedOverlay: null,
  };
}

export function ensureWorkbenchState(state: WorkbenchState | undefined): WorkbenchState {
  return state ?? getDefaultWorkbenchState();
}

export function workbenchReducer(
  inputState: WorkbenchState | undefined,
  command: WorkbenchCommand,
): WorkbenchState {
  const state = ensureWorkbenchState(inputState);
  switch (command.type) {
    case "focus":
      return focusPane(state, command.pane);
    case "focusNext":
      return focusNextPane(state, command.visiblePanes);
    case "openSurface":
      return openSurface(state, command.mode);
    case "openPreview":
      return {
        ...openSurface(state, "preview", command.focus ?? true),
        activeFilePath: command.path,
        activeFileLine: command.line ?? null,
      };
    case "openBuffer":
      return {
        ...openSurface(state, "buffer", command.focus ?? true),
        activeFilePath: command.path,
        activeFileLine: command.line ?? null,
      };
    case "openSearch":
      return {
        ...openSurface(state, "search"),
        searchQuery: command.query ?? state.searchQuery,
        selectedSearchMatchId: command.selectedMatchId ?? state.selectedSearchMatchId,
      };
    case "openDiff":
      return {
        ...openSurface(state, "diff", command.focus ?? true),
        openDiffId: command.diffId ?? state.openDiffId,
      };
    case "openShell":
      return {
        ...openSurface(state, "shell", command.focus ?? true),
        selectedShellTaskId: command.taskId,
      };
    case "openAgent":
      return {
        ...openSurface(state, "agent", command.focus ?? true),
        selectedAgentTaskId: command.taskId,
      };
    case "selectAgent":
      return {
        ...state,
        selectedAgentTaskId: command.taskId,
      };
    case "closeSurface":
      return openSurface(state, "transcript");
    case "toggleExplorer":
      return {
        ...state,
        explorerVisible: command.visible ?? !state.explorerVisible,
        focusedPane:
          command.visible === false && state.focusedPane === "explorer"
            ? "surface"
            : state.focusedPane,
      };
    case "toggleAgents":
      return {
        ...state,
        agentsVisible: command.visible ?? !state.agentsVisible,
        focusedPane:
          command.visible === false && state.focusedPane === "agents"
            ? "surface"
            : state.focusedPane,
      };
    case "attach":
      return attach(state, command.attachment);
    case "removeAttachment":
      return {
        ...state,
        attachments: state.attachments.filter((item) => item.id !== command.id),
        composerAttachmentIds: state.composerAttachmentIds.filter((id) => id !== command.id),
      };
    case "clearAttachments":
      return {
        ...state,
        attachments: [],
        composerAttachmentIds: [],
      };
    case "blockForApproval":
      return {
        ...state,
        pendingBlockedOverlay: {
          kind: "approval",
          requestId: command.requestId,
          attemptedAction: command.attemptedAction,
        },
      };
    case "clearBlockedOverlay":
      return {
        ...state,
        pendingBlockedOverlay: null,
      };
  }
}

function openSurface(
  state: WorkbenchState,
  mode: ActiveSurfaceMode,
  focus = true,
): WorkbenchState {
  return {
    ...state,
    activeSurfaceMode: mode,
    focusedPane: focus ? "surface" : state.focusedPane,
  };
}

function focusPane(state: WorkbenchState, pane: WorkbenchPane): WorkbenchState {
  if (pane === "explorer" && !state.explorerVisible) {
    return { ...state, explorerVisible: true, focusedPane: pane };
  }
  if (pane === "agents" && !state.agentsVisible) {
    return { ...state, agentsVisible: true, focusedPane: pane };
  }
  return { ...state, focusedPane: pane };
}

function focusNextPane(
  state: WorkbenchState,
  visiblePanes: readonly WorkbenchPane[],
): WorkbenchState {
  const panes = visiblePanes.length > 0 ? visiblePanes : (["surface", "composer"] as const);
  const current = panes.indexOf(state.focusedPane);
  const next = panes[(current + 1 + panes.length) % panes.length] ?? "surface";
  return { ...state, focusedPane: next };
}

function attach(
  state: WorkbenchState,
  attachment: WorkbenchAttachment,
): WorkbenchState {
  const attachments = [
    ...state.attachments.filter((item) => item.id !== attachment.id),
    attachment,
  ];
  return {
    ...state,
    attachments,
    composerAttachmentIds: attachments.map((item) => item.id),
  };
}
