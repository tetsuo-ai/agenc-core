import { resolveWatchSessionLabel } from "./agenc-watch-session-indexing.mjs";

function sanitizeInsightsText(value, fallback = "n/a") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : fallback;
}

function formatCount(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export function buildWatchInsightsReport({
  projectRoot = process.cwd(),
  watchState,
  surfaceSummary = null,
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
  ];
  return lines.join("\n");
}
