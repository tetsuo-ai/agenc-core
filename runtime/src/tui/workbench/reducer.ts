import type {
  ActiveSurfaceMode,
  AgentSurfaceMode,
  WorkbenchAttachment,
  WorkbenchCommand,
  WorkbenchPane,
  WorkbenchRail,
  WorkbenchState,
  WorkspaceView,
} from "./types.js";
import {
  containsWorkspacePathReference,
  normalizeWorkspacePathForReferences,
  renameWorkspacePathReference,
} from "./pathReferences.js";

const EMPTY_COMPOSER_ATTACHMENT_IDS: readonly string[] = [];

export function getDefaultWorkbenchState(): WorkbenchState {
  return {
    activeWorkspaceView: "agent",
    agentFocusedPane: "composer",
    editorFocusedPane: "surface",
    agentSurfaceMode: "transcript",
    agentRail: null,
    editorRail: null,
    agentActiveFilePath: null,
    agentActiveFileLine: null,
    editorActiveFilePath: null,
    editorActiveFileLine: null,
    focusedPane: "composer",
    explorerVisible: true,
    agentsVisible: true,
    activeSurfaceMode: "transcript",
    activeFilePath: null,
    activeFileLine: null,
    bufferOpenRequestId: 0,
    selectedAgentTaskId: null,
    selectedShellTaskId: null,
    openDiffId: null,
    searchQuery: "",
    selectedSearchMatchId: null,
    composerAttachmentIds: EMPTY_COMPOSER_ATTACHMENT_IDS,
    agentComposerAttachmentIds: EMPTY_COMPOSER_ATTACHMENT_IDS,
    editorComposerAttachmentIds: EMPTY_COMPOSER_ATTACHMENT_IDS,
    attachments: [],
    pendingBlockedOverlay: null,
    gitPanelOpen: false,
    composerDraftRequest: null,
    surfaceMaximized: false,
    rail: null,
    appExitRequestId: 0,
    appExitResumeSessionId: null,
    projectPathMutationRequestId: 0,
    projectPathMutationRequest: null,
  };
}

export function ensureWorkbenchState(
  state: WorkbenchState | undefined,
): WorkbenchState {
  if (state === undefined) return getDefaultWorkbenchState();
  const persisted = state as WorkbenchState & {
    readonly activeWorkspaceView?: WorkspaceView;
    readonly agentFocusedPane?: WorkbenchPane;
    readonly editorFocusedPane?: WorkbenchPane;
    readonly agentSurfaceMode?: AgentSurfaceMode | "agent";
    readonly agentRail?: WorkbenchRail;
    readonly editorRail?: WorkbenchRail;
    readonly agentActiveFilePath?: string | null;
    readonly agentActiveFileLine?: number | null;
    readonly editorActiveFilePath?: string | null;
    readonly editorActiveFileLine?: number | null;
    readonly surfaceMaximized?: boolean;
    readonly rail?: WorkbenchRail;
    readonly fileRailPath?: string | null;
    readonly agentComposerAttachmentIds?: readonly string[];
    readonly editorComposerAttachmentIds?: readonly string[];
    readonly composerDraftRequest?: {
      readonly id: number;
      readonly text: string;
      readonly view?: WorkspaceView;
    } | null;
    readonly appExitRequestId?: number;
    readonly appExitResumeSessionId?: string | null;
    readonly projectPathMutationRequestId?: number;
    readonly projectPathMutationRequest?: WorkbenchState["projectPathMutationRequest"];
  };
  const legacySurfaceMode =
    (persisted.activeSurfaceMode as ActiveSurfaceMode | "agent") === "agent"
      ? "task-detail"
      : persisted.activeSurfaceMode;
  // activeSurfaceMode was the pre-tabs source of truth and is still directly
  // updated by a handful of compatibility callers/tests. Reconcile the new
  // view discriminator from it so a partial object spread cannot produce
  // "Agent + BUFFER" or "Editor + SEARCH" split-brain state.
  const activeWorkspaceView =
    legacySurfaceMode === "buffer" ? "editor" : "agent";
  const agentSurfaceMode =
    activeWorkspaceView === "agent"
      ? normalizeAgentSurfaceMode(legacySurfaceMode)
      : normalizeAgentSurfaceMode(persisted.agentSurfaceMode ?? "transcript");
  const agentFocusedPane =
    activeWorkspaceView === "agent"
      ? persisted.focusedPane
      : (persisted.agentFocusedPane ?? "composer");
  const editorFocusedPane =
    activeWorkspaceView === "editor"
      ? persisted.focusedPane
      : (persisted.editorFocusedPane ?? "surface");
  const legacyRail =
    persisted.rail ??
    (persisted.fileRailPath
      ? { kind: "file" as const, path: persisted.fileRailPath }
      : null);
  const agentRail =
    activeWorkspaceView === "agent"
      ? legacyRail
      : (persisted.agentRail ?? null);
  const editorRail =
    activeWorkspaceView === "editor"
      ? legacyRail
      : (persisted.editorRail ?? null);
  const agentActiveFilePath =
    activeWorkspaceView === "agent"
      ? persisted.activeFilePath
      : (persisted.agentActiveFilePath ?? null);
  const agentActiveFileLine =
    activeWorkspaceView === "agent"
      ? persisted.activeFileLine
      : (persisted.agentActiveFileLine ?? null);
  const editorActiveFilePath =
    activeWorkspaceView === "editor"
      ? persisted.activeFilePath
      : (persisted.editorActiveFilePath ?? null);
  const editorActiveFileLine =
    activeWorkspaceView === "editor"
      ? persisted.activeFileLine
      : (persisted.editorActiveFileLine ?? null);
  const agentComposerAttachmentIds =
    activeWorkspaceView === "agent"
      ? persisted.composerAttachmentIds
      : (persisted.agentComposerAttachmentIds ?? []);
  const editorComposerAttachmentIds =
    activeWorkspaceView === "editor"
      ? persisted.composerAttachmentIds
      : (persisted.editorComposerAttachmentIds ?? []);
  const rawComposerDraftRequest = persisted.composerDraftRequest;
  const composerDraftRequest: WorkbenchState["composerDraftRequest"] =
    rawComposerDraftRequest === undefined || rawComposerDraftRequest === null
      ? null
      : rawComposerDraftRequest.view === "agent" ||
          rawComposerDraftRequest.view === "editor"
        ? (rawComposerDraftRequest as NonNullable<
            WorkbenchState["composerDraftRequest"]
          >)
        : {
            id: rawComposerDraftRequest.id,
            text: rawComposerDraftRequest.text,
            view: activeWorkspaceView,
          };
  if (
    persisted.activeWorkspaceView === activeWorkspaceView &&
    persisted.agentFocusedPane === agentFocusedPane &&
    persisted.editorFocusedPane === editorFocusedPane &&
    persisted.agentSurfaceMode === agentSurfaceMode &&
    persisted.agentRail === agentRail &&
    persisted.editorRail === editorRail &&
    persisted.agentActiveFilePath === agentActiveFilePath &&
    persisted.agentActiveFileLine === agentActiveFileLine &&
    persisted.editorActiveFilePath === editorActiveFilePath &&
    persisted.editorActiveFileLine === editorActiveFileLine &&
    persisted.agentComposerAttachmentIds === agentComposerAttachmentIds &&
    persisted.editorComposerAttachmentIds === editorComposerAttachmentIds &&
    legacySurfaceMode === persisted.activeSurfaceMode &&
    persisted.surfaceMaximized !== undefined &&
    persisted.rail !== undefined &&
    persisted.composerDraftRequest === composerDraftRequest &&
    persisted.appExitRequestId !== undefined &&
    persisted.appExitResumeSessionId !== undefined &&
    persisted.projectPathMutationRequestId !== undefined &&
    persisted.projectPathMutationRequest !== undefined
  ) {
    return state;
  }
  return {
    ...state,
    activeWorkspaceView,
    agentFocusedPane,
    editorFocusedPane,
    agentSurfaceMode,
    agentRail,
    editorRail,
    agentActiveFilePath,
    agentActiveFileLine,
    editorActiveFilePath,
    editorActiveFileLine,
    agentComposerAttachmentIds,
    editorComposerAttachmentIds,
    composerAttachmentIds:
      activeWorkspaceView === "editor"
        ? editorComposerAttachmentIds
        : agentComposerAttachmentIds,
    activeSurfaceMode:
      activeWorkspaceView === "editor" ? "buffer" : agentSurfaceMode,
    activeFilePath:
      activeWorkspaceView === "editor"
        ? editorActiveFilePath
        : agentActiveFilePath,
    activeFileLine:
      activeWorkspaceView === "editor"
        ? editorActiveFileLine
        : agentActiveFileLine,
    focusedPane:
      activeWorkspaceView === "editor" ? editorFocusedPane : agentFocusedPane,
    surfaceMaximized: persisted.surfaceMaximized ?? false,
    composerDraftRequest,
    appExitRequestId: persisted.appExitRequestId ?? 0,
    appExitResumeSessionId: persisted.appExitResumeSessionId ?? null,
    projectPathMutationRequestId: persisted.projectPathMutationRequestId ?? 0,
    projectPathMutationRequest: persisted.projectPathMutationRequest ?? null,
    rail: activeWorkspaceView === "editor" ? editorRail : agentRail,
  };
}

export function workbenchReducer(
  inputState: WorkbenchState | undefined,
  command: WorkbenchCommand,
): WorkbenchState {
  return syncActiveWorkspaceSnapshot(reduceWorkbenchState(inputState, command));
}

function reduceWorkbenchState(
  inputState: WorkbenchState | undefined,
  command: WorkbenchCommand,
): WorkbenchState {
  const state = ensureWorkbenchState(inputState);
  switch (command.type) {
    case "switchWorkspaceView":
      return switchWorkspaceView(state, command.view);
    case "cycleWorkspaceView":
      return switchWorkspaceView(
        state,
        state.activeWorkspaceView === "agent" ? "editor" : "agent",
      );
    case "focus":
      return focusPane(state, command.pane);
    case "focusNext":
      return focusNextPane(state, command.visiblePanes);
    case "openSurface":
      return openSurface(state, command.mode);
    case "openPreview":
      if (state.activeWorkspaceView === "editor") {
        return {
          ...openEditorBuffer(state, command.focus ?? true),
          activeFilePath: command.path,
          activeFileLine: command.line ?? null,
          bufferOpenRequestId: state.bufferOpenRequestId + 1,
        };
      }
      return {
        ...openSurface(state, "preview", command.focus ?? true),
        activeFilePath: command.path,
        activeFileLine: command.line ?? null,
      };
    case "openBuffer":
      return {
        ...openEditorBuffer(state, command.focus ?? true),
        activeFilePath: command.path,
        activeFileLine: command.line ?? null,
        bufferOpenRequestId: state.bufferOpenRequestId + 1,
      };
    case "syncBufferPath":
      if (state.activeSurfaceMode !== "buffer") return state;
      return {
        ...state,
        activeFilePath: command.path,
        activeFileLine: command.line ?? null,
      };
    case "openSearch":
      const nextSearchQuery = command.query ?? state.searchQuery;
      const searchQueryChanged =
        command.query !== undefined && command.query !== state.searchQuery;
      let nextSelectedSearchMatchId = state.selectedSearchMatchId;
      if (command.selectedMatchId !== undefined) {
        nextSelectedSearchMatchId = command.selectedMatchId;
      } else if (searchQueryChanged) {
        nextSelectedSearchMatchId = null;
      }
      return {
        ...openSurface(state, "search"),
        searchQuery: nextSearchQuery,
        selectedSearchMatchId: nextSelectedSearchMatchId,
      };
    case "openDiff":
      return {
        ...openSurface(state, "diff", command.focus ?? true),
        openDiffId:
          command.diffId === undefined ? state.openDiffId : command.diffId,
      };
    case "openShell":
      return {
        ...openSurface(state, "shell", command.focus ?? true),
        selectedShellTaskId: command.taskId,
      };
    case "openAgent":
      return {
        ...openSurface(state, "task-detail", command.focus ?? true),
        selectedAgentTaskId: command.taskId,
      };
    case "selectAgent":
      return {
        ...state,
        selectedAgentTaskId: command.taskId,
      };
    case "closeSurface":
      return state.activeWorkspaceView === "editor"
        ? switchWorkspaceView(state, "agent")
        : {
            ...openSurface(state, "transcript"),
            focusedPane: "composer",
          };
    case "moveFileToRail":
      return {
        ...openSurface(state, "transcript"),
        focusedPane: "composer",
        rail: { kind: "file", path: command.path },
        surfaceMaximized: false,
      };
    case "requestAppExit":
      return {
        ...state,
        appExitRequestId: state.appExitRequestId + 1,
        appExitResumeSessionId: command.resumeSessionId ?? null,
      };
    case "requestProjectPathRename": {
      const requestId = state.projectPathMutationRequestId + 1;
      return {
        ...state,
        projectPathMutationRequestId: requestId,
        projectPathMutationRequest: {
          id: requestId,
          kind: "rename",
          fromPath: command.fromPath,
          toPath: command.toPath,
        },
      };
    }
    case "requestProjectPathDelete": {
      const requestId = state.projectPathMutationRequestId + 1;
      return {
        ...state,
        projectPathMutationRequestId: requestId,
        projectPathMutationRequest: {
          id: requestId,
          kind: "delete",
          path: command.path,
        },
      };
    }
    case "completeProjectPathMutation":
      if (state.projectPathMutationRequest?.id !== command.requestId)
        return state;
      return { ...state, projectPathMutationRequest: null };
    case "renamePathReferences": {
      const nextState = renamePathReferences(
        state,
        command.fromPath,
        command.toPath,
      );
      if (
        command.openAffectedBuffer === true &&
        nextState.activeFilePath !== null &&
        nextState.activeFilePath !== state.activeFilePath
      ) {
        const affectedPath = nextState.activeFilePath;
        const affectedLine = nextState.activeFileLine;
        return {
          ...openEditorBuffer(nextState, false),
          activeFilePath: affectedPath,
          activeFileLine: affectedLine,
        };
      }
      return nextState;
    }
    case "deletePathReferences": {
      const nextState = deletePathReferences(state, command.path);
      if (
        command.closeAffectedSurface === true &&
        state.activeFilePath !== null &&
        nextState.activeFilePath === null
      ) {
        return openSurface(nextState, "transcript");
      }
      return nextState;
    }
    case "toggleExplorer":
      return {
        ...state,
        explorerVisible: command.visible ?? !state.explorerVisible,
        surfaceMaximized:
          command.visible === false ? state.surfaceMaximized : false,
        focusedPane:
          command.visible === false && state.focusedPane === "explorer"
            ? "surface"
            : state.focusedPane,
      };
    case "toggleAgents":
      return {
        ...state,
        agentsVisible: command.visible ?? !state.agentsVisible,
        surfaceMaximized:
          command.visible === false ? state.surfaceMaximized : false,
        focusedPane:
          command.visible === false && state.focusedPane === "agents"
            ? "surface"
            : state.focusedPane,
      };
    case "toggleSurfaceMaximized":
      return {
        ...state,
        surfaceMaximized: command.maximized ?? !state.surfaceMaximized,
        focusedPane: "surface",
      };
    case "attach":
      return attach(state, command.attachment);
    case "removeAttachment": {
      const nextState = withActiveComposerAttachmentIds(
        state,
        state.composerAttachmentIds.filter((id) => id !== command.id),
      );
      const retainedIds = new Set([
        ...nextState.agentComposerAttachmentIds,
        ...nextState.editorComposerAttachmentIds,
      ]);
      return {
        ...nextState,
        attachments: state.attachments.filter(
          (item) => item.id !== command.id || retainedIds.has(item.id),
        ),
      };
    }
    case "clearAttachments": {
      const workspaceView = command.workspaceView ?? state.activeWorkspaceView;
      const submittedIds = new Set(
        command.ids ??
          (workspaceView === "editor"
            ? state.editorComposerAttachmentIds
            : state.agentComposerAttachmentIds),
      );
      const agentComposerAttachmentIds =
        workspaceView === "agent"
          ? state.agentComposerAttachmentIds.filter(
              (id) => !submittedIds.has(id),
            )
          : state.agentComposerAttachmentIds;
      const editorComposerAttachmentIds =
        workspaceView === "editor"
          ? state.editorComposerAttachmentIds.filter(
              (id) => !submittedIds.has(id),
            )
          : state.editorComposerAttachmentIds;
      const retainedIds = new Set([
        ...agentComposerAttachmentIds,
        ...editorComposerAttachmentIds,
      ]);
      return {
        ...state,
        attachments: state.attachments.filter((attachment) =>
          retainedIds.has(attachment.id),
        ),
        agentComposerAttachmentIds,
        editorComposerAttachmentIds,
        composerAttachmentIds:
          state.activeWorkspaceView === "editor"
            ? editorComposerAttachmentIds
            : agentComposerAttachmentIds,
      };
    }
    case "handoffToComposer": {
      const attached = attach(state, command.attachment);
      const nextDraftId = (state.composerDraftRequest?.id ?? 0) + 1;
      return {
        ...attached,
        focusedPane: "composer",
        surfaceMaximized: false,
        rail:
          command.openTranscriptRail === false
            ? state.rail
            : { kind: "transcript" },
        composerDraftRequest:
          command.draftText && command.draftText.trim().length > 0
            ? {
                id: nextDraftId,
                text: command.draftText,
                view: state.activeWorkspaceView,
              }
            : null,
      };
    }
    case "acknowledgeComposerDraft":
      if (state.composerDraftRequest?.id !== command.id) return state;
      return { ...state, composerDraftRequest: null };
    case "blockForApproval":
      return {
        ...state,
        pendingBlockedOverlay: {
          kind: "buffer-dirty",
          requestId: command.requestId,
          attemptedAction: command.attemptedAction,
          deferredCommand: command.deferredCommand,
        },
      };
    case "toggleGitPanel":
      return {
        ...state,
        gitPanelOpen: command.open ?? !state.gitPanelOpen,
      };
    case "clearBlockedOverlay":
      return {
        ...state,
        pendingBlockedOverlay: null,
      };
    case "resolveBlockedOverlay": {
      const pending = state.pendingBlockedOverlay;
      if (pending === null || pending.requestId !== command.requestId) {
        return state;
      }
      return workbenchReducer(
        { ...state, pendingBlockedOverlay: null },
        pending.deferredCommand,
      );
    }
    case "setRail":
      return {
        ...state,
        rail: command.rail,
        surfaceMaximized:
          command.rail === null ? state.surfaceMaximized : false,
      };
    case "toggleFileRail":
      // Toggling the rail never changes the center surface or steals focus:
      // the transcript/chat stays put, the rail opens beside it.
      if (command.path === undefined) {
        return { ...state, rail: null };
      }
      return {
        ...state,
        rail: { kind: "file", path: command.path },
        surfaceMaximized: false,
      };
  }
}

export function visibleWorkbenchPane(state: WorkbenchState): WorkbenchPane {
  if (state.focusedPane === "explorer" && !state.explorerVisible)
    return "surface";
  if (state.focusedPane === "agents" && !state.agentsVisible) return "surface";
  if (state.focusedPane === "rail" && state.rail === null) return "surface";
  return state.focusedPane;
}

export function composerAttachmentsForState(
  state: WorkbenchState,
): readonly WorkbenchAttachment[] {
  const attachmentsById = new Map(
    state.attachments.map((item) => [item.id, item]),
  );
  const seen = new Set<string>();
  const attachments: WorkbenchAttachment[] = [];
  for (const id of state.composerAttachmentIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const attachment = attachmentsById.get(id);
    if (attachment) attachments.push(attachment);
  }
  return attachments;
}

function openSurface(
  state: WorkbenchState,
  mode: ActiveSurfaceMode,
  focus = true,
): WorkbenchState {
  if (mode === "buffer") return openEditorBuffer(state, focus);
  const agentState = switchWorkspaceView(state, "agent");
  return {
    ...agentState,
    activeSurfaceMode: mode,
    agentSurfaceMode: mode,
    surfaceMaximized: false,
    focusedPane: focus ? "surface" : agentState.focusedPane,
    // A transcript rail is useful beside BUFFER, but once the transcript
    // becomes the center surface it would mount the same transcript twice
    // (including the same scroll ref). File and change-review rails remain
    // valid sidecars and must survive the surface transition.
    rail:
      mode === "transcript" && agentState.rail?.kind === "transcript"
        ? null
        : agentState.rail,
  };
}

function openEditorBuffer(state: WorkbenchState, focus = true): WorkbenchState {
  const editorState = switchWorkspaceView(state, "editor");
  return {
    ...editorState,
    activeSurfaceMode: "buffer",
    // "Keep focus" means keep the pane that initiated the navigation even
    // when this command also crosses the Agent → Editor view boundary.
    focusedPane: focus ? "surface" : state.focusedPane,
  };
}

function switchWorkspaceView(
  inputState: WorkbenchState,
  view: WorkspaceView,
): WorkbenchState {
  const state = syncActiveWorkspaceSnapshot(inputState);
  if (state.activeWorkspaceView === view) return state;
  if (view === "editor") {
    return {
      ...state,
      activeWorkspaceView: "editor",
      activeSurfaceMode: "buffer",
      activeFilePath: state.editorActiveFilePath,
      activeFileLine: state.editorActiveFileLine,
      focusedPane: state.editorFocusedPane,
      rail: state.editorRail,
      composerAttachmentIds: state.editorComposerAttachmentIds,
    };
  }
  return {
    ...state,
    activeWorkspaceView: "agent",
    activeSurfaceMode: state.agentSurfaceMode,
    activeFilePath: state.agentActiveFilePath,
    activeFileLine: state.agentActiveFileLine,
    focusedPane: state.agentFocusedPane,
    rail: state.agentRail,
    composerAttachmentIds: state.agentComposerAttachmentIds,
    surfaceMaximized: false,
  };
}

function syncActiveWorkspaceSnapshot(state: WorkbenchState): WorkbenchState {
  if (state.activeWorkspaceView === "editor") {
    if (
      state.editorFocusedPane === state.focusedPane &&
      state.editorRail === state.rail &&
      state.editorActiveFilePath === state.activeFilePath &&
      state.editorActiveFileLine === state.activeFileLine &&
      state.editorComposerAttachmentIds === state.composerAttachmentIds &&
      state.activeSurfaceMode === "buffer"
    ) {
      return state;
    }
    return {
      ...state,
      activeSurfaceMode: "buffer",
      editorFocusedPane: state.focusedPane,
      editorRail: state.rail,
      editorActiveFilePath: state.activeFilePath,
      editorActiveFileLine: state.activeFileLine,
      editorComposerAttachmentIds: state.composerAttachmentIds,
    };
  }
  const agentSurfaceMode = normalizeAgentSurfaceMode(state.activeSurfaceMode);
  if (
    state.agentFocusedPane === state.focusedPane &&
    state.agentSurfaceMode === agentSurfaceMode &&
    state.agentRail === state.rail &&
    state.agentActiveFilePath === state.activeFilePath &&
    state.agentActiveFileLine === state.activeFileLine &&
    state.agentComposerAttachmentIds === state.composerAttachmentIds
  ) {
    return state;
  }
  return {
    ...state,
    activeSurfaceMode: agentSurfaceMode,
    agentFocusedPane: state.focusedPane,
    agentSurfaceMode,
    agentRail: state.rail,
    agentActiveFilePath: state.activeFilePath,
    agentActiveFileLine: state.activeFileLine,
    agentComposerAttachmentIds: state.composerAttachmentIds,
  };
}

function normalizeAgentSurfaceMode(
  mode: ActiveSurfaceMode | "agent",
): AgentSurfaceMode {
  if (mode === "buffer") return "transcript";
  if (mode === "agent") return "task-detail";
  return mode;
}

function focusPane(state: WorkbenchState, pane: WorkbenchPane): WorkbenchState {
  if (pane === "explorer" && !state.explorerVisible) {
    return {
      ...state,
      explorerVisible: true,
      surfaceMaximized: false,
      focusedPane: pane,
    };
  }
  if (pane === "agents" && !state.agentsVisible) {
    return {
      ...state,
      agentsVisible: true,
      surfaceMaximized: false,
      focusedPane: pane,
    };
  }
  return {
    ...state,
    surfaceMaximized: pane === "surface" ? state.surfaceMaximized : false,
    focusedPane: pane,
  };
}

function focusNextPane(
  state: WorkbenchState,
  visiblePanes: readonly WorkbenchPane[],
): WorkbenchState {
  const panes =
    visiblePanes.length > 0 ? visiblePanes : (["surface", "composer"] as const);
  const current = panes.indexOf(visibleWorkbenchPane(state));
  const next = panes[(current + 1 + panes.length) % panes.length] ?? "surface";
  return {
    ...state,
    surfaceMaximized: next === "surface" ? state.surfaceMaximized : false,
    focusedPane: next,
  };
}

function attach(
  state: WorkbenchState,
  attachment: WorkbenchAttachment,
): WorkbenchState {
  const attachments = [
    ...state.attachments.filter((item) => item.id !== attachment.id),
    attachment,
  ];
  return withActiveComposerAttachmentIds(
    { ...state, attachments },
    unique([
      ...state.composerAttachmentIds.filter((id) => id !== attachment.id),
      attachment.id,
    ]),
  );
}

function withActiveComposerAttachmentIds(
  state: WorkbenchState,
  composerAttachmentIds: readonly string[],
): WorkbenchState {
  return state.activeWorkspaceView === "editor"
    ? {
        ...state,
        composerAttachmentIds,
        editorComposerAttachmentIds: composerAttachmentIds,
      }
    : {
        ...state,
        composerAttachmentIds,
        agentComposerAttachmentIds: composerAttachmentIds,
      };
}

function renamePathReferences(
  state: WorkbenchState,
  fromPath: string,
  toPath: string,
): WorkbenchState {
  const normalizedFromPath = normalizeWorkspacePathForReferences(fromPath);
  const normalizedToPath = normalizeWorkspacePathForReferences(toPath);
  const attachmentIdMap = new Map<string, string>();
  const attachmentsById = new Map<string, WorkbenchAttachment>();
  for (const attachment of state.attachments) {
    const nextAttachment = renameAttachmentPath(
      attachment,
      normalizedFromPath,
      normalizedToPath,
    );
    attachmentIdMap.set(attachment.id, nextAttachment.id);
    attachmentsById.set(nextAttachment.id, nextAttachment);
  }
  const attachments = [...attachmentsById.values()];
  const attachmentIds = new Set(attachments.map((item) => item.id));
  const renameIds = (ids: readonly string[]): readonly string[] =>
    unique(
      ids
        .map((id) => attachmentIdMap.get(id) ?? id)
        .filter((id) => attachmentIds.has(id)),
    );
  const composerAttachmentIds = renameIds(state.composerAttachmentIds);
  return {
    ...state,
    activeFilePath:
      renameWorkspacePathReference(
        state.activeFilePath,
        normalizedFromPath,
        normalizedToPath,
      ) ?? state.activeFilePath,
    agentActiveFilePath:
      renameWorkspacePathReference(
        state.agentActiveFilePath,
        normalizedFromPath,
        normalizedToPath,
      ) ?? state.agentActiveFilePath,
    editorActiveFilePath:
      renameWorkspacePathReference(
        state.editorActiveFilePath,
        normalizedFromPath,
        normalizedToPath,
      ) ?? state.editorActiveFilePath,
    attachments,
    composerAttachmentIds,
    agentComposerAttachmentIds: renameIds(state.agentComposerAttachmentIds),
    editorComposerAttachmentIds: renameIds(state.editorComposerAttachmentIds),
  };
}

function deletePathReferences(
  state: WorkbenchState,
  deletedPath: string,
): WorkbenchState {
  const activeFileDeleted = containsWorkspacePathReference(
    state.activeFilePath,
    deletedPath,
  );
  const agentActiveFileDeleted = containsWorkspacePathReference(
    state.agentActiveFilePath,
    deletedPath,
  );
  const editorActiveFileDeleted = containsWorkspacePathReference(
    state.editorActiveFilePath,
    deletedPath,
  );
  const attachments = state.attachments.filter(
    (attachment) =>
      !containsWorkspacePathReference(attachment.path ?? null, deletedPath),
  );
  const attachmentIds = new Set(attachments.map((item) => item.id));
  return {
    ...state,
    activeFilePath: activeFileDeleted ? null : state.activeFilePath,
    activeFileLine: activeFileDeleted ? null : state.activeFileLine,
    agentActiveFilePath: agentActiveFileDeleted
      ? null
      : state.agentActiveFilePath,
    agentActiveFileLine: agentActiveFileDeleted
      ? null
      : state.agentActiveFileLine,
    editorActiveFilePath: editorActiveFileDeleted
      ? null
      : state.editorActiveFilePath,
    editorActiveFileLine: editorActiveFileDeleted
      ? null
      : state.editorActiveFileLine,
    attachments,
    composerAttachmentIds: state.composerAttachmentIds.filter((id) =>
      attachmentIds.has(id),
    ),
    agentComposerAttachmentIds: state.agentComposerAttachmentIds.filter((id) =>
      attachmentIds.has(id),
    ),
    editorComposerAttachmentIds: state.editorComposerAttachmentIds.filter(
      (id) => attachmentIds.has(id),
    ),
  };
}

function renameAttachmentPath(
  attachment: WorkbenchAttachment,
  fromPath: string,
  toPath: string,
): WorkbenchAttachment {
  const nextPath = renameWorkspacePathReference(
    attachment.path ?? null,
    fromPath,
    toPath,
  );
  const nextInteractionPath = renameWorkspacePathReference(
    attachment.editorInteraction?.path ?? null,
    fromPath,
    toPath,
  );
  const attachmentPathChanged =
    nextPath !== null && nextPath !== attachment.path;
  const interactionPathChanged =
    nextInteractionPath !== null &&
    nextInteractionPath !== attachment.editorInteraction?.path;
  if (!attachmentPathChanged && !interactionPathChanged) return attachment;
  return {
    ...attachment,
    ...(attachmentPathChanged
      ? {
          id: replaceFirst(attachment.id, attachment.path ?? "", nextPath),
          path: nextPath,
          label: replaceFirst(
            attachment.label,
            attachment.path ?? "",
            nextPath,
          ),
        }
      : {}),
    ...(interactionPathChanged && attachment.editorInteraction !== undefined
      ? {
          editorInteraction: {
            ...attachment.editorInteraction,
            path: nextInteractionPath,
          },
        }
      : {}),
  };
}

function replaceFirst(
  value: string,
  needle: string,
  replacement: string,
): string {
  if (!needle) return value;
  const index = value.indexOf(needle);
  if (index < 0) return value;
  return `${value.slice(0, index)}${replacement}${value.slice(index + needle.length)}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
