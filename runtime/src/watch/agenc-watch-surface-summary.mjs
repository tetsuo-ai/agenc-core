const TOOL_EVENT_KINDS = new Set([
  "tool",
  "tool result",
  "tool error",
  "subagent tool",
  "subagent tool result",
  "subagent error",
]);

const ALERT_EVENT_KINDS = new Set([
  "approval",
  "error",
  "tool error",
  "subagent error",
  "ws-error",
]);

const BADGE_MAP = Object.freeze({
  "tool result": { label: "RETURN", tone: "green" },
  "tool error": { label: "FAULT", tone: "red" },
  tool: { label: "EXEC", tone: "yellow" },
  "subagent tool": { label: "EXEC", tone: "amber" },
  "subagent tool result": { label: "RETURN", tone: "green" },
  "subagent error": { label: "FAULT", tone: "red" },
  agent: { label: "assistant", tone: "slate" },
  you: { label: "you", tone: "slate" },
  operator: { label: "CTRL", tone: "teal" },
  run: { label: "STATE", tone: "magenta" },
  inspect: { label: "STATE", tone: "magenta" },
  trace: { label: "TRACE", tone: "slate" },
  logs: { label: "LOGS", tone: "slate" },
  history: { label: "HISTORY", tone: "slate" },
  help: { label: "HELP", tone: "slate" },
  status: { label: "STATUS", tone: "blue" },
  session: { label: "SESS", tone: "teal" },
  checkpoint: { label: "SNAP", tone: "blue" },
  approval: { label: "AUTH", tone: "red" },
  queued: { label: "QUEUE", tone: "amber" },
  subagent: { label: "AGENT", tone: "magenta" },
  voice: { label: "VOICE", tone: "purple" },
});

function sanitizeText(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : fallback;
}

function compactSessionToken(value) {
  const text = sanitizeText(value);
  return text ? text.slice(-8) : "--------";
}

function stateTone(value) {
  const normalized = sanitizeText(value).toLowerCase();
  switch (normalized) {
    case "live":
    case "connected":
    case "running":
    case "ok":
    case "completed":
    case "ready":
    case "clear":
    case "primary":
    case "standby":
    case "healthy":
      return "green";
    case "working":
    case "thinking":
    case "execute":
    case "executing":
    case "resolving":
    case "active":
    case "detail":
      return "cyan";
    case "fallback":
    case "queued":
    case "pending":
    case "disabled":
    case "reconnecting":
    case "paused":
    case "partial":
    case "needs_verification":
    case "blocked":
    case "limited":
    case "warming":
      return "amber";
    case "approval":
    case "alert":
    case "offline":
    case "unavailable":
    case "error":
    case "failed":
    case "denied":
    case "degraded":
      return "red";
    default:
      return "slate";
  }
}

function formatCount(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function isPresentStatuslineValue(value) {
  const text = sanitizeText(value);
  if (!text) {
    return false;
  }
  return text.toLowerCase() !== "n/a";
}

function buildFooterStatuslineSegments(
  surfaceSummary,
  checkpointSummary = null,
  {
    inputModeProfile = "default",
    keybindingProfile = "default",
    composerMode = "insert",
    themeName = "default",
  } = {},
) {
  const overview = surfaceSummary?.overview ?? {};
  const attention = surfaceSummary?.attention ?? {};
  const segments = [];
  if (isPresentStatuslineValue(overview.providerLabel)) {
    segments.push(`PROV ${overview.providerLabel}`);
  }
  if (isPresentStatuslineValue(overview.modelLabel)) {
    segments.push(`MODEL ${overview.modelLabel}`);
  }
  if (isPresentStatuslineValue(overview.sessionToken)) {
    segments.push(`SESS ${overview.sessionToken}`);
  }
  if (isPresentStatuslineValue(overview.sessionLabel)) {
    segments.push(`LABEL ${overview.sessionLabel}`);
  }
  if (isPresentStatuslineValue(overview.usage)) {
    segments.push(`USAGE ${overview.usage}`);
  }
  if (isPresentStatuslineValue(overview.runtimeState)) {
    segments.push(`RUNTIME ${overview.runtimeState}`);
  }
  if (isPresentStatuslineValue(overview.durableRunsState)) {
    segments.push(`DURABLE ${overview.durableRunsState}`);
  }
  if (isPresentStatuslineValue(overview.syncState)) {
    segments.push(`SYNC ${overview.syncState}`);
  }
  if (isPresentStatuslineValue(overview.memoryState)) {
    segments.push(`MEM ${overview.memoryState}`);
  }
  if (isPresentStatuslineValue(overview.workspaceIndexState)) {
    segments.push(`INDEX ${overview.workspaceIndexState}`);
  }
  if (
    isPresentStatuslineValue(overview.voiceState) &&
    !["inactive", "stopped"].includes(String(overview.voiceState).toLowerCase())
  ) {
    segments.push(`VOICE ${overview.voiceState}`);
  }
  if (isPresentStatuslineValue(overview.transcriptMode)) {
    segments.push(`MODE ${overview.transcriptMode}`);
  }
  if (isPresentStatuslineValue(inputModeProfile)) {
    segments.push(
      inputModeProfile === "vim"
        ? `INPUT vim/${sanitizeText(composerMode, "insert")}`
        : `INPUT ${inputModeProfile}`,
    );
  }
  if (isPresentStatuslineValue(keybindingProfile) && keybindingProfile !== inputModeProfile) {
    segments.push(`KEYS ${keybindingProfile}`);
  }
  if (isPresentStatuslineValue(themeName)) {
    segments.push(`THEME ${themeName}`);
  }
  if (formatCount(overview.queuedInputCount, 0) > 0) {
    segments.push(`QUEUE ${overview.queuedInputCount}`);
  }
  if (formatCount(overview.pendingAttachmentCount, 0) > 0) {
    segments.push(`FILES ${overview.pendingAttachmentCount}`);
  }
  if (formatCount(attention.approvalAlertCount, 0) > 0) {
    segments.push(`GUARD ${attention.approvalAlertCount} approval`);
  } else if (formatCount(attention.errorAlertCount, 0) > 0) {
    segments.push(`GUARD ${attention.errorAlertCount} error`);
  }
  if (checkpointSummary?.id) {
    segments.push(`CKPT ${checkpointSummary.id}`);
  }
  return segments;
}

function fallbackStateFromRoute(route) {
  if (!route) {
    return "pending";
  }
  return route.usedFallback === true ? "active" : "standby";
}

function runtimeStateFromInputs(connectionState, backgroundRunStatus, errorAlertCount) {
  const linkState = sanitizeText(connectionState, "unknown").toLowerCase();
  if (linkState !== "live" && linkState !== "connected") {
    return linkState || "unknown";
  }
  if (!backgroundRunStatus) {
    return errorAlertCount > 0 ? "degraded" : "warming";
  }
  if (!backgroundRunStatus.enabled) {
    return errorAlertCount > 0 ? "degraded" : "limited";
  }
  if (backgroundRunStatus.operatorAvailable) {
    return errorAlertCount > 0 ? "degraded" : "healthy";
  }
  return "degraded";
}

function runtimeLabelFromInputs(connectionState, backgroundRunStatus) {
  const linkState = sanitizeText(connectionState, "unknown");
  if (!backgroundRunStatus) {
    return `${linkState} · durable pending`;
  }
  if (!backgroundRunStatus.enabled) {
    return `${linkState} · ${sanitizeText(backgroundRunStatus.disabledReason, "durable disabled")}`;
  }
  if (backgroundRunStatus.operatorAvailable) {
    return `${linkState} · durable ready`;
  }
  return `${linkState} · ${sanitizeText(backgroundRunStatus.disabledReason, "durable operator unavailable")}`;
}

function toolStateFromKind(kind) {
  switch (kind) {
    case "tool":
    case "subagent tool":
      return "running";
    case "tool result":
    case "subagent tool result":
      return "ok";
    case "tool error":
    case "subagent error":
      return "error";
    default:
      return "idle";
  }
}

function eventMetaLabel(event) {
  if (event.kind === "agent") {
    const title = sanitizeText(event.title ?? "", event.kind);
    if (title === "Agent Reply" || title === "Agent Reply · live") {
      return "";
    }
    return title;
  }
  if (event.kind === "you" || event.kind === "queued") {
    const title = sanitizeText(event.title ?? "", event.kind);
    if (title === "Prompt" || title === "Queued Input") {
      return "";
    }
    return title;
  }
  if (event.kind === "tool" || event.kind === "tool result" || event.kind === "tool error") {
    return sanitizeText(event.toolName ?? event.title ?? "", event.kind);
  }
  if (
    event.kind === "subagent tool" ||
    event.kind === "subagent tool result" ||
    event.kind === "subagent error"
  ) {
    const tool = sanitizeText(event.toolName ?? event.title ?? "", event.kind);
    const session = compactSessionToken(event.subagentSessionId);
    return `${tool} ${session}`;
  }
  return sanitizeText(event.title ?? "", event.kind);
}

export function buildWatchLayout({
  width,
  height,
  headerRows,
  popupRows,
  slashMode,
  detailOpen,
}) {
  const footerRows = 1; // composer (min 1 line)
  const bodyHeight = Math.max(4, height - headerRows - footerRows - popupRows);
  const useSidebar = false;
  const sidebarWidth = 0;
  const transcriptWidth = width;
  return {
    width,
    height,
    bodyHeight,
    useSidebar,
    sidebarWidth,
    transcriptWidth,
  };
}

export function buildWatchSidebarPolicy(targetHeight) {
  const height = Number.isFinite(Number(targetHeight)) ? Number(targetHeight) : 0;
  return {
    compactAgentLimit: height >= 48 ? 3 : height >= 38 ? 2 : 1,
    minDagRows: height >= 44 ? 18 : height >= 34 ? 14 : 10,
    showTools: height >= 30,
    toolLimit: height >= 54 ? 5 : height >= 42 ? 3 : 2,
    showGuard: height >= 38,
    showAgents: height >= 48,
    showSessionTokens: height >= 30,
  };
}

export function shouldShowWatchSplash({
  introDismissed,
  currentObjective,
  inputValue,
  bootstrapReady,
  launchedAtMs,
  startupSplashMinMs,
  eventKinds = [],
  nowMs,
}) {
  if (
    introDismissed ||
    sanitizeText(currentObjective).length > 0 ||
    sanitizeText(inputValue).length > 0
  ) {
    return false;
  }
  if (!bootstrapReady) {
    return true;
  }
  return nowMs - launchedAtMs < startupSplashMinMs &&
    !eventKinds.some((kind) => kind !== "status");
}

export function buildTranscriptEventSummary(event, previewLines = []) {
  const badge = BADGE_MAP[event?.kind] ?? {
    label: sanitizeText(event?.kind ?? "event", "event").toUpperCase().slice(0, 10),
    tone: "slate",
  };
  const title = sanitizeText(event?.title ?? "", badge.label);
  const meta = eventMetaLabel(event ?? {});
  return {
    badge,
    timestamp: sanitizeText(event?.timestamp ?? "", "--:--:--"),
    title,
    meta,
    previewLines: Array.isArray(previewLines) ? previewLines : [],
    hasBody: sanitizeText(event?.body ?? "").length > 0,
    toolState: toolStateFromKind(event?.kind),
  };
}

export function buildDetailPaneSummary(
  event,
  {
    bodyLineCount = 0,
    visibleLineCount = 0,
    hiddenAbove = 0,
    hiddenBelow = 0,
  } = {},
) {
  const summary = buildTranscriptEventSummary(event);
  const statusParts = [`${visibleLineCount} of ${bodyLineCount} lines`];
  if (hiddenAbove > 0) {
    statusParts.push(`${hiddenAbove} above`);
  }
  if (hiddenBelow > 0) {
    statusParts.push(`${hiddenBelow} below`);
  }
  if (event?.bodyTruncated) {
    statusParts.push("stored body truncated");
  }
  return {
    ...summary,
    hint: `${summary.badge.label.toLowerCase()}  ctrl+o close`,
    statusLine: statusParts.join("  "),
  };
}

export function buildCommandPaletteSummary({ inputValue, suggestions = [], modelSuggestions = [] }) {
  const input = String(inputValue ?? "").trimStart();

  // If user is typing `/model <partial>`, show model name suggestions instead
  const modelMode =
    Array.isArray(modelSuggestions) &&
    modelSuggestions.length > 0 &&
    /^\/models?\s/i.test(input);
  if (modelMode) {
    return {
      title: input.slice(0, 22),
      empty: false,
      suggestionNames: modelSuggestions,
      suggestionHint: modelSuggestions.join("  "),
    };
  }

  const suggestionNames = (Array.isArray(suggestions) ? suggestions : [])
    .map((command) => sanitizeText(command?.name ?? command?.usage ?? ""))
    .filter(Boolean);
  return {
    title: input.length > 0 ? input.slice(0, 22) : "/ commands",
    empty: suggestionNames.length === 0,
    suggestionNames,
    suggestionHint:
      suggestionNames.length > 0 ? suggestionNames.join("  ") : "no matching command",
  };
}

export function buildFileTagPaletteSummary({
  inputValue,
  query = null,
  suggestions = [],
  indexReady = true,
  indexError = null,
}) {
  const input = String(inputValue ?? "");
  const suggestionNames = (Array.isArray(suggestions) ? suggestions : [])
    .map((entry) => sanitizeText(entry?.label ?? entry?.path ?? ""))
    .filter(Boolean);
  const trimmedQuery = query == null ? null : sanitizeText(query, "");
  const title = trimmedQuery && trimmedQuery.length > 0
    ? `@ ${trimmedQuery.slice(0, 18)}`
    : "@ file";
  if (!indexReady) {
    return {
      title,
      empty: true,
      suggestionNames: [],
      suggestionHint: sanitizeText(indexError, "workspace file index unavailable"),
      mode: "unavailable",
    };
  }
  if (!trimmedQuery || trimmedQuery.length === 0) {
    return {
      title,
      empty: suggestionNames.length === 0,
      suggestionNames,
      suggestionHint:
        suggestionNames.length > 0
          ? suggestionNames.join("  ")
          : "type a path or filename after @",
      mode: "idle",
    };
  }
  return {
    title,
    empty: suggestionNames.length === 0,
    suggestionNames,
    suggestionHint:
      suggestionNames.length > 0 ? suggestionNames.join("  ") : "no matching file tag",
    mode: "active",
  };
}

export function buildWatchFooterSummary({
  summary,
  inputValue,
  suggestions = [],
  modelSuggestions = [],
  fileTagQuery = null,
  fileTagSuggestions = [],
  fileTagIndexReady = true,
  fileTagIndexError = null,
  connectionState,
  activeRun,
  elapsedLabel,
  latestTool,
  latestToolState,
  transientStatus,
  latestAgentSummary,
  objective,
  isOpen,
  bootstrapPending,
  latestExpandable,
  enableMouseTracking,
  detailDiffNavigation = null,
  activeCheckpointId = null,
  checkpointCount = 0,
  inputModeProfile = "default",
  keybindingProfile = "default",
  composerMode = "insert",
  themeName = "default",
  featureFlags = {},
}) {
  const surfaceSummary = summary ?? buildWatchSurfaceSummary({});
  const input = String(inputValue ?? "");
  const slashMode = input.trimStart().startsWith("/");
  const palette = buildCommandPaletteSummary({ inputValue: input, suggestions, modelSuggestions });
  const fileTagPalette = buildFileTagPaletteSummary({
    inputValue: input,
    query: fileTagQuery,
    suggestions: fileTagSuggestions,
    indexReady: fileTagIndexReady,
    indexError: fileTagIndexError,
  });
  const fileTagMode = fileTagQuery != null;
  const transcriptMode = sanitizeText(
    surfaceSummary?.overview?.transcriptMode,
    "follow",
  );
  const diffNavigation = detailDiffNavigation ?? surfaceSummary?.detail?.diffNavigation ?? null;
  const linkState = sanitizeText(
    connectionState ?? surfaceSummary?.overview?.connectionState,
    "unknown",
  );
  const phaseLabel = sanitizeText(surfaceSummary?.overview?.phaseLabel, "idle");
  const workingLabel =
    linkState !== "live"
      ? `Link ${linkState}`
      : activeRun
        ? `Working ${phaseLabel} ${sanitizeText(elapsedLabel, "00:00")}`
        : "Awaiting operator prompt";
  const surfaceTool = sanitizeText(
    latestTool ?? surfaceSummary?.overview?.latestTool,
    "",
  );
  const toolState = sanitizeText(
    latestToolState ?? surfaceSummary?.overview?.latestToolState,
    surfaceTool ? "running" : "idle",
  );
  const detailOpen = transcriptMode === "detail";
  const leftDetails = [];
  if (surfaceTool) {
    leftDetails.push(toolState !== "ok" ? `${surfaceTool} ${toolState}` : surfaceTool);
  }
  if (surfaceSummary?.overview?.fallbackState === "active") {
    leftDetails.push("fallback active");
  }
  if (
    surfaceSummary?.overview?.runtimeState &&
    !["healthy", "live", "connected"].includes(surfaceSummary.overview.runtimeState)
  ) {
    leftDetails.push(`runtime ${surfaceSummary.overview.runtimeState}`);
  }
  if (detailOpen) {
    leftDetails.push("detail");
  } else if (transcriptMode === "follow") {
    leftDetails.push("live follow");
  } else {
    leftDetails.push(transcriptMode);
  }
  if (surfaceSummary?.overview?.usage && surfaceSummary.overview.usage !== "n/a") {
    leftDetails.push(`usage ${surfaceSummary.overview.usage}`);
  }
  if (formatCount(surfaceSummary?.overview?.pendingAttachmentCount, 0) > 0) {
    leftDetails.push(`attachments ${surfaceSummary.overview.pendingAttachmentCount}`);
  }
  if (
    isPresentStatuslineValue(surfaceSummary?.overview?.voiceState) &&
    !["inactive", "stopped"].includes(String(surfaceSummary.overview.voiceState).toLowerCase())
  ) {
    leftDetails.push(`voice ${surfaceSummary.overview.voiceState}`);
  }
  const statuslineEnabled = featureFlags?.statusline === true;
  const checkpointSummary =
    featureFlags?.checkpoints === true && activeCheckpointId
      ? {
          id: sanitizeText(activeCheckpointId, null),
          count: formatCount(checkpointCount, 0),
        }
      : null;
  if (checkpointSummary?.id && !statuslineEnabled) {
    leftDetails.push(
      checkpointSummary.count > 0
        ? `checkpoint ${checkpointSummary.id}/${checkpointSummary.count}`
        : `checkpoint ${checkpointSummary.id}`,
    );
  }
  if (statuslineEnabled && formatCount(surfaceSummary?.overview?.pendingAttachmentCount, 0) > 0) {
    const attachmentDetail = `attachments ${surfaceSummary.overview.pendingAttachmentCount}`;
    const detailIndex = leftDetails.indexOf(attachmentDetail);
    if (detailIndex >= 0) {
      leftDetails.splice(detailIndex, 1);
    }
  }
  if (
    statuslineEnabled &&
    isPresentStatuslineValue(surfaceSummary?.overview?.voiceState) &&
    !["inactive", "stopped"].includes(String(surfaceSummary.overview.voiceState).toLowerCase())
  ) {
    const voiceDetail = `voice ${surfaceSummary.overview.voiceState}`;
    const detailIndex = leftDetails.indexOf(voiceDetail);
    if (detailIndex >= 0) {
      leftDetails.splice(detailIndex, 1);
    }
  }

  const nextRightStatus = sanitizeText(
    transientStatus ||
      latestAgentSummary ||
      (activeRun
        ? objective
        : surfaceSummary?.overview?.sessionToken
          ? `session ${surfaceSummary.overview.sessionToken}`
          : linkState),
    "idle",
  );
  const hintRight = !isOpen
    ? "reconnecting"
    : bootstrapPending
      ? "restoring session"
      : surfaceSummary?.overview?.sessionToken
        ? surfaceSummary.overview.sessionToken
        : "no session";

  let hintLeft;
  let hintStatus = hintRight;
  if (detailOpen) {
    hintLeft = `${enableMouseTracking ? "mouse wheel / " : ""}pgup pgdn scroll  ctrl+o close detail  ctrl+y copy  ctrl+q select`;
    if (diffNavigation?.enabled) {
      hintLeft = `${enableMouseTracking ? "mouse wheel / " : ""}pgup pgdn scroll  ctrl+p prev hunk  ctrl+n next hunk  ctrl+o close detail  ctrl+y copy  ctrl+q select`;
    }
    hintStatus = linkState;
  } else if (fileTagMode) {
    hintLeft = fileTagPalette.suggestionHint;
    hintStatus = fileTagPalette.mode === "unavailable" ? "index unavailable" : "tab insert tag";
  } else if (slashMode) {
    hintLeft = palette.suggestionHint;
    hintStatus = modelSuggestions.length > 0 ? "tab complete  enter switch" : "enter run";
  } else {
    if (inputModeProfile === "vim") {
      hintLeft = composerMode === "normal"
        ? `i insert  h/l move  b/w word  j/k scroll  x delete${latestExpandable ? "  ctrl+o detail" : ""}  ctrl+q select`
        : `esc normal  enter send  ctrl+k kill${latestExpandable ? "  ctrl+o detail" : ""}  ctrl+y copy  ctrl+q select`;
      hintStatus = composerMode === "normal" ? "vim normal" : "vim insert";
    } else {
      hintLeft = input.trim().length > 0
        ? `enter send  ctrl+k kill  ctrl+←/→ word${latestExpandable ? "  ctrl+o detail" : ""}  ctrl+y copy  ctrl+q select  pgup/pgdn scroll`
        : `/ commands${latestExpandable ? "  ctrl+o detail" : ""}  ctrl+y copy  ctrl+q select  /export save  pgup/pgdn scroll  ctrl+l clear`;
    }
  }
  const statuslineSegments = statuslineEnabled
    ? buildFooterStatuslineSegments(surfaceSummary, checkpointSummary, {
      inputModeProfile,
      keybindingProfile,
      composerMode,
      themeName,
    })
    : [];
  const statuslineText = statuslineSegments.join("  ");

  return {
    statusLabel: workingLabel,
    statusTone: linkState !== "live" ? stateTone(linkState) : stateTone(phaseLabel),
    leftDetails,
    rightStatus: nextRightStatus,
    hintLeft,
    hintRight: hintStatus,
    palette,
    fileTagPalette,
    statuslineEnabled,
    statuslineSegments,
    statuslineText,
  };
}

export function buildWatchSurfaceSummary({
  connectionState,
  phaseLabel,
  route,
  fallbackRoute = null,
  backgroundRunStatus,
  objective,
  lastUsageSummary,
  latestTool,
  latestToolState,
  queuedInputCount,
  pendingAttachmentCount,
  events = [],
  planCount,
  activeAgentCount,
  sessionId,
  following,
  detailOpen,
  transcriptScrollOffset,
  lastActivityAt,
  runtimeStatus = null,
  activeAgentLabel = null,
  activeAgentActivity = null,
  plannerStatus = null,
  plannerNote = null,
  sessionLabel = null,
  maintenanceStatus = null,
  workspaceIndex = null,
  voiceCompanion = null,
  detail = null,
}) {
  const recentEvents = events.slice(-24);
  const recentTools = recentEvents
    .filter((event) => TOOL_EVENT_KINDS.has(event.kind))
    .slice(-5)
    .reverse()
    .map((event) => ({
      title: sanitizeText(event.title, event.kind),
      meta: eventMetaLabel(event),
      timestamp: sanitizeText(event.timestamp, "--:--:--"),
      state: toolStateFromKind(event.kind),
      tone: stateTone(toolStateFromKind(event.kind)),
    }));
  const recentAlerts = recentEvents
    .filter((event) => ALERT_EVENT_KINDS.has(event.kind))
    .slice(-3)
    .reverse()
    .map((event) => ({
      title: sanitizeText(event.title, event.kind),
      kind: event.kind,
      timestamp: sanitizeText(event.timestamp, "--:--:--"),
      tone: stateTone(event.kind === "approval" ? "approval" : "error"),
    }));
  const approvalAlertCount = recentEvents.filter((event) => event.kind === "approval").length;
  const errorAlertCount = recentEvents.filter((event) =>
    event.kind === "error" ||
    event.kind === "tool error" ||
    event.kind === "subagent error" ||
    event.kind === "ws-error"
  ).length;
  const routeState =
    route?.usedFallback === true ? "fallback" : route ? "primary" : "pending";
  const routeLabel = route
    ? `${sanitizeText(route.model, "unknown")} via ${sanitizeText(route.provider, "unknown")}`
    : "routing pending";
  const providerLabel = sanitizeText(route?.provider, "pending");
  const modelLabel = sanitizeText(route?.model, "pending");
  const fallbackState = fallbackRoute
    ? fallbackRoute.usedFallback === true
      ? "active"
      : fallbackStateFromRoute(route)
    : fallbackStateFromRoute(route);
  const fallbackLabel = fallbackRoute
    ? `${sanitizeText(fallbackRoute.model, "fallback")} via ${sanitizeText(fallbackRoute.provider, "unknown")}`
    : route
      ? route.usedFallback === true
        ? "fallback route active"
        : "fallback standby"
      : "fallback pending";
  const guardValue =
    approvalAlertCount > 0
      ? `${approvalAlertCount} approval alert${approvalAlertCount === 1 ? "" : "s"}`
      : errorAlertCount > 0
        ? `${errorAlertCount} error${errorAlertCount === 1 ? "" : "s"}`
        : "clear";
  const transcriptMode = detailOpen
    ? "detail"
    : following
      ? "follow"
      : `scroll ${transcriptScrollOffset}`;
  const durableRunsState = !backgroundRunStatus
    ? "pending"
    : !backgroundRunStatus.enabled
      ? "disabled"
      : backgroundRunStatus.operatorAvailable
        ? "ready"
        : "offline";
  const durableRunsLabel = !backgroundRunStatus
    ? "durable status pending"
    : backgroundRunStatus.enabled
      ? backgroundRunStatus.operatorAvailable
        ? "durable operator ready"
        : sanitizeText(
          backgroundRunStatus.disabledReason,
          "durable run operator unavailable",
        )
      : sanitizeText(
        backgroundRunStatus.disabledReason,
        "durable background runs disabled",
      );
  const runtimeState = runtimeStateFromInputs(connectionState, backgroundRunStatus, errorAlertCount);
  const runtimeLabel = runtimeLabelFromInputs(connectionState, backgroundRunStatus);
  const plannerLabel = sanitizeText(plannerNote, "");
  const localSessionLabel = sanitizeText(sessionLabel, "");
  const activeAgentFocus = sanitizeText(activeAgentLabel, "");
  const activeAgentLive = sanitizeText(activeAgentActivity, "");
  const activeLine = sanitizeText(
    activeAgentLive || activeAgentFocus || latestTool || objective,
    "Awaiting operator prompt",
  );
  const durableActiveTotal = formatCount(backgroundRunStatus?.activeTotal, 0);
  const durableQueuedSignalsTotal = formatCount(backgroundRunStatus?.queuedSignalsTotal, 0);
  const maintenanceSync =
    maintenanceStatus?.sync && typeof maintenanceStatus.sync === "object"
      ? maintenanceStatus.sync
      : null;
  const maintenanceMemory =
    maintenanceStatus?.memory && typeof maintenanceStatus.memory === "object"
      ? maintenanceStatus.memory
      : null;
  const syncState = !maintenanceSync
    ? "pending"
    : maintenanceSync.durableRunsEnabled === false
      ? "disabled"
      : maintenanceSync.operatorAvailable ||
          maintenanceSync.inspectAvailable ||
          maintenanceSync.controlAvailable
        ? "ready"
        : "limited";
  const syncLabel = !maintenanceSync
    ? "sync snapshot pending"
    : maintenanceSync.durableRunsEnabled === false
      ? sanitizeText(maintenanceSync.disabledReason, "durable sync disabled")
      : [
          `${formatCount(maintenanceSync.ownerSessionCount, 0)} owned session${formatCount(maintenanceSync.ownerSessionCount, 0) === 1 ? "" : "s"}`,
          maintenanceSync.activeSessionId
            ? maintenanceSync.activeSessionOwned === true
              ? "active attached"
              : "active external"
            : "no active session",
        ].join(" · ");
  const memoryState = !maintenanceMemory
    ? "pending"
    : maintenanceMemory.backendConfigured === false
      ? "disabled"
      : "ready";
  const memoryLabel = !maintenanceMemory
    ? "memory snapshot pending"
    : maintenanceMemory.backendConfigured === false
      ? "memory backend not configured"
      : `${formatCount(maintenanceMemory.sessionCount, 0)} sessions · ${formatCount(maintenanceMemory.totalMessages, 0)} msgs`;
  const workspaceFileCount = Array.isArray(workspaceIndex?.files)
    ? workspaceIndex.files.length
    : 0;
  const workspaceIndexState = !workspaceIndex
    ? "pending"
    : workspaceIndex.ready === true
      ? "ready"
      : workspaceIndex.error
        ? "error"
        : "pending";
  const workspaceIndexLabel = !workspaceIndex
    ? "workspace index pending"
    : workspaceIndex.ready === true
      ? `${workspaceFileCount} files indexed`
      : sanitizeText(workspaceIndex.error, "workspace index unavailable");
  const voiceSnapshot =
    voiceCompanion && typeof voiceCompanion === "object"
      ? voiceCompanion
      : null;
  const voiceActive =
    typeof voiceSnapshot?.active === "boolean" ? voiceSnapshot.active : false;
  const voiceState = !voiceSnapshot
    ? "inactive"
    : sanitizeText(
      voiceSnapshot.companionState,
      voiceActive
        ? sanitizeText(voiceSnapshot.connectionState, "active")
        : "inactive",
    );
  const voiceLabel = !voiceSnapshot
    ? "voice companion idle"
    : [
        sanitizeText(voiceSnapshot.connectionState, voiceActive ? "connected" : "disconnected"),
        voiceState,
        sanitizeText(voiceSnapshot.voice, ""),
        sanitizeText(voiceSnapshot.mode, ""),
      ]
        .filter(Boolean)
        .join(" · ");
  const voiceCurrentTask = sanitizeText(voiceSnapshot?.currentTask, "");
  const voiceDelegationStatus = sanitizeText(voiceSnapshot?.delegationStatus, "");
  const voiceLastUserTranscript = sanitizeText(voiceSnapshot?.lastUserTranscript, "");
  const voiceLastAssistantTranscript = sanitizeText(
    voiceSnapshot?.lastAssistantTranscript,
    "",
  );
  const voiceLastError = sanitizeText(voiceSnapshot?.lastError, "");
  let maintenanceState = "ready";
  if (
    syncState === "error" ||
    memoryState === "error" ||
    workspaceIndexState === "error"
  ) {
    maintenanceState = "degraded";
  } else if (
    syncState === "disabled" ||
    syncState === "limited" ||
    memoryState === "disabled" ||
    workspaceIndexState === "disabled"
  ) {
    maintenanceState = "limited";
  } else if (
    syncState === "pending" ||
    memoryState === "pending" ||
    workspaceIndexState === "pending"
  ) {
    maintenanceState = "pending";
  }
  const maintenanceLabel = `${syncState} sync · ${memoryState} memory · ${workspaceIndexState} index`;

  return {
    routeLabel,
    routeState,
    routeTone: stateTone(routeState),
    providerLabel,
    modelLabel,
    fallbackState,
    fallbackLabel,
    runtimeState,
    runtimeLabel,
    objective: sanitizeText(objective, "No active objective"),
    overview: {
      connectionState: sanitizeText(connectionState, "unknown"),
      phaseLabel: sanitizeText(phaseLabel, "idle"),
      sessionToken: compactSessionToken(sessionId),
      sessionLabel: localSessionLabel,
      lastActivityAt: sanitizeText(lastActivityAt, "idle"),
      // Pass tool/usage through cleanly — empty string when truly absent
      // (no tool ever fired / no usage event yet). The header layer decides
      // whether to render a placeholder; coercing to "idle" / "n/a" here
      // collides with the phase=idle row and triggers the "—" placeholder
      // even when a previous run's value is still meaningful and worth
      // displaying.
      latestTool: sanitizeText(latestTool, ""),
      latestToolState: sanitizeText(latestToolState, latestTool ? "running" : ""),
      usage: sanitizeText(lastUsageSummary, ""),
      durableRunsState,
      durableRunsLabel,
      syncState,
      syncLabel,
      memoryState,
      memoryLabel,
      maintenanceState,
      maintenanceLabel,
      workspaceIndexState,
      workspaceIndexLabel,
      workspaceFileCount,
      voiceState,
      voiceLabel,
      voiceCurrentTask,
      voiceDelegationStatus,
      voicePersona: sanitizeText(voiceSnapshot?.voice, ""),
      voiceMode: sanitizeText(voiceSnapshot?.mode, ""),
      voiceLastUserTranscript,
      voiceLastAssistantTranscript,
      voiceLastError,
      queuedInputCount: formatCount(queuedInputCount, 0),
      pendingAttachmentCount: formatCount(pendingAttachmentCount, 0),
      planCount: formatCount(planCount, 0),
      activeAgentCount: formatCount(activeAgentCount, 0),
      transcriptMode,
      runtimeState,
      runtimeLabel,
      fallbackState,
      fallbackLabel,
      providerLabel,
      modelLabel,
      activeLine,
      activeAgentLabel: activeAgentFocus,
      activeAgentActivity: activeAgentLive,
      plannerStatus: sanitizeText(plannerStatus, "idle"),
      plannerNote: plannerLabel,
      durableActiveTotal,
      durableQueuedSignalsTotal,
      runtimeDaemonState: sanitizeText(runtimeStatus?.state, "unknown"),
    },
    chips: [
      { label: "RUN", value: sanitizeText(phaseLabel, "idle"), tone: stateTone(phaseLabel) },
      { label: "ROUTE", value: routeState, tone: stateTone(routeState) },
      { label: "PROVIDER", value: providerLabel, tone: route ? "teal" : "slate" },
      { label: "MODEL", value: modelLabel, tone: route ? "teal" : "slate" },
      { label: "FAILOVER", value: fallbackState, tone: stateTone(fallbackState) },
      { label: "QUEUE", value: String(formatCount(queuedInputCount, 0)), tone: Number(queuedInputCount) > 0 ? "amber" : "green" },
      ...(
        Number(pendingAttachmentCount) > 0
          ? [{
            label: "FILES",
            value: String(formatCount(pendingAttachmentCount, 0)),
            tone: "teal",
          }]
          : []
      ),
      { label: "GUARD", value: guardValue, tone: approvalAlertCount > 0 ? "red" : errorAlertCount > 0 ? "amber" : "green" },
      { label: "RUNTIME", value: runtimeState, tone: stateTone(runtimeState) },
      { label: "DURABLE", value: durableRunsState, tone: stateTone(durableRunsState) },
      { label: "SYNC", value: syncState, tone: stateTone(syncState) },
      { label: "MEM", value: memoryState, tone: stateTone(memoryState) },
      { label: "INDEX", value: workspaceIndexState, tone: stateTone(workspaceIndexState) },
      ...(
        voiceSnapshot
          ? [{
            label: "VOICE",
            value: voiceState,
            tone: voiceActive ? stateTone(voiceState) : "slate",
          }]
          : []
      ),
      { label: "MAINT", value: maintenanceState, tone: stateTone(maintenanceState) },
      { label: "MODE", value: transcriptMode, tone: detailOpen ? "cyan" : following ? "green" : "amber" },
    ],
    attention: {
      approvalAlertCount,
      errorAlertCount,
      queuedInputCount: formatCount(queuedInputCount, 0),
      pendingAttachmentCount: formatCount(pendingAttachmentCount, 0),
      items: recentAlerts,
    },
    recentTools,
    detail: detail && typeof detail === "object"
      ? {
        diffNavigation: {
          enabled: detail.diffNavigation?.enabled === true,
          currentHunkIndex: formatCount(detail.diffNavigation?.currentHunkIndex, 0),
          totalHunks: formatCount(detail.diffNavigation?.totalHunks, 0),
          currentFilePath: sanitizeText(detail.diffNavigation?.currentFilePath, ""),
        },
      }
      : { diffNavigation: { enabled: false, currentHunkIndex: 0, totalHunks: 0, currentFilePath: "" } },
  };
}

export { ALERT_EVENT_KINDS, TOOL_EVENT_KINDS };
