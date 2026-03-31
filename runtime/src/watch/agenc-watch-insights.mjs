import { resolveWatchSessionLabel } from "./agenc-watch-session-indexing.mjs";

function sanitizeInsightsText(value, fallback = "n/a") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : fallback;
}

function formatCount(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function formatMaintenanceTimestamp(value, fallback = "never") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return new Date(numeric).toLocaleString();
}

function buildWatchMaintenanceLines({
  surfaceSummary = null,
  maintenanceStatus = null,
  workspaceIndex = null,
} = {}) {
  const summary = surfaceSummary?.overview ?? {};
  const sync = maintenanceStatus?.sync ?? {};
  const memory = maintenanceStatus?.memory ?? {};
  const workspaceFileCount = Array.isArray(workspaceIndex?.files)
    ? workspaceIndex.files.length
    : 0;
  const recentSessions = Array.isArray(memory.recentSessions)
    ? memory.recentSessions
        .slice(0, 3)
        .map((session) =>
          `${sanitizeInsightsText(session.id, "unknown")} (${formatCount(session.messageCount)} msgs, last ${formatMaintenanceTimestamp(session.lastActiveAt)})`,
        )
    : [];
  return [
    "Maintenance",
    `- Snapshot: ${formatMaintenanceTimestamp(maintenanceStatus?.generatedAt, "pending")}`,
    `- Sync: ${sanitizeInsightsText(summary.syncState, "pending")} (${sanitizeInsightsText(summary.syncLabel, "sync snapshot pending")})`,
    `- Durable: ${sanitizeInsightsText(summary.durableRunsState, "pending")} (${sanitizeInsightsText(summary.durableRunsLabel, "durable status pending")})`,
    `- Memory: ${sanitizeInsightsText(summary.memoryState, "pending")} (${sanitizeInsightsText(summary.memoryLabel, "memory snapshot pending")})`,
    `- Memory last active: ${formatMaintenanceTimestamp(memory.lastActiveAt)}`,
    `- Index: ${sanitizeInsightsText(summary.workspaceIndexState, "pending")} (${sanitizeInsightsText(summary.workspaceIndexLabel, "workspace index pending")})`,
    `- Index files: ${workspaceFileCount}`,
    `- Owner sessions: ${formatCount(sync.ownerSessionCount)}`,
    `- Active session owned: ${sync.activeSessionOwned === true ? "yes" : sync.activeSessionOwned === false ? "no" : "unknown"}`,
    `- Memory sessions/messages: ${formatCount(memory.sessionCount)} / ${formatCount(memory.totalMessages)}`,
    `- Recent memory sessions: ${recentSessions.length > 0 ? recentSessions.join("; ") : "none"}`,
  ];
}

export function buildWatchMaintenanceReport({
  projectRoot = process.cwd(),
  watchState,
  surfaceSummary = null,
  maintenanceStatus = null,
  workspaceIndex = null,
} = {}) {
  if (!watchState || typeof watchState !== "object") {
    throw new TypeError("buildWatchMaintenanceReport requires a watchState object");
  }
  const sessionLabel = resolveWatchSessionLabel(
    watchState.sessionId,
    watchState.sessionLabels,
  );
  const lines = [
    "Watch Maintenance",
    `Workspace: ${sanitizeInsightsText(projectRoot, process.cwd())}`,
    `Session: ${sanitizeInsightsText(watchState.sessionId)}`,
    `Session label: ${sanitizeInsightsText(sessionLabel, "none")}`,
    "",
    ...buildWatchMaintenanceLines({
      surfaceSummary,
      maintenanceStatus,
      workspaceIndex,
    }),
  ];
  return lines.join("\n");
}

export function buildWatchInsightsReport({
  projectRoot = process.cwd(),
  watchState,
  surfaceSummary = null,
  maintenanceStatus = null,
  workspaceIndex = null,
} = {}) {
  if (!watchState || typeof watchState !== "object") {
    throw new TypeError("buildWatchInsightsReport requires a watchState object");
  }
  const summary = surfaceSummary?.overview ?? {};
  const attention = surfaceSummary?.attention ?? {};
  const sessionLabel = resolveWatchSessionLabel(
    watchState.sessionId,
    watchState.sessionLabels,
  );
  const voiceCompanion =
    watchState.voiceCompanion && typeof watchState.voiceCompanion === "object"
      ? watchState.voiceCompanion
      : null;
  const lines = [
    "Watch Insights",
    `Workspace: ${sanitizeInsightsText(projectRoot, process.cwd())}`,
    `Session: ${sanitizeInsightsText(watchState.sessionId)}`,
    `Session label: ${sanitizeInsightsText(sessionLabel, "none")}`,
    `Objective: ${sanitizeInsightsText(watchState.currentObjective ?? summary.activeLine, "none")}`,
    "",
    "Runtime",
    `- Run: ${sanitizeInsightsText(watchState.runState, "idle")} / ${sanitizeInsightsText(watchState.runPhase, "idle")}`,
    `- Link: ${sanitizeInsightsText(summary.connectionState, "unknown")}`,
    `- Route: ${sanitizeInsightsText(summary.modelLabel, "pending")} via ${sanitizeInsightsText(summary.providerLabel, "pending")}`,
    `- Usage: ${sanitizeInsightsText(watchState.lastUsageSummary ?? summary.usage, "n/a")}`,
    `- Last activity: ${sanitizeInsightsText(watchState.lastActivityAt ?? summary.lastActivityAt, "idle")}`,
    `- Run controls: ${watchState.runDetail?.availability?.controlAvailable === false ? "unavailable" : "available"}`,
    `- Checkpoint retry: ${watchState.runDetail?.checkpointAvailable === false ? "unavailable" : "available"}`,
    "",
    "Operator State",
    `- Input mode: ${sanitizeInsightsText(watchState.inputPreferences?.inputModeProfile, "default")}${watchState.inputPreferences?.inputModeProfile === "vim" ? ` (${sanitizeInsightsText(watchState.composerMode, "insert")})` : ""}`,
    `- Theme: ${sanitizeInsightsText(watchState.inputPreferences?.themeName, "default")}`,
    `- Transcript mode: ${sanitizeInsightsText(summary.transcriptMode, "follow")}`,
    `- Queued prompts: ${formatCount(watchState.queuedOperatorInputs?.length)}`,
    `- Pending attachments: ${formatCount(watchState.pendingAttachments?.length)}`,
    `- Checkpoints: ${formatCount(watchState.checkpoints?.length)}${watchState.activeCheckpointId ? ` (active ${watchState.activeCheckpointId})` : ""}`,
    `- Events: ${formatCount(watchState.events?.length)}`,
    `- Runtime skills: ${formatCount(watchState.skillCatalog?.length)}`,
    `- Runtime hooks: ${formatCount(watchState.hookCatalog?.length)}`,
    "",
    "Voice Companion",
    `- Active: ${voiceCompanion?.active === true ? "yes" : "no"}`,
    `- State: ${sanitizeInsightsText(voiceCompanion?.companionState ?? summary.voiceState, voiceCompanion ? "idle" : "inactive")}`,
    `- Connection: ${sanitizeInsightsText(voiceCompanion?.connectionState, voiceCompanion ? "connected" : "disconnected")}`,
    `- Persona: ${sanitizeInsightsText(voiceCompanion?.voice, "default")}`,
    `- Mode: ${sanitizeInsightsText(voiceCompanion?.mode, "vad")}`,
    `- Session: ${sanitizeInsightsText(voiceCompanion?.sessionId, "none")}`,
    `- Shared session: ${sanitizeInsightsText(voiceCompanion?.managedSessionId, "none")}`,
    `- Delegation: ${sanitizeInsightsText(voiceCompanion?.delegationStatus, "idle")}`,
    `- Current task: ${sanitizeInsightsText(voiceCompanion?.currentTask, "none")}`,
    `- Last heard: ${sanitizeInsightsText(voiceCompanion?.lastUserTranscript, "none")}`,
    `- Last reply: ${sanitizeInsightsText(voiceCompanion?.lastAssistantTranscript, "none")}`,
    `- Last error: ${sanitizeInsightsText(voiceCompanion?.lastError, "none")}`,
    "",
    "Planning",
    `- Planner: ${sanitizeInsightsText(watchState.plannerDagStatus, "idle")}`,
    `- Planner note: ${sanitizeInsightsText(watchState.plannerDagNote, "none")}`,
    `- Active agents: ${formatCount(summary.activeAgentCount)}`,
    `- Plan steps: ${formatCount(summary.planCount)}`,
    "",
    "Alerts",
    `- Approvals: ${formatCount(attention.approvalAlertCount)}`,
    `- Errors: ${formatCount(attention.errorAlertCount)}`,
    "",
    ...buildWatchMaintenanceLines({
      surfaceSummary,
      maintenanceStatus,
      workspaceIndex,
    }),
  ];
  return lines.join("\n");
}
