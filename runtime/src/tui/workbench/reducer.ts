import type {
  ActiveSurfaceMode,
  WorkbenchAttachment,
  WorkbenchCommand,
  WorkbenchPane,
  WorkbenchRail,
  WorkbenchState,
} from "./types.js";
import {
  containsWorkspacePathReference,
  normalizeWorkspacePathForReferences,
  renameWorkspacePathReference,
} from "./pathReferences.js";

export function getDefaultWorkbenchState(): WorkbenchState {
  return {
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
    composerAttachmentIds: [],
    attachments: [],
    pendingBlockedOverlay: null,
    composerDraftRequest: null,
    surfaceMaximized: false,
    rail: null,
    appExitRequestId: 0,
    appExitResumeSessionId: null,
    projectPathMutationRequestId: 0,
    projectPathMutationRequest: null,
  };
}

export function ensureWorkbenchState(state: WorkbenchState | undefined): WorkbenchState {
  if (state === undefined) return getDefaultWorkbenchState();
  const persisted = state as WorkbenchState & {
    readonly surfaceMaximized?: boolean;
    readonly rail?: WorkbenchRail;
    readonly fileRailPath?: string | null;
    readonly composerDraftRequest?: WorkbenchState["composerDraftRequest"];
    readonly appExitRequestId?: number;
    readonly appExitResumeSessionId?: string | null;
    readonly projectPathMutationRequestId?: number;
    readonly projectPathMutationRequest?: WorkbenchState["projectPathMutationRequest"];
  };
  if (
    persisted.surfaceMaximized !== undefined &&
    persisted.rail !== undefined &&
    persisted.composerDraftRequest !== undefined &&
    persisted.appExitRequestId !== undefined &&
    persisted.appExitResumeSessionId !== undefined &&
    persisted.projectPathMutationRequestId !== undefined &&
    persisted.projectPathMutationRequest !== undefined
  ) {
    return state;
  }
  return {
    ...state,
    surfaceMaximized: persisted.surfaceMaximized ?? false,
    composerDraftRequest: persisted.composerDraftRequest ?? null,
    appExitRequestId: persisted.appExitRequestId ?? 0,
    appExitResumeSessionId: persisted.appExitResumeSessionId ?? null,
    projectPathMutationRequestId: persisted.projectPathMutationRequestId ?? 0,
    projectPathMutationRequest: persisted.projectPathMutationRequest ?? null,
    rail: persisted.rail ??
      (persisted.fileRailPath
        ? { kind: "file", path: persisted.fileRailPath }
        : null),
  };
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
        openDiffId: command.diffId === undefined ? state.openDiffId : command.diffId,
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
      if (state.projectPathMutationRequest?.id !== command.requestId) return state;
      return { ...state, projectPathMutationRequest: null };
    case "renamePathReferences": {
      const nextState = renamePathReferences(state, command.fromPath, command.toPath);
      if (
        command.openAffectedBuffer === true &&
        nextState.activeFilePath !== null &&
        nextState.activeFilePath !== state.activeFilePath
      ) {
        return openSurface(nextState, "buffer", false);
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
        surfaceMaximized: command.visible === false ? state.surfaceMaximized : false,
        focusedPane:
          command.visible === false && state.focusedPane === "explorer"
            ? "surface"
            : state.focusedPane,
      };
    case "toggleAgents":
      return {
        ...state,
        agentsVisible: command.visible ?? !state.agentsVisible,
        surfaceMaximized: command.visible === false ? state.surfaceMaximized : false,
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
    case "handoffToComposer": {
      const attached = attach(state, command.attachment);
      const nextDraftId = (state.composerDraftRequest?.id ?? 0) + 1;
      return {
        ...attached,
        focusedPane: "composer",
        surfaceMaximized: false,
        rail: command.openTranscriptRail === false
          ? state.rail
          : { kind: "transcript" },
        composerDraftRequest: command.draftText && command.draftText.trim().length > 0
          ? { id: nextDraftId, text: command.draftText }
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
        surfaceMaximized: command.rail === null ? state.surfaceMaximized : false,
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
  if (state.focusedPane === "explorer" && !state.explorerVisible) return "surface";
  if (state.focusedPane === "agents" && !state.agentsVisible) return "surface";
  if (state.focusedPane === "rail" && state.rail === null) return "surface";
  return state.focusedPane;
}

export function composerAttachmentsForState(
  state: WorkbenchState,
): readonly WorkbenchAttachment[] {
  const attachmentsById = new Map(state.attachments.map((item) => [item.id, item]));
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
  return {
    ...state,
    activeSurfaceMode: mode,
    surfaceMaximized: mode === "buffer" ? state.surfaceMaximized : false,
    focusedPane: focus ? "surface" : state.focusedPane,
    // A transcript rail is useful beside BUFFER, but once the transcript
    // becomes the center surface it would mount the same transcript twice
    // (including the same scroll ref). File and change-review rails remain
    // valid sidecars and must survive the surface transition.
    rail:
      mode === "transcript" && state.rail?.kind === "transcript"
        ? null
        : state.rail,
  };
}

function focusPane(state: WorkbenchState, pane: WorkbenchPane): WorkbenchState {
  if (pane === "explorer" && !state.explorerVisible) {
    return { ...state, explorerVisible: true, surfaceMaximized: false, focusedPane: pane };
  }
  if (pane === "agents" && !state.agentsVisible) {
    return { ...state, agentsVisible: true, surfaceMaximized: false, focusedPane: pane };
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
  const panes = visiblePanes.length > 0 ? visiblePanes : (["surface", "composer"] as const);
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
  return {
    ...state,
    attachments,
    composerAttachmentIds: attachments.map((item) => item.id),
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
  const composerAttachmentIds = unique(
    state.composerAttachmentIds
      .map((id) => attachmentIdMap.get(id) ?? id)
      .filter((id) => attachmentIds.has(id)),
  );
  return {
    ...state,
    activeFilePath:
      renameWorkspacePathReference(
        state.activeFilePath,
        normalizedFromPath,
        normalizedToPath,
      ) ?? state.activeFilePath,
    attachments,
    composerAttachmentIds,
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
  const attachments = state.attachments.filter((attachment) =>
    !containsWorkspacePathReference(attachment.path ?? null, deletedPath)
  );
  const attachmentIds = new Set(attachments.map((item) => item.id));
  return {
    ...state,
    activeFilePath: activeFileDeleted ? null : state.activeFilePath,
    activeFileLine: activeFileDeleted ? null : state.activeFileLine,
    attachments,
    composerAttachmentIds: state.composerAttachmentIds.filter((id) => attachmentIds.has(id)),
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
  if (!nextPath || nextPath === attachment.path) return attachment;
  return {
    ...attachment,
    id: replaceFirst(attachment.id, attachment.path ?? "", nextPath),
    path: nextPath,
    label: replaceFirst(attachment.label, attachment.path ?? "", nextPath),
  };
}

function replaceFirst(value: string, needle: string, replacement: string): string {
  if (!needle) return value;
  const index = value.indexOf(needle);
  if (index < 0) return value;
  return `${value.slice(0, index)}${replacement}${value.slice(index + needle.length)}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
