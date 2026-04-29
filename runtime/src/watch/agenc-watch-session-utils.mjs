/**
 * Session, model route, and transport error classification utilities
 * for the watch TUI.
 *
 * Pure functions — no watch state or side-effect dependencies.
 */

import { sanitizeInlineText } from "./agenc-watch-text-utils.mjs";

const GROK_MODEL_ALIASES = new Map([
  // Legacy beta-infixed IDs (pre-Apr 2026 xAI catalog) remap to current canonical.
  ["grok-4.20-beta-0309-reasoning", "grok-4.20-0309-reasoning"],
  ["grok-4.20-beta-0309-non-reasoning", "grok-4.20-0309-non-reasoning"],
  ["grok-4.20-multi-agent-beta-0309", "grok-4.20-multi-agent-0309"],
  ["grok-4.20-reasoning", "grok-4.20-0309-reasoning"],
  ["grok-4.20-non-reasoning", "grok-4.20-0309-non-reasoning"],
  ["grok-4.20-multi-agent", "grok-4.20-multi-agent-0309"],
  ["grok-4.20-beta-latest-reasoning", "grok-4.20-0309-reasoning"],
  ["grok-4.20-beta-latest-non-reasoning", "grok-4.20-0309-non-reasoning"],
  ["grok-4.20-multi-agent-beta-latest", "grok-4.20-multi-agent-0309"],
]);

function canonicalizeProviderModel(provider, model) {
  const normalizedProvider = sanitizeInlineText(provider ?? "").toLowerCase();
  const normalizedModel = sanitizeInlineText(model ?? "");
  if (!normalizedModel) {
    return null;
  }
  if (normalizedProvider === "grok") {
    return GROK_MODEL_ALIASES.get(normalizedModel) ?? normalizedModel;
  }
  return normalizedModel;
}

function formatCanonicalModelLabel(route) {
  if (!route) {
    return "unknown";
  }
  const configuredModel = sanitizeInlineText(route.configuredModel ?? "");
  const resolvedModel =
    sanitizeInlineText(route.resolvedModel ?? "") ||
    sanitizeInlineText(route.model ?? "");
  if (
    configuredModel &&
    resolvedModel &&
    configuredModel !== resolvedModel
  ) {
    return `${configuredModel} (${resolvedModel})`;
  }
  return resolvedModel || configuredModel || "unknown";
}

export function normalizeSessionValue(value) {
  const text = sanitizeInlineText(String(value ?? ""));
  if (!text) {
    return null;
  }
  return text.replace(/^session:/, "");
}

export function sessionValuesMatch(left, right) {
  const normalizedLeft = normalizeSessionValue(left);
  const normalizedRight = normalizeSessionValue(right);
  return Boolean(
    normalizedLeft &&
    normalizedRight &&
    normalizedLeft === normalizedRight,
  );
}

export function normalizeModelRoute(input = {}, nowMs) {
  const provider = sanitizeInlineText(
    input.provider ??
      input.llmProvider ??
      "",
  ) || "unknown";
  const configuredModel = sanitizeInlineText(
    input.configuredModel ??
      input.model ??
      input.llmModel ??
      "",
  );
  const resolvedModel = canonicalizeProviderModel(
    provider,
    input.resolvedModel ??
      input.model ??
      input.llmModel ??
      input.configuredModel,
  );
  if (!configuredModel && !resolvedModel) {
    return null;
  }
  const source = sanitizeInlineText(
    input.source ??
      "",
  );
  return {
    provider,
    model: resolvedModel || configuredModel || "unknown",
    ...(configuredModel ? { configuredModel } : {}),
    ...(resolvedModel ? { resolvedModel } : {}),
    usedFallback: input.usedFallback === true,
    ...(source ? { source } : {}),
    updatedAt: Number.isFinite(Number(input.updatedAt))
      ? Number(input.updatedAt)
      : nowMs(),
  };
}

export function formatModelRouteLabel(route, { includeProvider = true } = {}) {
  if (!route) {
    return "routing pending";
  }
  const provider = sanitizeInlineText(route.provider ?? "");
  const model = formatCanonicalModelLabel(route);
  const parts = [];
  if (model) {
    parts.push(model);
  }
  if (includeProvider && provider) {
    parts.push(`via ${provider}`);
  }
  if (route.usedFallback) {
    parts.push("fallback");
  }
  return parts.join(" ").trim() || "routing pending";
}

export function modelRouteTone(route, hasLiveRoute) {
  if (!route) return "slate";
  if (route.usedFallback) return "amber";
  return hasLiveRoute ? "teal" : "slate";
}

export function modelRoutesMatch(left, right) {
  const leftProvider = sanitizeInlineText(left?.provider ?? "");
  const rightProvider = sanitizeInlineText(right?.provider ?? "");
  const leftModel = canonicalizeProviderModel(
    leftProvider,
    left?.resolvedModel ?? left?.model ?? left?.configuredModel,
  );
  const rightModel = canonicalizeProviderModel(
    rightProvider,
    right?.resolvedModel ?? right?.model ?? right?.configuredModel,
  );
  return Boolean(
    leftProvider &&
      rightProvider &&
      leftModel &&
      rightModel &&
      leftProvider === rightProvider &&
      leftModel === rightModel,
  );
}

export function shouldSurfaceTransientStatus(value) {
  const text = sanitizeInlineText(value ?? "");
  return Boolean(
    text &&
    !/^agent reply received$/i.test(text) &&
    !/^gateway status loaded$/i.test(text) &&
    !/^history restored:/i.test(text) &&
    !/^session ready:/i.test(text) &&
    !/^run inspect loaded:/i.test(text),
  );
}

export function isExpectedMissingRunInspect(errorText, errorPayload) {
  if (
    typeof errorPayload === "object" &&
    errorPayload !== null &&
    errorPayload.code === "background_run_missing"
  ) {
    return true;
  }
  return (
    typeof errorText === "string" &&
    (
      (
        errorText.includes("Background run") &&
        errorText.includes("not found")
      ) ||
      errorText.includes("No active durable background run")
    )
  );
}

export function isUnavailableBackgroundRunInspect(errorPayload) {
  return (
    typeof errorPayload === "object" &&
    errorPayload !== null &&
    errorPayload.code === "background_run_unavailable"
  );
}

export function isRetryableBootstrapError(errorText) {
  return (
    typeof errorText === "string" &&
    (
      errorText === "Unknown message type: chat.new" ||
      errorText === "Unknown message type: session.command.execute"
    )
  );
}

export function buildSurfaceSummaryCacheKey(input = {}) {
  const maintenanceStatus =
    input.maintenanceStatus && typeof input.maintenanceStatus === "object"
      ? input.maintenanceStatus
      : null;
  const maintenanceSync =
    maintenanceStatus?.sync && typeof maintenanceStatus.sync === "object"
      ? maintenanceStatus.sync
      : null;
  const maintenanceMemory =
    maintenanceStatus?.memory && typeof maintenanceStatus.memory === "object"
      ? maintenanceStatus.memory
      : null;
  const workspaceIndex =
    input.workspaceIndex && typeof input.workspaceIndex === "object"
      ? input.workspaceIndex
      : null;
  const voiceCompanion =
    input.voiceCompanion && typeof input.voiceCompanion === "object"
      ? input.voiceCompanion
      : null;
  const workspaceFileCount = Array.isArray(workspaceIndex?.files)
    ? workspaceIndex.files.length
    : 0;
  return JSON.stringify({
    connectionState: input.connectionState ?? null,
    phaseLabel: input.phaseLabel ?? null,
    routeProvider: input.route?.provider ?? null,
    routeModel: input.route?.model ?? null,
    routeFallback: input.route?.usedFallback === true,
    durableRunsEnabled:
      typeof input.backgroundRunStatus?.enabled === "boolean"
        ? input.backgroundRunStatus.enabled
        : null,
    durableOperatorAvailable:
      typeof input.backgroundRunStatus?.operatorAvailable === "boolean"
        ? input.backgroundRunStatus.operatorAvailable
        : null,
    durableDisabledCode:
      typeof input.backgroundRunStatus?.disabledCode === "string"
        ? input.backgroundRunStatus.disabledCode
        : null,
    durableActiveTotal: Number.isFinite(Number(input.backgroundRunStatus?.activeTotal))
      ? Number(input.backgroundRunStatus.activeTotal)
      : null,
    durableQueuedSignalsTotal: Number.isFinite(Number(input.backgroundRunStatus?.queuedSignalsTotal))
      ? Number(input.backgroundRunStatus.queuedSignalsTotal)
      : null,
    runtimeState: typeof input.runtimeStatus?.state === "string"
      ? input.runtimeStatus.state
      : null,
    objective: input.objective ?? null,
    usage: input.lastUsageSummary ?? null,
    latestTool: input.latestTool ?? null,
    latestToolState: input.latestToolState ?? null,
    queuedInputs: Number.isFinite(Number(input.queuedInputCount)) ? Number(input.queuedInputCount) : 0,
    pendingAttachments:
      Number.isFinite(Number(input.pendingAttachmentCount))
        ? Number(input.pendingAttachmentCount)
        : 0,
    eventsLength: Number.isFinite(Number(input.eventsLength)) ? Number(input.eventsLength) : 0,
    lastEventId: input.lastEventId ?? null,
    planCount: Number.isFinite(Number(input.planCount)) ? Number(input.planCount) : 0,
    activeAgentCount: Number.isFinite(Number(input.activeAgentCount)) ? Number(input.activeAgentCount) : 0,
    activeAgentLabel: input.activeAgentLabel ?? null,
    activeAgentActivity: input.activeAgentActivity ?? null,
    plannerStatus: input.plannerStatus ?? null,
    plannerNote: input.plannerNote ?? null,
    sessionId: input.sessionId ?? null,
    sessionLabel: input.sessionLabel ?? null,
    following: input.following === true,
    detailOpen: input.detailOpen === true,
    transcriptScrollOffset: Number.isFinite(Number(input.transcriptScrollOffset))
      ? Number(input.transcriptScrollOffset)
      : 0,
    lastActivityAt: input.lastActivityAt ?? null,
    maintenanceGeneratedAt: Number.isFinite(Number(maintenanceStatus?.generatedAt))
      ? Number(maintenanceStatus.generatedAt)
      : null,
    maintenanceOwnerSessionCount: Number.isFinite(Number(maintenanceSync?.ownerSessionCount))
      ? Number(maintenanceSync.ownerSessionCount)
      : null,
    maintenanceActiveSessionId: maintenanceSync?.activeSessionId ?? null,
    maintenanceActiveSessionOwned:
      typeof maintenanceSync?.activeSessionOwned === "boolean"
        ? maintenanceSync.activeSessionOwned
        : null,
    maintenanceDurableRunsEnabled:
      typeof maintenanceSync?.durableRunsEnabled === "boolean"
        ? maintenanceSync.durableRunsEnabled
        : null,
    maintenanceOperatorAvailable:
      typeof maintenanceSync?.operatorAvailable === "boolean"
        ? maintenanceSync.operatorAvailable
        : null,
    maintenanceInspectAvailable:
      typeof maintenanceSync?.inspectAvailable === "boolean"
        ? maintenanceSync.inspectAvailable
        : null,
    maintenanceControlAvailable:
      typeof maintenanceSync?.controlAvailable === "boolean"
        ? maintenanceSync.controlAvailable
        : null,
    maintenanceDisabledCode:
      typeof maintenanceSync?.disabledCode === "string"
        ? maintenanceSync.disabledCode
        : null,
    maintenanceDisabledReason:
      typeof maintenanceSync?.disabledReason === "string"
        ? maintenanceSync.disabledReason
        : null,
    maintenanceMemoryBackendConfigured:
      typeof maintenanceMemory?.backendConfigured === "boolean"
        ? maintenanceMemory.backendConfigured
        : null,
    maintenanceMemorySessionCount: Number.isFinite(Number(maintenanceMemory?.sessionCount))
      ? Number(maintenanceMemory.sessionCount)
      : null,
    maintenanceMemoryTotalMessages: Number.isFinite(Number(maintenanceMemory?.totalMessages))
      ? Number(maintenanceMemory.totalMessages)
      : null,
    maintenanceMemoryLastActiveAt: Number.isFinite(Number(maintenanceMemory?.lastActiveAt))
      ? Number(maintenanceMemory.lastActiveAt)
      : null,
    maintenanceRecentSessionCount: Array.isArray(maintenanceMemory?.recentSessions)
      ? maintenanceMemory.recentSessions.length
      : 0,
    workspaceIndexReady:
      typeof workspaceIndex?.ready === "boolean" ? workspaceIndex.ready : null,
    workspaceIndexError:
      typeof workspaceIndex?.error === "string" ? workspaceIndex.error : null,
    workspaceIndexFileCount: workspaceFileCount,
    voiceActive:
      typeof voiceCompanion?.active === "boolean" ? voiceCompanion.active : null,
    voiceConnectionState:
      typeof voiceCompanion?.connectionState === "string"
        ? voiceCompanion.connectionState
        : null,
    voiceCompanionState:
      typeof voiceCompanion?.companionState === "string"
        ? voiceCompanion.companionState
        : null,
    voicePersona:
      typeof voiceCompanion?.voice === "string" ? voiceCompanion.voice : null,
    voiceMode:
      typeof voiceCompanion?.mode === "string" ? voiceCompanion.mode : null,
    voiceSessionId:
      typeof voiceCompanion?.sessionId === "string"
        ? voiceCompanion.sessionId
        : null,
    voiceManagedSessionId:
      typeof voiceCompanion?.managedSessionId === "string"
        ? voiceCompanion.managedSessionId
        : null,
    voiceDelegationStatus:
      typeof voiceCompanion?.delegationStatus === "string"
        ? voiceCompanion.delegationStatus
        : null,
    voiceCurrentTask:
      typeof voiceCompanion?.currentTask === "string"
        ? voiceCompanion.currentTask
        : null,
    voiceLastUserTranscript:
      typeof voiceCompanion?.lastUserTranscript === "string"
        ? voiceCompanion.lastUserTranscript
        : null,
    voiceLastAssistantTranscript:
      typeof voiceCompanion?.lastAssistantTranscript === "string"
        ? voiceCompanion.lastAssistantTranscript
        : null,
    voiceLastError:
      typeof voiceCompanion?.lastError === "string"
        ? voiceCompanion.lastError
        : null,
  });
}

export function latestSessionSummary(
  payload,
  preferredSessionId = null,
  preferredWorkspaceRoot = null,
) {
  if (!Array.isArray(payload) || payload.length === 0) {
    return null;
  }
  const resumableSessions = payload.filter((session) => {
    const resumabilityState = String(session?.resumabilityState ?? "").trim();
    return (
      !resumabilityState ||
      resumabilityState === "active" ||
      resumabilityState === "disconnected-resumable"
    );
  });
  const eligibleSessions = resumableSessions.length > 0 ? resumableSessions : payload;
  const sameWorkspaceSessions =
    typeof preferredWorkspaceRoot === "string" && preferredWorkspaceRoot
      ? eligibleSessions.filter(
          (session) => session?.workspaceRoot === preferredWorkspaceRoot,
        )
      : eligibleSessions;
  if (preferredSessionId) {
    const preferred = sameWorkspaceSessions.find(
      (session) => session?.sessionId === preferredSessionId,
    );
    if (preferred && Number(preferred?.messageCount ?? 0) > 0) {
      return preferred;
    }
  }
  // When a workspace root is specified, only resume sessions from that
  // workspace.  Falling back to sessions from other workspaces causes
  // old session context to bleed into new workspace tasks.
  if (
    typeof preferredWorkspaceRoot === "string" &&
    preferredWorkspaceRoot &&
    sameWorkspaceSessions.length === 0
  ) {
    return null;
  }
  const candidateSessions =
    sameWorkspaceSessions.length > 0 ? sameWorkspaceSessions : eligibleSessions;
  return [...candidateSessions].sort((left, right) => {
    const leftMessageCount = Number(left?.messageCount ?? 0);
    const rightMessageCount = Number(right?.messageCount ?? 0);
    const leftHasMessages = leftMessageCount > 0 ? 1 : 0;
    const rightHasMessages = rightMessageCount > 0 ? 1 : 0;
    if (leftHasMessages !== rightHasMessages) {
      return rightHasMessages - leftHasMessages;
    }
    const leftTime = Number(left?.lastActiveAt ?? 0);
    const rightTime = Number(right?.lastActiveAt ?? 0);
    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }
    return rightMessageCount - leftMessageCount;
  })[0] ?? null;
}
