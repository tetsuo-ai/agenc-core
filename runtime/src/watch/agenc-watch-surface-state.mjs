import { readWatchDaemonErrorRate } from "./agenc-watch-log-tail.mjs";

const ERROR_RATE_REFRESH_MS = 15_000;

export function createWatchSurfaceStateController(dependencies = {}) {
  const {
    watchState,
    transportState,
    events,
    queuedOperatorInputs,
    pendingAttachments,
    subagentPlanSteps,
    nowMs,
    activityPulseIntervalMs,
    formatElapsedMs,
    sanitizeInlineText,
    planStepDisplayName,
    buildSurfaceSummaryCacheKey,
    buildWatchSurfaceSummary,
    isTranscriptFollowing,
    normalizeModelRouteImpl,
    modelRouteToneImpl,
    resolveSessionLabel,
    workspaceIndex,
  } = dependencies;

  let cachedSurfaceSummaryKey = null;
  let cachedSurfaceSummary = null;

  // Cut 6.3: rolling error-rate signal cached for ERROR_RATE_REFRESH_MS so we
  // don't stat the daemon error log on every render. Re-read at most once per
  // ~15s and on every cache miss for the surface summary.
  let cachedErrorRate = null;
  let cachedErrorRateAt = 0;
  function refreshDaemonErrorRate() {
    const currentMs = typeof nowMs === "function" ? nowMs() : Date.now();
    if (
      cachedErrorRate &&
      currentMs - cachedErrorRateAt < ERROR_RATE_REFRESH_MS
    ) {
      return cachedErrorRate;
    }
    try {
      cachedErrorRate = readWatchDaemonErrorRate({ now: currentMs });
    } catch {
      cachedErrorRate = {
        present: false,
        windowMs: 0,
        windowCount: 0,
        totalCount: 0,
        lastTimestamp: null,
        lastLine: null,
      };
    }
    cachedErrorRateAt = currentMs;
    return cachedErrorRate;
  }

  function defaultWorkingGlyphFrames() {
    // AgenC_Logo.svg resolves to a diamond / inner-cross silhouette.
    // The TUI can't animate the SVG directly, so we pulse through a compact
    // set of Unicode marks that preserve that logo shape in one cell.
    if (process.env.TERM === "xterm-ghostty") {
      return ["·", "◇", "◈", "❖", "◈", "◇"];
    }
    return ["·", "◇", "◈", "❖", "◈", "◇"];
  }

  function currentSessionElapsedLabel() {
    return formatElapsedMs(nowMs() - watchState.sessionAttachedAtMs);
  }

  function currentRunElapsedLabel() {
    const startedAt = Number(watchState.activeRunStartedAtMs);
    if (!Number.isFinite(startedAt) || startedAt <= 0) {
      return currentSessionElapsedLabel();
    }
    return formatElapsedMs(nowMs() - startedAt);
  }

  function animatedWorkingGlyph() {
    const baseFrames = defaultWorkingGlyphFrames();
    const frames = [...baseFrames, ...[...baseFrames].reverse()];
    const frameIndex = Math.floor(nowMs() / activityPulseIntervalMs) % frames.length;
    return frames[frameIndex] ?? frames[0];
  }

  function normalizeModelRoute(input = {}) {
    return normalizeModelRouteImpl(input, nowMs);
  }

  function effectiveModelRoute() {
    const liveRoute = watchState.liveSessionModelRoute;
    const configuredRoute = watchState.configuredModelRoute;
    if (liveRoute && configuredRoute) {
      const liveUpdatedAt = Number.isFinite(Number(liveRoute.updatedAt))
        ? Number(liveRoute.updatedAt)
        : Number.NEGATIVE_INFINITY;
      const configuredUpdatedAt = Number.isFinite(Number(configuredRoute.updatedAt))
        ? Number(configuredRoute.updatedAt)
        : Number.NEGATIVE_INFINITY;
      return configuredUpdatedAt >= liveUpdatedAt ? configuredRoute : liveRoute;
    }
    return liveRoute ?? configuredRoute;
  }

  function currentSessionLabel() {
    return typeof resolveSessionLabel === "function"
      ? resolveSessionLabel(watchState.sessionId)
      : null;
  }

  function currentSessionLabel() {
    return typeof resolveSessionLabel === "function"
      ? resolveSessionLabel(watchState.sessionId)
      : null;
  }

  function activePlanEntries(limit = 10) {
    return [...subagentPlanSteps.values()]
      .sort((left, right) => left.order - right.order)
      .slice(-limit);
  }

  function activeAgentEntries(limit = 24) {
    return activePlanEntries(limit).filter((step) =>
      step.status === "running" || step.status === "planned"
    );
  }

  function currentPlanFocusStep() {
    return [...subagentPlanSteps.values()]
      .filter((step) => step.status === "running" || step.status === "planned")
      .sort((left, right) => right.updatedAt - left.updatedAt || right.order - left.order)[0] ?? null;
  }

  function currentActiveAgentFocus() {
    const step = currentPlanFocusStep();
    if (!step) {
      return {
        label: null,
        activity: null,
      };
    }
    const label = planStepDisplayName(step, 48);
    const activity = sanitizeInlineText(
      step.subagentSessionId
        ? watchState.subagentLiveActivity.get(step.subagentSessionId) ?? step.note ?? ""
        : step.note ?? "",
    );
    return {
      label,
      activity: activity || null,
    };
  }

  function currentPhaseLabel() {
    return watchState.runPhase && watchState.runPhase !== "idle"
      ? watchState.runState && watchState.runState !== "idle" && watchState.runPhase !== watchState.runState
        ? `${watchState.runState} / ${watchState.runPhase}`
        : watchState.runPhase
      : watchState.runState;
  }

  function effectiveSurfacePhaseLabel() {
    const phaseLabel = currentPhaseLabel();
    if (phaseLabel && phaseLabel !== "idle") {
      return phaseLabel;
    }
    if (watchState.runState === "idle" || phaseLabel === "idle") {
      return "idle";
    }
    return currentPlanFocusStep() ? "delegating" : phaseLabel || "idle";
  }

  function hasActiveSurfaceRun() {
    return effectiveSurfacePhaseLabel() !== "idle";
  }

  function currentDisplayObjective(fallback = "No active objective") {
    const liveStep = currentPlanFocusStep();
    const candidate = sanitizeInlineText(
      watchState.currentObjective ??
        watchState.runDetail?.objective ??
        liveStep?.objective ??
        liveStep?.note ??
        "",
    );
    return candidate || fallback;
  }

  function currentSurfaceToolLabel(fallback = "idle") {
    const liveStep = currentPlanFocusStep();
    const note = sanitizeInlineText(liveStep?.note ?? "");
    const objective = sanitizeInlineText(liveStep?.objective ?? "");
    if (liveStep?.status === "running" && note && note !== objective) {
      return note;
    }
    return sanitizeInlineText(watchState.latestTool ?? "") || fallback;
  }

  function currentSurfaceSummary() {
    const route = effectiveModelRoute();
    const planEntries = activePlanEntries(24);
    const activeAgents = activeAgentEntries(24);
    const lastEvent = events[events.length - 1] ?? null;
    const activeAgentFocus = currentActiveAgentFocus();
    const summaryKey = buildSurfaceSummaryCacheKey({
      connectionState: transportState.connectionState,
      phaseLabel: effectiveSurfacePhaseLabel(),
      route,
      backgroundRunStatus: watchState.lastStatus?.backgroundRuns ?? null,
      runtimeStatus: watchState.lastStatus ?? null,
      objective: currentDisplayObjective("No active objective"),
      lastUsageSummary: watchState.lastUsageSummary,
      latestTool: watchState.latestTool,
      latestToolState: watchState.latestToolState,
      queuedInputCount: queuedOperatorInputs.length,
      pendingAttachmentCount: Array.isArray(pendingAttachments)
        ? pendingAttachments.length
        : 0,
      eventsLength: events.length,
      lastEventId: lastEvent?.id ?? null,
      planCount: planEntries.length,
      activeAgentCount: activeAgents.length,
      activeAgentLabel: activeAgentFocus.label,
      activeAgentActivity: activeAgentFocus.activity,
      plannerStatus: watchState.plannerDagStatus,
      plannerNote: watchState.plannerDagNote,
      sessionId: watchState.sessionId,
      sessionLabel: currentSessionLabel(),
      following: isTranscriptFollowing(),
      detailOpen: Boolean(watchState.expandedEventId),
      transcriptScrollOffset: watchState.transcriptScrollOffset,
      lastActivityAt: watchState.lastActivityAt,
      maintenanceStatus: watchState.maintenanceSnapshot ?? null,
      workspaceIndex: workspaceIndex ?? null,
      voiceCompanion: watchState.voiceCompanion ?? null,
    });
    if (summaryKey === cachedSurfaceSummaryKey && cachedSurfaceSummary) {
      return cachedSurfaceSummary;
    }
    cachedSurfaceSummary = buildWatchSurfaceSummary({
      connectionState: transportState.connectionState,
      phaseLabel: effectiveSurfacePhaseLabel(),
      route,
      fallbackRoute: route?.usedFallback === true ? route : null,
      backgroundRunStatus: watchState.lastStatus?.backgroundRuns ?? null,
      objective: currentDisplayObjective("No active objective"),
      lastUsageSummary: watchState.lastUsageSummary,
      latestTool: watchState.latestTool,
      latestToolState: watchState.latestToolState,
      queuedInputCount: queuedOperatorInputs.length,
      pendingAttachmentCount: Array.isArray(pendingAttachments)
        ? pendingAttachments.length
        : 0,
      events,
      planCount: planEntries.length,
      activeAgentCount: activeAgents.length,
      sessionId: watchState.sessionId,
      following: isTranscriptFollowing(),
      detailOpen: Boolean(watchState.expandedEventId),
      transcriptScrollOffset: watchState.transcriptScrollOffset,
      lastActivityAt: watchState.lastActivityAt,
      runtimeStatus: watchState.lastStatus ?? null,
      activeAgentLabel: activeAgentFocus.label,
      activeAgentActivity: activeAgentFocus.activity,
      plannerStatus: watchState.plannerDagStatus,
      plannerNote: watchState.plannerDagNote,
      sessionLabel: currentSessionLabel(),
      maintenanceStatus: watchState.maintenanceSnapshot ?? null,
      workspaceIndex: workspaceIndex ?? null,
      voiceCompanion: watchState.voiceCompanion ?? null,
      daemonErrorRate: refreshDaemonErrorRate(),
    });
    cachedSurfaceSummaryKey = summaryKey;
    return cachedSurfaceSummary;
  }

  function modelRouteTone(route) {
    return modelRouteToneImpl(route, Boolean(watchState.liveSessionModelRoute));
  }

  return {
    activeAgentEntries,
    activePlanEntries,
    animatedWorkingGlyph,
    currentActiveAgentFocus,
    currentDisplayObjective,
    currentPhaseLabel,
    currentPlanFocusStep,
    currentRunElapsedLabel,
    currentSessionLabel,
    currentSessionElapsedLabel,
    currentSurfaceSummary,
    currentSurfaceToolLabel,
    effectiveModelRoute,
    effectiveSurfacePhaseLabel,
    hasActiveSurfaceRun,
    modelRouteTone,
    normalizeModelRoute,
  };
}
