import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgenCConfigHomeDir } from "../../utils/envUtils.js";
import { ensureWorkbenchState, getDefaultWorkbenchState } from "./reducer.js";
import type {
  AgentSurfaceMode,
  WorkbenchPane,
  WorkbenchRail,
  WorkbenchState,
  WorkspaceView,
} from "./types.js";

const UI_STATE_VERSION = 1;
const MAX_STATE_BYTES = 64 * 1024;

type WorkbenchUiStateV1 = {
  readonly version: 1;
  readonly conversationId: string;
  readonly workspaceCwd: string;
  readonly activeWorkspaceView: WorkspaceView;
  readonly agentFocusedPane: WorkbenchPane;
  readonly editorFocusedPane: WorkbenchPane;
  readonly agentSurfaceMode: AgentSurfaceMode;
  readonly agentRail: WorkbenchRail;
  readonly editorRail: WorkbenchRail;
  readonly agentActiveFilePath: string | null;
  readonly agentActiveFileLine: number | null;
  readonly editorActiveFilePath: string | null;
  readonly editorActiveFileLine: number | null;
  readonly explorerVisible: boolean;
  readonly agentsVisible: boolean;
  readonly surfaceMaximized: boolean;
};

export function workbenchUiStatePath(
  conversationId: string,
  workspaceCwd: string,
  agencHome = getAgenCConfigHomeDir(),
): string {
  const identity = createHash("sha256")
    .update(conversationId)
    .update("\0")
    .update(workspaceCwd)
    .digest("hex");
  return join(agencHome, "ui-state", identity, "workbench-v1.json");
}

export function loadWorkbenchUiState(
  conversationId: string,
  workspaceCwd: string,
  agencHome = getAgenCConfigHomeDir(),
): WorkbenchState {
  const fallback = getDefaultWorkbenchState();
  try {
    const path = workbenchUiStatePath(conversationId, workspaceCwd, agencHome);
    const raw = readFileSync(path);
    if (raw.byteLength > MAX_STATE_BYTES) return fallback;
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (!isWorkbenchUiStateV1(parsed)) return fallback;
    if (
      parsed.conversationId !== conversationId ||
      parsed.workspaceCwd !== workspaceCwd
    ) {
      return fallback;
    }
    const activeWorkspaceView = parsed.activeWorkspaceView;
    const rail =
      activeWorkspaceView === "editor" ? parsed.editorRail : parsed.agentRail;
    const focusedPane =
      activeWorkspaceView === "editor"
        ? parsed.editorFocusedPane
        : parsed.agentFocusedPane;
    return ensureWorkbenchState({
      ...fallback,
      activeWorkspaceView,
      agentFocusedPane: parsed.agentFocusedPane,
      editorFocusedPane: parsed.editorFocusedPane,
      agentSurfaceMode: parsed.agentSurfaceMode,
      agentRail: parsed.agentRail,
      editorRail: parsed.editorRail,
      agentActiveFilePath: parsed.agentActiveFilePath,
      agentActiveFileLine: parsed.agentActiveFileLine,
      editorActiveFilePath: parsed.editorActiveFilePath,
      editorActiveFileLine: parsed.editorActiveFileLine,
      activeSurfaceMode:
        activeWorkspaceView === "editor" ? "buffer" : parsed.agentSurfaceMode,
      activeFilePath:
        activeWorkspaceView === "editor"
          ? parsed.editorActiveFilePath
          : parsed.agentActiveFilePath,
      activeFileLine:
        activeWorkspaceView === "editor"
          ? parsed.editorActiveFileLine
          : parsed.agentActiveFileLine,
      focusedPane,
      rail,
      explorerVisible: parsed.explorerVisible,
      agentsVisible: parsed.agentsVisible,
      surfaceMaximized:
        activeWorkspaceView === "editor" && parsed.surfaceMaximized,
    });
  } catch {
    return fallback;
  }
}

export async function saveWorkbenchUiState(
  conversationId: string,
  workspaceCwd: string,
  state: WorkbenchState,
  agencHome = getAgenCConfigHomeDir(),
): Promise<void> {
  const path = workbenchUiStatePath(conversationId, workspaceCwd, agencHome);
  const current = ensureWorkbenchState(state);
  const payload: WorkbenchUiStateV1 = {
    version: UI_STATE_VERSION,
    conversationId,
    workspaceCwd,
    activeWorkspaceView: current.activeWorkspaceView,
    agentFocusedPane: current.agentFocusedPane,
    editorFocusedPane: current.editorFocusedPane,
    agentSurfaceMode: current.agentSurfaceMode,
    agentRail: sanitizeRail(current.agentRail),
    editorRail: sanitizeRail(current.editorRail),
    agentActiveFilePath: sanitizePath(current.agentActiveFilePath),
    agentActiveFileLine: sanitizeLine(current.agentActiveFileLine),
    editorActiveFilePath: sanitizePath(current.editorActiveFilePath),
    editorActiveFileLine: sanitizeLine(current.editorActiveFileLine),
    explorerVisible: current.explorerVisible,
    agentsVisible: current.agentsVisible,
    surfaceMaximized: current.surfaceMaximized,
  };
  const encoded = `${JSON.stringify(payload, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, encoded, { mode: 0o600 });
  await rename(temporaryPath, path);
}

function isWorkbenchUiStateV1(value: unknown): value is WorkbenchUiStateV1 {
  if (!isRecord(value) || value.version !== UI_STATE_VERSION) return false;
  if (
    typeof value.conversationId !== "string" ||
    typeof value.workspaceCwd !== "string" ||
    !isWorkspaceView(value.activeWorkspaceView) ||
    !isWorkbenchPane(value.agentFocusedPane) ||
    !isWorkbenchPane(value.editorFocusedPane) ||
    !isAgentSurfaceMode(value.agentSurfaceMode) ||
    !isRail(value.agentRail) ||
    !isRail(value.editorRail) ||
    !isPath(value.agentActiveFilePath) ||
    !isLine(value.agentActiveFileLine) ||
    !isPath(value.editorActiveFilePath) ||
    !isLine(value.editorActiveFileLine) ||
    typeof value.explorerVisible !== "boolean" ||
    typeof value.agentsVisible !== "boolean" ||
    typeof value.surfaceMaximized !== "boolean"
  ) {
    return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkspaceView(value: unknown): value is WorkspaceView {
  return value === "agent" || value === "editor";
}

function isWorkbenchPane(value: unknown): value is WorkbenchPane {
  return (
    value === "explorer" ||
    value === "surface" ||
    value === "agents" ||
    value === "composer" ||
    value === "rail"
  );
}

function isAgentSurfaceMode(value: unknown): value is AgentSurfaceMode {
  return (
    value === "transcript" ||
    value === "preview" ||
    value === "diff" ||
    value === "test" ||
    value === "shell" ||
    value === "search" ||
    value === "task-detail"
  );
}

function isPath(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && value.length <= 4096 && !value.includes("\0"))
  );
}

function isLine(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 1)
  );
}

function isRail(value: unknown): value is WorkbenchRail {
  if (value === null) return true;
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "transcript") return true;
  if (value.kind === "file") return isPath(value.path) && value.path !== null;
  return (
    value.kind === "change-review" &&
    typeof value.changeId === "string" &&
    value.changeId.length <= 4096
  );
}

function sanitizePath(value: string | null): string | null {
  return isPath(value) ? value : null;
}

function sanitizeLine(value: number | null): number | null {
  return isLine(value) ? value : null;
}

function sanitizeRail(value: WorkbenchRail): WorkbenchRail {
  return isRail(value) ? value : null;
}
