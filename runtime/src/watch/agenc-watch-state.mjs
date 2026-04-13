import {
  createWatchSessionLabelMap,
  serializeWatchSessionLabels,
} from "./agenc-watch-session-indexing.mjs";
import {
  createWatchUiPreferences,
  serializeWatchUiPreferences,
} from "./agenc-watch-ui-preferences.mjs";

export const WATCH_STATE_PRIMITIVE_KEYS = Object.freeze([
  "sessionId",
  "runState",
  "runPhase",
  "connectionState",
  "latestTool",
  "latestToolState",
  "latestAgentSummary",
  "currentObjective",
  "runDetail",
  "activeRunStartedAtMs",
  "runInspectPending",
  "bootstrapAttempts",
  "bootstrapReady",
  "introDismissed",
  "sessionAttachedAtMs",
  "transientStatus",
  "lastStatus",
  "lastUsageSummary",
  "lastActivityAt",
  "configuredModelRoute",
  "liveSessionModelRoute",
  "ownerToken",
  "lastStatusFeedFingerprint",
  "manualSessionsRequestPending",
  "manualSessionsQuery",
  "pendingResumeHistoryRestore",
  "attachmentSequence",
  "expandedEventId",
  "composerInput",
  "composerCursor",
  "composerHistory",
  "composerHistoryIndex",
  "composerHistoryDraft",
  "transcriptScrollOffset",
  "transcriptFollowMode",
  "detailScrollOffset",
  "planStepSequence",
  "plannerDagPipelineId",
  "plannerDagStatus",
  "plannerDagNote",
  "plannerDagUpdatedAt",
  "plannerDagHydratedSessionId",
  "workflowStage",
  "workflowStageUpdatedAt",
  "workflowOwnershipSummary",
  "workflowOwnershipUpdatedAt",
  "cockpit",
  "cockpitUpdatedAt",
  "cockpitFingerprint",
  "eventCategoryFilter",
]);

const WATCH_CHECKPOINT_STATE_KEYS = Object.freeze([
  "sessionId",
  "runState",
  "runPhase",
  "latestTool",
  "latestToolState",
  "latestAgentSummary",
  "currentObjective",
  "runDetail",
  "activeRunStartedAtMs",
  "bootstrapReady",
  "introDismissed",
  "sessionAttachedAtMs",
  "lastStatus",
  "lastUsageSummary",
  "lastActivityAt",
  "configuredModelRoute",
  "liveSessionModelRoute",
  "expandedEventId",
  "composerInput",
  "composerCursor",
  "composerHistory",
  "composerHistoryIndex",
  "composerHistoryDraft",
  "transcriptScrollOffset",
  "transcriptFollowMode",
  "detailScrollOffset",
  "planStepSequence",
  "plannerDagPipelineId",
  "plannerDagStatus",
  "plannerDagNote",
  "plannerDagUpdatedAt",
  "plannerDagHydratedSessionId",
  "workflowStage",
  "workflowStageUpdatedAt",
  "workflowOwnershipSummary",
  "workflowOwnershipUpdatedAt",
  "cockpit",
  "cockpitUpdatedAt",
  "cockpitFingerprint",
  "eventCategoryFilter",
]);

export const DEFAULT_WATCH_CHECKPOINT_LIMIT = 12;

const DEFAULT_BOUND_STATE_KEYS = Object.freeze([
  "sessionId",
  "ownerToken",
  "sessionAttachedAtMs",
  "runDetail",
  "runState",
  "runPhase",
  "bootstrapReady",
  "manualSessionsRequestPending",
  "manualSessionsQuery",
  "pendingResumeHistoryRestore",
  "currentObjective",
  "activeRunStartedAtMs",
  "latestAgentSummary",
  "latestTool",
  "latestToolState",
  "runInspectPending",
  "lastUsageSummary",
  "liveSessionModelRoute",
  "lastStatus",
  "cockpit",
  "cockpitUpdatedAt",
  "cockpitFingerprint",
  "configuredModelRoute",
  "lastStatusFeedFingerprint",
  "eventCategoryFilter",
]);

function normalizeStoredValue(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeCheckpointLabel(value, fallback = null) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : fallback;
}

function normalizeCheckpointReason(value) {
  return normalizeCheckpointLabel(value, "manual");
}

function cloneCheckpointValue(value) {
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

function cloneCheckpointEntries(mapLike) {
  if (!(mapLike instanceof Map)) {
    return [];
  }
  return [...mapLike.entries()].map(([key, value]) => [
    String(key),
    cloneCheckpointValue(value),
  ]);
}

function restoreArray(target, values) {
  target.length = 0;
  if (Array.isArray(values) && values.length > 0) {
    target.push(...cloneCheckpointValue(values));
  }
}

function restoreMap(target, entries) {
  target.clear();
  if (!Array.isArray(entries)) {
    return;
  }
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }
    const key = normalizeCheckpointLabel(entry[0], null);
    if (!key) {
      continue;
    }
    target.set(key, cloneCheckpointValue(entry[1]));
  }
}

function checkpointSummaryFromState(state, {
  id,
  label,
  reason = "manual",
  createdAtMs = Date.now(),
} = {}) {
  const normalizedId = normalizeCheckpointLabel(id, null);
  if (!normalizedId) {
    return null;
  }
  return {
    id: normalizedId,
    label: normalizeCheckpointLabel(label, normalizedId),
    reason: normalizeCheckpointReason(reason),
    createdAtMs: Number.isFinite(Number(createdAtMs)) ? Number(createdAtMs) : Date.now(),
    sessionId: normalizeStoredValue(state?.sessionId),
    objective: normalizeCheckpointLabel(state?.currentObjective, null),
    runState: normalizeCheckpointLabel(state?.runState, "idle"),
    eventCount: Array.isArray(state?.events) ? state.events.length : 0,
  };
}

function checkpointSummaryRecord(summary, { activeCheckpointId = null } = {}) {
  if (!summary || typeof summary !== "object") {
    return null;
  }
  const id = normalizeCheckpointLabel(summary.id, null);
  if (!id) {
    return null;
  }
  return {
    id,
    label: normalizeCheckpointLabel(summary.label, id),
    reason: normalizeCheckpointReason(summary.reason),
    createdAtMs: Number.isFinite(Number(summary.createdAtMs))
      ? Number(summary.createdAtMs)
      : 0,
    sessionId: normalizeStoredValue(summary.sessionId),
    objective: normalizeCheckpointLabel(summary.objective, null),
    runState: normalizeCheckpointLabel(summary.runState, "idle"),
    eventCount: Number.isFinite(Number(summary.eventCount))
      ? Number(summary.eventCount)
      : 0,
    active: id === normalizeCheckpointLabel(activeCheckpointId, null),
  };
}

function normalizeCheckpointSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }
  return {
    primitives:
      snapshot.primitives && typeof snapshot.primitives === "object"
        ? cloneCheckpointValue(snapshot.primitives)
        : {},
    composerPastedRanges: Array.isArray(snapshot.composerPastedRanges)
      ? cloneCheckpointValue(snapshot.composerPastedRanges)
      : [],
    composerPasteSequence: Number.isFinite(Number(snapshot.composerPasteSequence))
      ? Number(snapshot.composerPasteSequence)
      : 0,
    queuedOperatorInputs: Array.isArray(snapshot.queuedOperatorInputs)
      ? cloneCheckpointValue(snapshot.queuedOperatorInputs)
      : [],
    pendingAttachments: Array.isArray(snapshot.pendingAttachments)
      ? cloneCheckpointValue(snapshot.pendingAttachments)
      : [],
    attachmentSequence: Number.isFinite(Number(snapshot.attachmentSequence))
      ? Number(snapshot.attachmentSequence)
      : 0,
    subagentPlanSteps: Array.isArray(snapshot.subagentPlanSteps)
      ? cloneCheckpointValue(snapshot.subagentPlanSteps)
      : [],
    subagentSessionPlanKeys: Array.isArray(snapshot.subagentSessionPlanKeys)
      ? cloneCheckpointValue(snapshot.subagentSessionPlanKeys)
      : [],
    subagentLiveActivity: Array.isArray(snapshot.subagentLiveActivity)
      ? cloneCheckpointValue(snapshot.subagentLiveActivity)
      : [],
    recentSubagentLifecycleFingerprints: Array.isArray(snapshot.recentSubagentLifecycleFingerprints)
      ? cloneCheckpointValue(snapshot.recentSubagentLifecycleFingerprints)
      : [],
    subagentToolArgs: Array.isArray(snapshot.subagentToolArgs)
      ? cloneCheckpointValue(snapshot.subagentToolArgs)
      : [],
    plannerDagNodes: Array.isArray(snapshot.plannerDagNodes)
      ? cloneCheckpointValue(snapshot.plannerDagNodes)
      : [],
    plannerDagEdges: Array.isArray(snapshot.plannerDagEdges)
      ? cloneCheckpointValue(snapshot.plannerDagEdges)
      : [],
    events: Array.isArray(snapshot.events)
      ? cloneCheckpointValue(snapshot.events)
      : [],
  };
}

function serializeCheckpointSnapshot(state) {
  const primitives = Object.fromEntries(
    WATCH_CHECKPOINT_STATE_KEYS.map((key) => [key, cloneCheckpointValue(state[key])]),
  );
  return {
    primitives,
    composerPastedRanges: cloneCheckpointValue(state.composerPastedRanges ?? []),
    composerPasteSequence: Number.isFinite(Number(state.composerPasteSequence))
      ? Number(state.composerPasteSequence)
      : 0,
    queuedOperatorInputs: cloneCheckpointValue(state.queuedOperatorInputs ?? []),
    pendingAttachments: cloneCheckpointValue(state.pendingAttachments ?? []),
    attachmentSequence: Number.isFinite(Number(state.attachmentSequence))
      ? Number(state.attachmentSequence)
      : 0,
    subagentPlanSteps: cloneCheckpointEntries(state.subagentPlanSteps),
    subagentSessionPlanKeys: cloneCheckpointEntries(state.subagentSessionPlanKeys),
    subagentLiveActivity: cloneCheckpointEntries(state.subagentLiveActivity),
    recentSubagentLifecycleFingerprints: cloneCheckpointEntries(
      state.recentSubagentLifecycleFingerprints,
    ),
    subagentToolArgs: cloneCheckpointEntries(state.subagentToolArgs),
    plannerDagNodes: cloneCheckpointEntries(state.plannerDagNodes),
    plannerDagEdges: cloneCheckpointValue(state.plannerDagEdges ?? []),
    events: cloneCheckpointValue(state.events ?? []),
  };
}

function trimCheckpointCollections(state, limit = DEFAULT_WATCH_CHECKPOINT_LIMIT) {
  const normalizedLimit = Number.isFinite(Number(limit))
    ? Math.max(0, Math.floor(Number(limit)))
    : DEFAULT_WATCH_CHECKPOINT_LIMIT;
  while (state.checkpoints.length > normalizedLimit) {
    const removed = state.checkpoints.shift();
    if (removed?.id) {
      state.checkpointSnapshots.delete(removed.id);
      if (state.activeCheckpointId === removed.id) {
        state.activeCheckpointId = null;
      }
    }
  }
  if (!state.activeCheckpointId && state.checkpoints.length > 0) {
    state.activeCheckpointId = state.checkpoints[state.checkpoints.length - 1]?.id ?? null;
  }
}

function resolveCheckpointSummary(state, reference = null) {
  const checkpoints = Array.isArray(state?.checkpoints) ? state.checkpoints : [];
  if (checkpoints.length === 0) {
    return null;
  }
  const normalizedReference = normalizeCheckpointLabel(reference, "latest");
  if (!normalizedReference || normalizedReference === "latest") {
    return checkpoints[checkpoints.length - 1] ?? null;
  }
  if (normalizedReference === "active" && state?.activeCheckpointId) {
    return checkpoints.find((summary) => summary?.id === state.activeCheckpointId) ?? null;
  }
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    const summary = checkpoints[index];
    if (!summary) {
      continue;
    }
    if (summary.id === normalizedReference || summary.label === normalizedReference) {
      return summary;
    }
  }
  return null;
}

function hydratePersistedCheckpointSummaries(parsed) {
  if (!Array.isArray(parsed?.checkpoints)) {
    return [];
  }
  return parsed.checkpoints
    .map((summary) => checkpointSummaryRecord(summary))
    .filter(Boolean)
    .map(({ active, ...summary }) => summary);
}

function hydratePersistedCheckpointSnapshots(parsed, checkpointSummaries) {
  const rawSnapshots =
    parsed?.checkpointSnapshots && typeof parsed.checkpointSnapshots === "object"
      ? parsed.checkpointSnapshots
      : {};
  const snapshots = new Map();
  for (const summary of checkpointSummaries) {
    const snapshot = normalizeCheckpointSnapshot(rawSnapshots[summary.id]);
    if (snapshot) {
      snapshots.set(summary.id, snapshot);
    }
  }
  return snapshots;
}

function serializeCheckpointSnapshots(checkpointSummaries, checkpointSnapshots) {
  const entries = [];
  for (const summary of checkpointSummaries) {
    const snapshot = checkpointSnapshots instanceof Map
      ? checkpointSnapshots.get(summary.id)
      : null;
    if (!snapshot) {
      continue;
    }
    entries.push([summary.id, normalizeCheckpointSnapshot(snapshot)]);
  }
  return Object.fromEntries(entries);
}

function subagentToolKey(subagentSessionId, toolName) {
  const session = normalizeStoredValue(subagentSessionId);
  const tool = normalizeStoredValue(toolName);
  return session && tool ? `${session}::${tool}` : null;
}

export function loadPersistedWatchState({
  fs,
  path,
  watchStateFile,
  clientKey,
}) {
  try {
    const raw = fs.readFileSync(watchStateFile, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.clientKey === clientKey) {
      const checkpointSummaries = hydratePersistedCheckpointSummaries(parsed);
      const checkpointSnapshots = hydratePersistedCheckpointSnapshots(
        parsed,
        checkpointSummaries,
      );
      const activeCheckpointId = normalizeCheckpointLabel(parsed.activeCheckpointId, null);
      return {
        ownerToken: normalizeStoredValue(parsed.ownerToken),
        sessionId: normalizeStoredValue(parsed.sessionId),
        sessionLabels: createWatchSessionLabelMap(parsed.sessionLabels),
        uiPreferences: createWatchUiPreferences(parsed.uiPreferences),
        pendingAttachments: Array.isArray(parsed.pendingAttachments)
          ? cloneCheckpointValue(parsed.pendingAttachments)
          : [],
        attachmentSequence: Number.isFinite(Number(parsed.attachmentSequence))
          ? Number(parsed.attachmentSequence)
          : 0,
        checkpoints: checkpointSummaries,
        checkpointSnapshots,
        checkpointSequence: Number.isFinite(Number(parsed.checkpointSequence))
          ? Number(parsed.checkpointSequence)
          : checkpointSummaries.length,
        activeCheckpointId:
          activeCheckpointId && checkpointSnapshots.has(activeCheckpointId)
            ? activeCheckpointId
            : checkpointSummaries[checkpointSummaries.length - 1]?.id ?? null,
      };
    }
  } catch {}
  return {
    ownerToken: null,
    sessionId: null,
    sessionLabels: new Map(),
    uiPreferences: createWatchUiPreferences(),
    pendingAttachments: [],
    attachmentSequence: 0,
    checkpoints: [],
    checkpointSnapshots: new Map(),
    checkpointSequence: 0,
    activeCheckpointId: null,
  };
}

export function persistWatchState({
  fs,
  path,
  watchStateFile,
  clientKey,
  ownerToken,
  sessionId,
  sessionLabels = new Map(),
  uiPreferences = createWatchUiPreferences(),
  pendingAttachments = [],
  attachmentSequence = 0,
  checkpoints = [],
  checkpointSnapshots = new Map(),
  checkpointSequence = 0,
  activeCheckpointId = null,
}) {
  try {
    fs.mkdirSync(path.dirname(watchStateFile), { recursive: true });
    fs.writeFileSync(
      watchStateFile,
      `${JSON.stringify(
        {
          clientKey,
          ownerToken: normalizeStoredValue(ownerToken),
          sessionId: normalizeStoredValue(sessionId),
          sessionLabels: serializeWatchSessionLabels(sessionLabels),
          uiPreferences: serializeWatchUiPreferences(uiPreferences),
          pendingAttachments: Array.isArray(pendingAttachments)
            ? cloneCheckpointValue(pendingAttachments)
            : [],
          attachmentSequence: Number.isFinite(Number(attachmentSequence))
            ? Number(attachmentSequence)
            : 0,
          checkpoints: checkpoints
            .map((summary) => checkpointSummaryRecord(summary))
            .filter(Boolean)
            .map(({ active, ...summary }) => summary),
          checkpointSnapshots: serializeCheckpointSnapshots(checkpoints, checkpointSnapshots),
          checkpointSequence: Number.isFinite(Number(checkpointSequence))
            ? Number(checkpointSequence)
            : 0,
          activeCheckpointId: normalizeCheckpointLabel(activeCheckpointId, null),
          updatedAt: Date.now(),
        },
        null,
        2,
      )}\n`,
    );
  } catch {}
}

export function createWatchState({
  persistedWatchState = {},
  launchedAtMs = Date.now(),
} = {}) {
  return {
    sessionId: normalizeStoredValue(persistedWatchState.sessionId),
    runState: "idle",
    runPhase: null,
    connectionState: "connecting",
    latestTool: null,
    latestToolState: null,
    latestAgentSummary: null,
    currentObjective: null,
    runDetail: null,
    activeRunStartedAtMs: null,
    runInspectPending: false,
    bootstrapAttempts: 0,
    bootstrapReady: false,
    introDismissed: false,
    sessionAttachedAtMs: launchedAtMs,
    transientStatus: "Booting watch client…",
    lastStatus: null,
    lastUsageSummary: null,
    lastActivityAt: null,
    configuredModelRoute: null,
    liveSessionModelRoute: null,
    ownerToken: normalizeStoredValue(persistedWatchState.ownerToken),
    sessionLabels: createWatchSessionLabelMap(persistedWatchState.sessionLabels),
    inputPreferences: createWatchUiPreferences(persistedWatchState.uiPreferences),
    composerMode: "insert",
    skillCatalog: [],
    hookCatalog: [],
    voiceCompanion: null,
    sharedCommandCatalog: [],
    pendingAttachments: Array.isArray(persistedWatchState.pendingAttachments)
      ? persistedWatchState.pendingAttachments.map((attachment) => ({ ...attachment }))
      : [],
    attachmentSequence: Number.isFinite(Number(persistedWatchState.attachmentSequence))
      ? Number(persistedWatchState.attachmentSequence)
      : 0,
    lastStatusFeedFingerprint: null,
    manualSessionsRequestPending: false,
    manualSessionsQuery: null,
    pendingResumeHistoryRestore: false,
    maintenanceSnapshot: null,
    maintenanceRequestPending: false,
    checkpoints: Array.isArray(persistedWatchState.checkpoints)
      ? persistedWatchState.checkpoints.map((summary) => ({ ...summary }))
      : [],
    checkpointSnapshots:
      persistedWatchState.checkpointSnapshots instanceof Map
        ? new Map(persistedWatchState.checkpointSnapshots)
        : new Map(),
    checkpointSequence: Number.isFinite(Number(persistedWatchState.checkpointSequence))
      ? Number(persistedWatchState.checkpointSequence)
      : 0,
    activeCheckpointId: normalizeCheckpointLabel(
      persistedWatchState.activeCheckpointId,
      null,
    ),
    marketTaskBrowser: null,
    expandedEventId: null,
    secretPrompt: null,
    composerInput: "",
    composerCursor: 0,
    composerPaletteIndex: 0,
    composerHistory: [],
    composerHistoryIndex: -1,
    composerHistoryDraft: "",
    composerPastedRanges: [],
    composerPasteSequence: 0,
    transcriptScrollOffset: 0,
    transcriptFollowMode: true,
    detailScrollOffset: 0,
    planStepSequence: 0,
    queuedOperatorInputs: [],
    subagentPlanSteps: new Map(),
    subagentSessionPlanKeys: new Map(),
    subagentLiveActivity: new Map(),
    recentSubagentLifecycleFingerprints: new Map(),
    subagentToolArgs: new Map(),
    plannerDagNodes: new Map(),
    plannerDagEdges: [],
    plannerDagPipelineId: null,
    plannerDagStatus: "idle",
    plannerDagNote: null,
    plannerDagUpdatedAt: 0,
    plannerDagHydratedSessionId: null,
    workflowStage: "idle",
    workflowStageUpdatedAt: 0,
    workflowOwnershipSummary: "",
    workflowOwnershipUpdatedAt: 0,
    cockpit: null,
    cockpitUpdatedAt: 0,
    cockpitFingerprint: null,
    eventCategoryFilter: "all",
    events: [],
  };
}

export function createWatchStateBindings({
  state,
  bindState,
  keys = DEFAULT_BOUND_STATE_KEYS,
} = {}) {
  if (!state || typeof state !== "object") {
    throw new TypeError("createWatchStateBindings requires a state object");
  }
  if (typeof bindState !== "function") {
    throw new TypeError("createWatchStateBindings requires a bindState function");
  }
  return Object.fromEntries(
    keys.map((key) => [
      key,
      bindState(
        () => state[key],
        (value) => {
          state[key] = value;
        },
      ),
    ]),
  );
}

export function rememberSubagentToolArgs(state, subagentSessionId, toolName, args) {
  const key = subagentToolKey(subagentSessionId, toolName);
  if (!key || args === undefined) {
    return;
  }
  state.subagentToolArgs.set(key, args);
}

export function readSubagentToolArgs(state, subagentSessionId, toolName) {
  const key = subagentToolKey(subagentSessionId, toolName);
  return key ? state.subagentToolArgs.get(key) : undefined;
}

export function clearSubagentToolArgs(state, subagentSessionId, toolName = null) {
  const session = normalizeStoredValue(subagentSessionId);
  if (!session) {
    return;
  }
  if (toolName) {
    const key = subagentToolKey(session, toolName);
    if (key) {
      state.subagentToolArgs.delete(key);
    }
    return;
  }
  const prefix = `${session}::`;
  for (const key of state.subagentToolArgs.keys()) {
    if (key.startsWith(prefix)) {
      state.subagentToolArgs.delete(key);
    }
  }
}

export function resetDelegatedWatchState(state) {
  state.subagentPlanSteps.clear();
  state.subagentSessionPlanKeys.clear();
  state.subagentLiveActivity.clear();
  state.recentSubagentLifecycleFingerprints.clear();
  state.subagentToolArgs.clear();
  state.plannerDagNodes.clear();
  state.plannerDagEdges.length = 0;
  state.plannerDagPipelineId = null;
  state.plannerDagStatus = "idle";
  state.plannerDagNote = null;
  state.plannerDagUpdatedAt = 0;
  state.plannerDagHydratedSessionId = null;
  state.workflowStage = "idle";
  state.workflowStageUpdatedAt = 0;
  state.workflowOwnershipSummary = "";
  state.workflowOwnershipUpdatedAt = 0;
  state.cockpit = null;
  state.cockpitUpdatedAt = 0;
  state.cockpitFingerprint = null;
}

export function captureWatchCheckpoint(state, {
  label = null,
  reason = "manual",
  nowMs = Date.now,
  limit = DEFAULT_WATCH_CHECKPOINT_LIMIT,
} = {}) {
  if (!state || typeof state !== "object") {
    throw new TypeError("captureWatchCheckpoint requires a state object");
  }
  const nextSequence = Number.isFinite(Number(state.checkpointSequence))
    ? Number(state.checkpointSequence) + 1
    : 1;
  state.checkpointSequence = nextSequence;
  const id = `cp-${nextSequence}`;
  const summary = checkpointSummaryFromState(state, {
    id,
    label: normalizeCheckpointLabel(label, `Checkpoint ${nextSequence}`),
    reason,
    createdAtMs: typeof nowMs === "function" ? nowMs() : Date.now(),
  });
  state.checkpoints.push(summary);
  state.checkpointSnapshots.set(id, serializeCheckpointSnapshot(state));
  state.activeCheckpointId = id;
  trimCheckpointCollections(state, limit);
  return checkpointSummaryRecord(summary, {
    activeCheckpointId: state.activeCheckpointId,
  });
}

export function listWatchCheckpointSummaries(state, {
  limit = DEFAULT_WATCH_CHECKPOINT_LIMIT,
} = {}) {
  if (!state || typeof state !== "object") {
    throw new TypeError("listWatchCheckpointSummaries requires a state object");
  }
  const normalizedLimit = Number.isFinite(Number(limit))
    ? Math.max(0, Math.floor(Number(limit)))
    : DEFAULT_WATCH_CHECKPOINT_LIMIT;
  return (Array.isArray(state.checkpoints) ? state.checkpoints : [])
    .slice(-normalizedLimit)
    .reverse()
    .map((summary) => checkpointSummaryRecord(summary, {
      activeCheckpointId: state.activeCheckpointId,
    }))
    .filter(Boolean);
}

export function rewindWatchToCheckpoint(state, reference = null) {
  if (!state || typeof state !== "object") {
    throw new TypeError("rewindWatchToCheckpoint requires a state object");
  }
  const target = resolveCheckpointSummary(state, reference);
  if (!target) {
    return null;
  }
  const snapshot = normalizeCheckpointSnapshot(state.checkpointSnapshots.get(target.id));
  if (!snapshot) {
    return null;
  }

  const primitives = snapshot.primitives ?? {};
  for (const key of WATCH_CHECKPOINT_STATE_KEYS) {
    if (Object.hasOwn(primitives, key)) {
      state[key] = cloneCheckpointValue(primitives[key]);
    }
  }
  restoreArray(state.composerPastedRanges, snapshot.composerPastedRanges);
  state.composerPasteSequence = Number.isFinite(Number(snapshot.composerPasteSequence))
    ? Number(snapshot.composerPasteSequence)
    : 0;
  restoreArray(state.queuedOperatorInputs, snapshot.queuedOperatorInputs);
  restoreArray(state.pendingAttachments, snapshot.pendingAttachments);
  state.attachmentSequence = Number.isFinite(Number(snapshot.attachmentSequence))
    ? Number(snapshot.attachmentSequence)
    : 0;
  restoreMap(state.subagentPlanSteps, snapshot.subagentPlanSteps);
  restoreMap(state.subagentSessionPlanKeys, snapshot.subagentSessionPlanKeys);
  restoreMap(state.subagentLiveActivity, snapshot.subagentLiveActivity);
  restoreMap(
    state.recentSubagentLifecycleFingerprints,
    snapshot.recentSubagentLifecycleFingerprints,
  );
  restoreMap(state.subagentToolArgs, snapshot.subagentToolArgs);
  restoreMap(state.plannerDagNodes, snapshot.plannerDagNodes);
  restoreArray(state.plannerDagEdges, snapshot.plannerDagEdges);
  restoreArray(state.events, snapshot.events);
  if (
    state.expandedEventId &&
    !state.events.some((event) => event?.id === state.expandedEventId)
  ) {
    state.expandedEventId = null;
  }
  state.activeCheckpointId = target.id;
  return checkpointSummaryRecord(target, {
    activeCheckpointId: state.activeCheckpointId,
  });
}
