import os from "node:os";
import path from "node:path";
import {
  resolveWatchSessionLabel,
  serializeWatchSessionLabels,
} from "./agenc-watch-session-indexing.mjs";

function cloneBundleValue(value) {
  if (value == null) {
    return value ?? null;
  }
  if (typeof value !== "object") {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Array.isArray(value) ? [] : {};
  }
}

function sanitizeBundleText(value, fallback = null) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : fallback;
}

export function buildWatchExportBundle({
  projectRoot = process.cwd(),
  watchState,
  surfaceSummary = null,
  frameSnapshot = null,
  exportedAtMs = Date.now(),
} = {}) {
  if (!watchState || typeof watchState !== "object") {
    throw new TypeError("buildWatchExportBundle requires a watchState object");
  }
  const exportedAt = Number.isFinite(Number(exportedAtMs))
    ? Number(exportedAtMs)
    : Date.now();
  return {
    schemaVersion: 1,
    exportedAtMs: exportedAt,
    exportedAtIso: new Date(exportedAt).toISOString(),
    workspaceRoot: sanitizeBundleText(projectRoot, process.cwd()),
    session: {
      sessionId: sanitizeBundleText(watchState.sessionId),
      sessionLabel: sanitizeBundleText(
        resolveWatchSessionLabel(watchState.sessionId, watchState.sessionLabels),
      ),
      currentObjective: sanitizeBundleText(watchState.currentObjective),
      runState: sanitizeBundleText(watchState.runState, "idle"),
      runPhase: sanitizeBundleText(watchState.runPhase),
      activeRunStartedAtMs: Number.isFinite(Number(watchState.activeRunStartedAtMs))
        ? Number(watchState.activeRunStartedAtMs)
        : null,
      sessionAttachedAtMs: Number.isFinite(Number(watchState.sessionAttachedAtMs))
        ? Number(watchState.sessionAttachedAtMs)
        : null,
      lastUsageSummary: sanitizeBundleText(watchState.lastUsageSummary),
      lastActivityAt: sanitizeBundleText(watchState.lastActivityAt),
      configuredModelRoute: cloneBundleValue(watchState.configuredModelRoute),
      liveSessionModelRoute: cloneBundleValue(watchState.liveSessionModelRoute),
      activeCheckpointId: sanitizeBundleText(watchState.activeCheckpointId),
    },
    summary: cloneBundleValue(surfaceSummary),
    pendingAttachments: cloneBundleValue(watchState.pendingAttachments ?? []),
    sessionLabels: serializeWatchSessionLabels(watchState.sessionLabels),
    checkpoints: cloneBundleValue(watchState.checkpoints ?? []),
    queuedOperatorInputs: cloneBundleValue(watchState.queuedOperatorInputs ?? []),
    events: cloneBundleValue(watchState.events ?? []),
    detailSnapshot: cloneBundleValue(frameSnapshot),
    planner: {
      status: sanitizeBundleText(watchState.plannerDagStatus, "idle"),
      note: sanitizeBundleText(watchState.plannerDagNote),
      updatedAt: Number.isFinite(Number(watchState.plannerDagUpdatedAt))
        ? Number(watchState.plannerDagUpdatedAt)
        : 0,
      pipelineId: sanitizeBundleText(watchState.plannerDagPipelineId),
      nodes: cloneBundleValue(
        watchState.plannerDagNodes instanceof Map
          ? [...watchState.plannerDagNodes.values()]
          : [],
      ),
      edges: cloneBundleValue(watchState.plannerDagEdges ?? []),
    },
    subagents: {
      planSteps: cloneBundleValue(
        watchState.subagentPlanSteps instanceof Map
          ? [...watchState.subagentPlanSteps.values()]
          : [],
      ),
      liveActivity: cloneBundleValue(
        watchState.subagentLiveActivity instanceof Map
          ? [...watchState.subagentLiveActivity.entries()].map(([sessionId, activity]) => ({
            sessionId,
            activity,
          }))
          : [],
      ),
    },
    status: cloneBundleValue(watchState.lastStatus),
  };
}

export function writeWatchExportBundle({
  fs,
  bundle,
  outputDir = os.tmpdir(),
  nowMs = Date.now,
  pathModule = path,
} = {}) {
  if (!fs || typeof fs.writeFileSync !== "function") {
    throw new TypeError("writeWatchExportBundle requires an fs object with writeFileSync");
  }
  if (!bundle || typeof bundle !== "object") {
    throw new TypeError("writeWatchExportBundle requires a bundle object");
  }
  const timestamp = typeof nowMs === "function" ? nowMs() : Date.now();
  const exportPath = pathModule.join(
    outputDir,
    `agenc-watch-bundle-${timestamp}.json`,
  );
  fs.writeFileSync(exportPath, `${JSON.stringify(bundle, null, 2)}\n`);
  return exportPath;
}
