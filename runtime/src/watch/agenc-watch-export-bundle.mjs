import os from "node:os";
import path from "node:path";
import {
  resolveWatchSessionLabel,
  serializeWatchSessionLabels,
} from "./agenc-watch-session-indexing.mjs";
import {
  TRANSCRIPT_VISIBLE_TOOL_INPUT_FIELDS,
  TRANSCRIPT_VISIBLE_TOOL_RESULT_FIELDS,
} from "./agenc-watch-transcript-cards.mjs";

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

function redactAbsolutePaths(value, workspaceRoot) {
  if (typeof value !== "string") {
    return value;
  }
  const root = sanitizeBundleText(workspaceRoot, null);
  if (root && value.startsWith(root)) {
    const relative = value.slice(root.length).replace(/^\/+/, "");
    return relative.length > 0 ? relative : ".";
  }
  if (value.startsWith("/")) {
    return path.basename(value);
  }
  return value;
}

function sanitizeBundleValue(value, { workspaceRoot, depth = 0 } = {}) {
  if (depth > 6) {
    return "[truncated]";
  }
  if (value == null) {
    return value ?? null;
  }
  if (typeof value === "string") {
    const normalized = redactAbsolutePaths(value, workspaceRoot);
    if (/authorization|api[_-]?key|token|secret/i.test(normalized)) {
      return "[redacted]";
    }
    if (normalized.length > 400) {
      return `${normalized.slice(0, 397)}...`;
    }
    if (/^diff --git /m.test(normalized) || /^\@\@/m.test(normalized)) {
      return "[diff redacted]";
    }
    return normalized;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) =>
      sanitizeBundleValue(entry, { workspaceRoot, depth: depth + 1 }),
    );
  }
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/authorization|api[_-]?key|token|secret|password|credential/i.test(key)) {
      output[key] = "[redacted]";
      continue;
    }
    if (/args|payload/i.test(key) && depth > 1) {
      output[key] = "[redacted]";
      continue;
    }
    output[key] = sanitizeBundleValue(entry, {
      workspaceRoot,
      depth: depth + 1,
    });
  }
  return output;
}

function normalizeSurfaceEntry(entry, fallbackReason = null) {
  if (typeof entry === "string") {
    return {
      name: entry,
      reason: fallbackReason,
    };
  }
  if (entry && typeof entry === "object") {
    return {
      name: sanitizeBundleText(entry.name ?? entry.surface ?? entry.id, "external"),
      reason: sanitizeBundleText(entry.reason ?? entry.disabledReason, fallbackReason),
    };
  }
  return null;
}

function normalizeSurfaceList(value, fallbackReason = null) {
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([name, reason]) =>
        normalizeSurfaceEntry(
          {
            name,
            reason: typeof reason === "string" ? reason : reason?.reason,
          },
          fallbackReason,
        ),
      )
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeSurfaceEntry(entry, fallbackReason))
      .filter(Boolean);
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([name, reason]) =>
        normalizeSurfaceEntry(
          {
            name,
            reason: typeof reason === "string" ? reason : reason?.reason,
          },
          fallbackReason,
        ),
      )
      .filter(Boolean);
  }
  return [];
}

function buildExportMetadata(watchState) {
  const noPhoneHome = watchState.noPhoneHome === true
    || watchState.noPhoneHomeMode === true
    || watchState.featureFlags?.noPhoneHome === true;
  const unsupported = normalizeSurfaceList(
    watchState.unsupportedExternalSurfaces,
    "unsupported by watch console",
  );
  const disabled = normalizeSurfaceList(watchState.disabledExternalSurfaces);
  if (noPhoneHome) {
    disabled.push(
      { name: "WebFetch", reason: "no-phone-home mode" },
      { name: "WebSearch", reason: "no-phone-home mode" },
      { name: "Remote sessions", reason: "no-phone-home mode" },
      { name: "TaskOutput", reason: "no-phone-home mode" },
    );
  }
  if (watchState.featureFlags?.remoteTools === false) {
    disabled.push({ name: "Remote tools", reason: "feature flag disabled" });
  }
  return {
    application: "AgenC watch",
    renderer: {
      name: "agenc-watch-console",
      branding: "AgenC",
      source: "watch",
    },
    search: {
      visibleTextOnly: true,
      excludesSystemReminders: true,
      indexedToolInputFields: [...TRANSCRIPT_VISIBLE_TOOL_INPUT_FIELDS],
      indexedToolResultFields: [...TRANSCRIPT_VISIBLE_TOOL_RESULT_FIELDS],
    },
    dump: {
      format: "agenc-watch-export-bundle",
      eventLimit: 200,
      redactsSecrets: true,
      redactsDiffs: true,
      redactsAbsolutePaths: true,
    },
    externalSurfaces: {
      noPhoneHome,
      unsupported,
      disabled,
    },
  };
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
    schemaVersion: 2,
    exportedAtMs: exportedAt,
    exportedAtIso: new Date(exportedAt).toISOString(),
    workspaceRoot: sanitizeBundleText(projectRoot, process.cwd()),
    metadata: sanitizeBundleValue(buildExportMetadata(watchState), { workspaceRoot: projectRoot }),
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
    summary: sanitizeBundleValue(cloneBundleValue(surfaceSummary), { workspaceRoot: projectRoot }),
    pendingAttachments: sanitizeBundleValue(cloneBundleValue(watchState.pendingAttachments ?? []), { workspaceRoot: projectRoot }),
    sessionLabels: serializeWatchSessionLabels(watchState.sessionLabels),
    checkpoints: sanitizeBundleValue(cloneBundleValue(watchState.checkpoints ?? []), { workspaceRoot: projectRoot }),
    queuedOperatorInputs: sanitizeBundleValue(cloneBundleValue(watchState.queuedOperatorInputs ?? []), { workspaceRoot: projectRoot }),
    events: sanitizeBundleValue(cloneBundleValue((watchState.events ?? []).slice(-200)), { workspaceRoot: projectRoot }),
    detailSnapshot: sanitizeBundleValue(cloneBundleValue(frameSnapshot), { workspaceRoot: projectRoot }),
    cockpit: sanitizeBundleValue(cloneBundleValue(watchState.cockpit ?? null), { workspaceRoot: projectRoot }),
    planner: {
      status: sanitizeBundleText(watchState.plannerDagStatus, "idle"),
      note: sanitizeBundleText(watchState.plannerDagNote),
      updatedAt: Number.isFinite(Number(watchState.plannerDagUpdatedAt))
        ? Number(watchState.plannerDagUpdatedAt)
        : 0,
      pipelineId: sanitizeBundleText(watchState.plannerDagPipelineId),
      nodes: sanitizeBundleValue(cloneBundleValue(
        watchState.plannerDagNodes instanceof Map
          ? [...watchState.plannerDagNodes.values()]
          : [],
      ), { workspaceRoot: projectRoot }),
      edges: sanitizeBundleValue(cloneBundleValue(watchState.plannerDagEdges ?? []), { workspaceRoot: projectRoot }),
    },
    subagents: {
      planSteps: sanitizeBundleValue(cloneBundleValue(
        watchState.subagentPlanSteps instanceof Map
          ? [...watchState.subagentPlanSteps.values()]
          : [],
      ), { workspaceRoot: projectRoot }),
      liveActivity: sanitizeBundleValue(cloneBundleValue(
        watchState.subagentLiveActivity instanceof Map
          ? [...watchState.subagentLiveActivity.entries()].map(([sessionId, activity]) => ({
            sessionId,
            activity,
          }))
          : [],
      ), { workspaceRoot: projectRoot }),
    },
    status: sanitizeBundleValue(cloneBundleValue(watchState.lastStatus), { workspaceRoot: projectRoot }),
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
