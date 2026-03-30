import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createOperatorInputBatcher,
  buildWatchCommands,
  matchWatchCommands,
  matchModelNames,
  parseWatchSlashCommand,
  shouldAutoInspectRun,
} from "./agenc-watch-helpers.mjs";
import { readWatchDaemonLogTail } from "./agenc-watch-log-tail.mjs";
import { createWatchCommandController } from "./agenc-watch-commands.mjs";
import { createWatchVoiceController } from "./agenc-watch-voice.mjs";
import { createWatchEventStore } from "./agenc-watch-event-store.mjs";
import { createWatchFrameController } from "./agenc-watch-frame.mjs";
import { createWatchInputController } from "./agenc-watch-input.mjs";
import { createWatchPlannerController } from "./agenc-watch-planner.mjs";
import { createWatchSubagentController } from "./agenc-watch-subagents.mjs";
import { createWatchTransportController } from "./agenc-watch-transport.mjs";
import { loadOperatorEventHelpers } from "./agenc-watch-runtime.mjs";
import {
  createWatchRenderCache,
} from "./agenc-watch-render-cache.mjs";
import {
  isDiffRenderableEvent,
} from "./agenc-watch-diff-render.mjs";
import {
  captureWatchCheckpoint,
  clearSubagentToolArgs,
  createWatchState,
  createWatchStateBindings,
  listWatchCheckpointSummaries,
  loadPersistedWatchState,
  persistWatchState,
  readSubagentToolArgs,
  rememberSubagentToolArgs,
  resetDelegatedWatchState,
  rewindWatchToCheckpoint,
} from "./agenc-watch-state.mjs";
import {
  bindWatchSurfaceState,
  createWatchSurfaceDispatchBridge,
} from "./agenc-watch-surface-bridge.mjs";
import { dispatchOperatorSurfaceEvent } from "./agenc-watch-surface-dispatch.mjs";
import {
  buildAltScreenEnterSequence,
  buildAltScreenLeaveSequence,
  parseMouseWheelSequence,
  supportsTerminalHyperlinks,
} from "./agenc-watch-terminal-sequences.mjs";
import {
  findLatestPendingAgentEvent,
  nextAgentStreamState,
} from "./agenc-watch-agent-stream.mjs";
import {
  computeTranscriptPreviewMaxLines,
  splitTranscriptPreviewForHeadline,
} from "./agenc-watch-transcript-cards.mjs";
import {
  autocompleteComposerFileTag,
  autocompleteSlashComposerInput,
  buildComposerRenderLine,
  currentComposerInput,
  deleteComposerBackward,
  deleteComposerForward,
  deleteComposerToLineEnd,
  getActiveFileTagQuery,
  getComposerFileTagSuggestions,
  insertComposerText,
  isSlashComposerInput,
  moveComposerCursorByCharacter,
  moveComposerCursorByWord,
  navigateComposerHistory,
  recordComposerHistory as rememberComposerHistory,
  resetComposerState,
  setComposerInputValue,
} from "./agenc-watch-composer.mjs";
import {
  applyScrollDelta as applyViewportScrollDelta,
  bottomAlignRows as bottomAlignViewportRows,
  isTranscriptFollowing as isViewportTranscriptFollowing,
  preserveManualTranscriptViewport,
  sliceRowsAroundRange as sliceViewportRowsAroundRange,
  sliceRowsFromBottom as sliceViewportRowsFromBottom,
} from "./agenc-watch-viewport.mjs";
import {
  buildCommandPaletteSummary,
  buildFileTagPaletteSummary,
  buildDetailPaneSummary,
  buildWatchFooterSummary,
  buildTranscriptEventSummary,
  buildWatchLayout,
  buildWatchSidebarPolicy,
  buildWatchSurfaceSummary,
  shouldShowWatchSplash,
} from "./agenc-watch-surface-summary.mjs";
import { createWatchToolPresentation } from "./agenc-watch-tool-presentation.mjs";
import { loadWorkspaceFileIndex } from "./agenc-watch-workspace-index.mjs";
import { loadWebSocketConstructor } from "./agenc-websocket.mjs";
import { createWatchSurfaceStateController } from "./agenc-watch-surface-state.mjs";
import { resolveWatchFeatureFlags } from "./agenc-watch-feature-flags.mjs";
import {
  buildWatchExtensibilityReport,
  listWatchUserSkills,
  readWatchRuntimeConfig,
  updateWatchMcpServerState,
  updateWatchTrustedPluginPackage,
} from "./agenc-watch-extensibility.mjs";
import {
  createQueuedWatchAttachment,
  formatQueuedWatchAttachments,
  resolveWatchAttachmentInputPath,
  resolveQueuedWatchAttachmentPayloads,
} from "./agenc-watch-attachments.mjs";
import {
  buildWatchExportBundle,
  writeWatchExportBundle,
} from "./agenc-watch-export-bundle.mjs";
import { buildWatchInsightsReport } from "./agenc-watch-insights.mjs";
import { buildWatchAgentsReport } from "./agenc-watch-agents.mjs";
import {
  buildWatchLocalConfigReport,
  buildWatchUiPreferencesReport,
} from "./agenc-watch-ui-preferences.mjs";
import {
  buildWatchSessionQueryCandidates,
  clearWatchSessionLabel,
  resolveWatchSessionLabel,
  setWatchSessionLabel,
} from "./agenc-watch-session-indexing.mjs";

// ─── Extracted modules ──────────────────────────────────────────────
import {
  sanitizeLargeText,
  sanitizeInlineText,
  stripTerminalControlSequences,
  stripMarkdownDecorators,
  sanitizeDisplayText,
  stable,
  tryPrettyJson,
  tryParseJson,
  truncate,
  formatCompactNumber,
  formatElapsedMs,
  formatClockLabel,
  visibleLength,
  truncateAnsi,
  fitAnsi,
  padAnsi,
  wrapLine,
  wrapBlock,
  parseStructuredJson,
} from "./agenc-watch-text-utils.mjs";

import {
  color,
  applyWatchTheme,
  toneTheme,
  toneColor,
  toneSpec,
  badge,
  chip,
  stateTone,
  onSurface,
  paintSurface,
  flexBetween,
  blankRow,
  panelTop,
  panelBottom,
  panelRow,
  renderPanel,
  row,
  wrapAndLimit,
  formatMetric,
  joinColumns,
} from "./agenc-watch-ui-primitives.mjs";

import {
  eventBodyLines,
  createDisplayLine,
  displayLineText,
  displayLinePlainText,
  isMarkdownRenderableEvent,
  normalizeDisplayLines,
  eventPreviewMode,
  isSourcePreviewEvent,
  isMutationPreviewEvent,
  normalizeEventBody as _normalizeEventBody,
  normalizeOptionalEventText,
  normalizeOptionalFileRange,
  renderMetadataPayload,
  buildRenderSignature,
  applyDescriptorRenderingMetadata,
  descriptorEventMetadata,
  sourceFileRangeLabel,
  buildSourcePreviewDisplayLines,
  buildEventDisplayLines as _buildEventDisplayLines,
  wrapDisplayLines,
  wrapEventDisplayLines as _wrapEventDisplayLines,
  compactBodyLines as _compactBodyLines,
  renderEventBodyLine as _renderEventBodyLine,
} from "./agenc-watch-event-display.mjs";

import {
  planStatusTone,
  planStatusGlyph,
  sanitizePlanLabel,
  plannerDagStatusTone,
  plannerDagStatusGlyph,
  plannerDagTypeGlyph,
  planStepDisplayName,
  resetPlannerDagState as _resetPlannerDagState,
  findTrackedPlannerDagKey as _findTrackedPlannerDagKey,
  ensurePlannerDagNode as _ensurePlannerDagNode,
  recomputePlannerDagStatus as _recomputePlannerDagStatus,
  syncPlannerDagEdges as _syncPlannerDagEdges,
  updatePlannerDagNode as _updatePlannerDagNode,
  retirePlannerDagOpenNodes as _retirePlannerDagOpenNodes,
  inferMergedPlannerDagOrder as _inferMergedPlannerDagOrder,
  ingestPlannerDag as _ingestPlannerDag,
  plannerTraceSessionPrefix,
  listPlannerTraceArtifactsForSession,
  readPlannerTracePayload,
  hydratePlannerDagFromTraceArtifacts as _hydratePlannerDagFromTraceArtifacts,
  hydratePlannerDagForLiveSession as _hydratePlannerDagForLiveSession,
  ensureSubagentPlanStep as _ensureSubagentPlanStep,
  updateSubagentPlanStep as _updateSubagentPlanStep,
} from "./agenc-watch-planner-dag.mjs";

import {
  formatCommandPaletteText as _formatCommandPaletteText,
  formatSessionSummaries,
  formatHistoryPayload,
  formatStatusPayload,
  statusFeedFingerprint,
  formatLogPayload,
  summarizeUsage,
  firstMeaningfulLine,
  contentPreviewLines,
  compactSessionToken,
  buildToolSummary,
  summarizeRunDetail as _summarizeRunDetail,
} from "./agenc-watch-format-payloads.mjs";

import {
  normalizeSessionValue as _normalizeSessionValue,
  sessionValuesMatch as _sessionValuesMatch,
  normalizeModelRoute as _normalizeModelRoute,
  formatModelRouteLabel,
  modelRouteTone as _modelRouteTone,
  shouldSurfaceTransientStatus,
  isExpectedMissingRunInspect,
  isUnavailableBackgroundRunInspect,
  isRetryableBootstrapError,
  buildSurfaceSummaryCacheKey,
  latestSessionSummary,
} from "./agenc-watch-session-utils.mjs";

// Re-export for external consumers (tests, harness)
export { buildSurfaceSummaryCacheKey, latestSessionSummary };

export async function createWatchApp(runtime = {}) {
const process = runtime.processLike ?? globalThis.process;
const nowMs = runtime.nowMs ?? Date.now;
const setTimeout = runtime.setTimeout ?? globalThis.setTimeout.bind(globalThis);
const clearTimeout = runtime.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
const setInterval = runtime.setInterval ?? globalThis.setInterval.bind(globalThis);
const clearInterval = runtime.clearInterval ?? globalThis.clearInterval.bind(globalThis);
const WebSocket = runtime.WebSocket ?? await loadWebSocketConstructor();
const {
  normalizeOperatorMessage,
  projectOperatorSurfaceEvent,
  shouldIgnoreOperatorMessage,
} = runtime.operatorEventHelpers ?? await loadOperatorEventHelpers();

const wsUrl = process.env.AGENC_WATCH_WS_URL ?? "ws://127.0.0.1:3100";
const clientKey = process.env.AGENC_WATCH_CLIENT_KEY ?? "tmux-live-watch";
const resolvedProjectRoot = path.resolve(
  process.env.AGENC_WATCH_PROJECT_ROOT ?? process.cwd(),
);
const projectRoot = fs.existsSync(resolvedProjectRoot)
  ? fs.realpathSync.native(resolvedProjectRoot)
  : resolvedProjectRoot;
const watchStateFile =
  process.env.AGENC_WATCH_STATE_FILE ??
  path.join(
    os.homedir(),
    ".agenc",
    `watch-state-${clientKey.replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`,
  );
const tracePayloadRoot = path.join(os.homedir(), ".agenc", "trace-payloads");
const reconnectMinDelayMs = 1_000;
const reconnectMaxDelayMs = 5_000;
const statusPollIntervalMs = 5_000;
const activityPulseIntervalMs = 200;
const startupSplashMinMs = 1_500;
const maxEvents = 140;
const maxInlineChars = 220;
const maxStoredBodyChars = 96_000;
const enableMouseTracking = /^(1|true|yes|on)$/i.test(
  String(process.env.AGENC_WATCH_ENABLE_MOUSE ?? ""),
);
const watchFeatureFlags = resolveWatchFeatureFlags({ env: process.env });
const watchCommands = buildWatchCommands({ featureFlags: watchFeatureFlags });
const maxFeedPreviewLines = 3;
const maxPreviewSourceLines = 160;
const LIVE_EVENT_FILTERS = Object.freeze([
  "subagents.*",
  "planner_*",
]);
const introDismissKinds = new Set([
  "you",
  "agent",
  "tool",
  "tool result",
  "tool error",
  "subagent",
  "subagent tool",
  "subagent tool result",
  "subagent error",
  "run",
  "approval",
  "social",
  "operator",
]);

const maxEventBodyLines = 5;
const DAG_NODE_IDS = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const launchedAtMs = nowMs();
const persistedWatchState = loadPersistedWatchState({
  fs,
  path,
  watchStateFile,
  clientKey,
});
const watchState = createWatchState({ persistedWatchState, launchedAtMs });
applyWatchTheme(watchState.inputPreferences?.themeName);

let requestCounter = 0;
let shuttingDown = false;
const transportState = {
  isOpen: false,
  reconnectAttempts: 0,
  reconnectTimer: null,
  bootstrapTimer: null,
  statusPollTimer: null,
  activityPulseTimer: null,
  ws: null,
  connectionState: "connecting",
};
let watchCommandController = null;
let watchFrameController = null;
let watchInputController = null;
let watchPlannerController = null;
let watchSubagentController = null;
let watchTransportController = null;
let surfaceDispatchApi = null;
const watchRenderCache = createWatchRenderCache();
const enableWatchHyperlinks = supportsTerminalHyperlinks({
  stream: process.stdout,
  env: process.env,
});
const workspaceFileIndex = loadWorkspaceFileIndex({
  cwd: process.cwd(),
});
const operatorInputBatcher = createOperatorInputBatcher({
  onDispatch: (value) => {
    dispatchOperatorInput(value);
  },
  setTimer: setTimeout,
  clearTimer: clearTimeout,
});

const pendingFrames = [];
const queuedOperatorInputs = watchState.queuedOperatorInputs;
const pendingAttachments = watchState.pendingAttachments;
const subagentPlanSteps = watchState.subagentPlanSteps;
const subagentSessionPlanKeys = watchState.subagentSessionPlanKeys;
const subagentLiveActivity = watchState.subagentLiveActivity;
const recentSubagentLifecycleFingerprints = watchState.recentSubagentLifecycleFingerprints;
const plannerDagNodes = watchState.plannerDagNodes;
const plannerDagEdges = watchState.plannerDagEdges;
const events = watchState.events;
let inputListener = null;
let resizeListener = null;
let startupTimer = null;
let started = false;
let disposed = false;
let resolvedExitCode = null;
let resolveClosed = () => {};
const closed = new Promise((resolve) => {
  resolveClosed = resolve;
});

function nextId(prefix = "req") {
  requestCounter += 1;
  return `${prefix}-${requestCounter}`;
}

function nowStamp() {
  return new Date(nowMs()).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function normalizeSessionValue(value) {
  return _normalizeSessionValue(value);
}

function sessionValuesMatch(left, right) {
  return _sessionValuesMatch(left, right);
}

function persistOwnerToken(nextOwnerToken) {
  persistWatchLocalState({
    ownerToken: nextOwnerToken,
    sessionId: watchState.sessionId,
  });
}

function persistWatchLocalState({
  ownerToken = watchState.ownerToken,
  sessionId = watchState.sessionId,
  sessionLabels = watchState.sessionLabels,
  uiPreferences = watchState.inputPreferences,
  pendingAttachmentState = watchState.pendingAttachments,
  attachmentSequence = watchState.attachmentSequence,
} = {}) {
  persistWatchState({
    fs,
    path,
    watchStateFile,
    clientKey,
    ownerToken,
    sessionId,
    sessionLabels,
    uiPreferences,
    pendingAttachments: pendingAttachmentState,
    attachmentSequence,
    checkpoints: watchState.checkpoints,
    checkpointSnapshots: watchState.checkpointSnapshots,
    checkpointSequence: watchState.checkpointSequence,
    activeCheckpointId: watchState.activeCheckpointId,
  });
}

function persistSessionId(nextSessionId) {
  persistWatchLocalState({
    ownerToken: watchState.ownerToken,
    sessionId: nextSessionId,
  });
}

function currentSessionLabel() {
  return resolveWatchSessionLabel(watchState.sessionId, watchState.sessionLabels);
}

function currentInputPreferences() {
  return watchState.inputPreferences;
}

function setCurrentSessionLabel(label) {
  const result = setWatchSessionLabel(watchState.sessionLabels, watchState.sessionId, label);
  persistWatchLocalState();
  return result;
}

function clearCurrentSessionLabel() {
  const previous = clearWatchSessionLabel(watchState.sessionLabels, watchState.sessionId);
  persistWatchLocalState();
  return previous;
}

function showInputModes() {
  const report = buildWatchUiPreferencesReport({
    preferences: watchState.inputPreferences,
    composerMode: watchState.composerMode,
  });
  setTransientStatus("input preferences ready");
  pushEvent("operator", "Input Preferences", report, "slate");
  return report;
}

function currentStatuslineEnabled() {
  return watchFeatureFlags.statusline === true;
}

function setStatuslineEnabled(enabled) {
  watchFeatureFlags.statusline = enabled === true;
  scheduleRender();
  return watchFeatureFlags.statusline;
}

function showConfig() {
  const report = buildWatchLocalConfigReport({
    preferences: watchState.inputPreferences,
    composerMode: watchState.composerMode,
    statuslineEnabled: currentStatuslineEnabled(),
  });
  pushEvent("operator", "Local Config", report, "slate");
  return report;
}

function setInputModeProfile(profile) {
  watchState.inputPreferences = {
    ...watchState.inputPreferences,
    inputModeProfile: profile,
    keybindingProfile: profile === "vim"
      ? "vim"
      : watchState.inputPreferences?.keybindingProfile === "vim"
        ? "default"
        : watchState.inputPreferences?.keybindingProfile ?? "default",
  };
  watchState.composerMode = "insert";
  persistWatchLocalState();
  scheduleRender();
  return watchState.inputPreferences;
}

function setKeybindingProfile(profile) {
  watchState.inputPreferences = {
    ...watchState.inputPreferences,
    keybindingProfile: profile,
  };
  if (profile === "vim") {
    watchState.inputPreferences.inputModeProfile = "vim";
  } else if (watchState.inputPreferences.inputModeProfile === "vim") {
    watchState.inputPreferences.inputModeProfile = "default";
    watchState.composerMode = "insert";
  }
  persistWatchLocalState();
  scheduleRender();
  return watchState.inputPreferences;
}

function setThemeName(themeName) {
  const appliedTheme = applyWatchTheme(themeName);
  watchState.inputPreferences = {
    ...watchState.inputPreferences,
    themeName: appliedTheme,
  };
  persistWatchLocalState();
  scheduleRender();
  return watchState.inputPreferences;
}

function sessionQueryCandidates(session) {
  return buildWatchSessionQueryCandidates(session, {
    sessionLabels: watchState.sessionLabels,
  });
}

function captureCheckpoint(label, { reason = "manual" } = {}) {
  const summary = captureWatchCheckpoint(watchState, {
    label,
    reason,
    nowMs,
  });
  persistWatchLocalState();
  return summary;
}

function listCheckpoints({ limit = 8 } = {}) {
  return listWatchCheckpointSummaries(watchState, { limit });
}

function rewindToCheckpoint(reference = "latest") {
  const summary = rewindWatchToCheckpoint(watchState, reference);
  if (!summary) {
    return null;
  }
  persistWatchLocalState();
  return summary;
}

function nextAttachmentId() {
  const nextSequence = Number.isFinite(Number(watchState.attachmentSequence))
    ? Number(watchState.attachmentSequence) + 1
    : 1;
  watchState.attachmentSequence = nextSequence;
  return `att-${nextSequence}`;
}

function currentPendingAttachments() {
  return pendingAttachments.map((attachment, index) => ({
    ...attachment,
    index: index + 1,
  }));
}

function formatPendingAttachments() {
  return formatQueuedWatchAttachments(currentPendingAttachments());
}

function queuePendingAttachment(inputPath, { allowMissing = false } = {}) {
  const attachment = createQueuedWatchAttachment({
    fs,
    pathModule: path,
    inputPath,
    projectRoot,
    id: nextAttachmentId(),
    allowMissing,
  });
  const existing = pendingAttachments.find((entry) => entry.path === attachment.path);
  if (existing) {
    return {
      attachment: existing,
      duplicate: true,
    };
  }
  pendingAttachments.push(attachment);
  persistWatchLocalState();
  return {
    attachment,
    duplicate: false,
  };
}

function clearPendingAttachments() {
  const removed = pendingAttachments.splice(0, pendingAttachments.length);
  if (removed.length > 0) {
    persistWatchLocalState();
  }
  return removed;
}

function removePendingAttachment(reference = null) {
  const normalized = String(reference ?? "").trim();
  if (pendingAttachments.length === 0) {
    return {
      removed: [],
      error: "No attachments are currently queued.",
    };
  }
  if (!normalized) {
    const removed = pendingAttachments.splice(-1, 1);
    persistWatchLocalState();
    return { removed };
  }
  if (normalized.toLowerCase() === "all") {
    return {
      removed: clearPendingAttachments(),
    };
  }
  const asIndex = Number(normalized);
  if (Number.isFinite(asIndex) && asIndex >= 1 && Number.isInteger(asIndex)) {
    const zeroIndex = asIndex - 1;
    if (zeroIndex >= pendingAttachments.length) {
      return {
        removed: [],
        error: `No attachment matched ${normalized}.`,
      };
    }
    const removed = pendingAttachments.splice(zeroIndex, 1);
    persistWatchLocalState();
    return { removed };
  }
  const exactMatches = pendingAttachments.filter((attachment) =>
    attachment.id === normalized ||
    attachment.path === normalized ||
    attachment.displayPath === normalized,
  );
  const filenameMatches = pendingAttachments.filter((attachment) =>
    attachment.filename === normalized,
  );
  const matches = exactMatches.length > 0 ? exactMatches : filenameMatches;
  if (matches.length === 0) {
    return {
      removed: [],
      error: `No attachment matched ${normalized}.`,
    };
  }
  if (exactMatches.length === 0 && matches.length > 1) {
    return {
      removed: [],
      error: `Attachment reference ${normalized} is ambiguous. Use /attachments for the numeric index or attachment id.`,
    };
  }
  const removed = [];
  for (const match of matches) {
    const index = pendingAttachments.findIndex((attachment) => attachment.id === match.id);
    if (index >= 0) {
      removed.push(...pendingAttachments.splice(index, 1));
    }
  }
  persistWatchLocalState();
  return { removed };
}

function prepareChatMessagePayload(content, { consumeAttachments = true } = {}) {
  const queued = currentPendingAttachments();
  if (queued.length === 0) {
    return {
      payload: authPayload({ content }),
      attachmentSummaries: [],
    };
  }
  const attachments = resolveQueuedWatchAttachmentPayloads(queued, { fs });
  if (consumeAttachments === true) {
    pendingAttachments.splice(0, pendingAttachments.length);
    persistWatchLocalState();
  }
  return {
    payload: authPayload({ content, attachments }),
    attachmentSummaries: queued,
  };
}

function readExtensibilityContext() {
  return {
    configSnapshot: readWatchRuntimeConfig({
      fs,
      env: process.env,
      osModule: os,
      pathModule: path,
    }),
    localSkillCatalog: listWatchUserSkills({
      fs,
      env: process.env,
      osModule: os,
      pathModule: path,
    }),
  };
}

function showExtensibility({
  section = "overview",
} = {}) {
  const { configSnapshot, localSkillCatalog } = readExtensibilityContext();
  const report = buildWatchExtensibilityReport({
    projectRoot,
    watchState,
    configSnapshot,
    localSkillCatalog,
    section,
  });
  setTransientStatus(`extensibility: ${section}`);
  pushEvent("operator", "Extensibility", report, "slate");
  return report;
}

function trustPluginPackage(packageName, allowedSubpaths = []) {
  const { configSnapshot } = readExtensibilityContext();
  const result = updateWatchTrustedPluginPackage({
    fs,
    configPath: configSnapshot.configPath,
    packageName,
    allowedSubpaths,
  });
  setTransientStatus(`plugin trusted: ${packageName}`);
  pushEvent(
    "operator",
    "Plugin Trust Updated",
    [
      `Config: ${result.configPath}`,
      `Package: ${result.packageName}`,
      `Trusted packages: ${result.trustedPackages.length}`,
      "Config watcher should pick up the change automatically if the daemon is live.",
    ].join("\n"),
    "teal",
  );
  return result;
}

function untrustPluginPackage(packageName) {
  const { configSnapshot } = readExtensibilityContext();
  const result = updateWatchTrustedPluginPackage({
    fs,
    configPath: configSnapshot.configPath,
    packageName,
    remove: true,
  });
  setTransientStatus(`plugin untrusted: ${packageName}`);
  pushEvent(
    "operator",
    "Plugin Trust Updated",
    [
      `Config: ${result.configPath}`,
      `Package: ${result.packageName}`,
      `Trusted packages: ${result.trustedPackages.length}`,
      "Config watcher should pick up the change automatically if the daemon is live.",
    ].join("\n"),
    "teal",
  );
  return result;
}

function setMcpServerEnabled(serverName, enabled) {
  const { configSnapshot } = readExtensibilityContext();
  const result = updateWatchMcpServerState({
    fs,
    configPath: configSnapshot.configPath,
    serverName,
    enabled,
  });
  setTransientStatus(`mcp ${enabled ? "enabled" : "disabled"}: ${serverName}`);
  pushEvent(
    "operator",
    "MCP Server Updated",
    [
      `Config: ${result.configPath}`,
      `Server: ${result.serverName}`,
      `State: ${result.enabled ? "enabled" : "disabled"}`,
      "Config watcher should pick up the change automatically if the daemon is live.",
    ].join("\n"),
    "teal",
  );
  return result;
}

function dismissIntro() {
  watchState.introDismissed = true;
}

function termWidth() {
  return Math.max(74, process.stdout.columns || 100);
}

function termHeight() {
  return Math.max(12, process.stdout.rows || 40);
}

function currentTranscriptLayout() {
  return watchFrameController?.currentTranscriptLayout() ?? buildWatchLayout({
    width: termWidth(),
    height: termHeight(),
    headerRows: 4,
    popupRows: 0,
    slashMode: false,
    detailOpen: Boolean(watchState.expandedEventId),
  });
}

const surfaceState = createWatchSurfaceStateController({
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
  normalizeModelRouteImpl: _normalizeModelRoute,
  modelRouteToneImpl: _modelRouteTone,
  resolveSessionLabel: currentSessionLabel,
});

const {
  activePlanEntries,
  activeAgentEntries,
  animatedWorkingGlyph,
  currentActiveAgentFocus,
  currentDisplayObjective,
  currentPhaseLabel,
  currentPlanFocusStep,
  currentRunElapsedLabel,
  currentSessionElapsedLabel,
  currentSurfaceSummary,
  currentSurfaceToolLabel,
  effectiveModelRoute,
  effectiveSurfacePhaseLabel,
  hasActiveSurfaceRun,
  modelRouteTone,
  normalizeModelRoute,
} = surfaceState;

// ─── Thin wrappers binding closure state to extracted pure functions ─

function normalizeEventBody(body) {
  return _normalizeEventBody(body, maxStoredBodyChars);
}

function compactBodyLines(value, maxLines = 4) {
  return _compactBodyLines(value, maxLines, maxInlineChars);
}

function renderEventBodyLine(event, line, { inline = false } = {}) {
  return _renderEventBodyLine(event, line, {
    inline,
    color,
    cwd: process.cwd(),
    enableHyperlinks: enableWatchHyperlinks,
    isSourcePreview: isSourcePreviewEvent(event),
  });
}

function buildEventDisplayLines(event, maxLines = Infinity) {
  return _buildEventDisplayLines(event, watchRenderCache, {
    cwd: process.cwd(),
    maxInlineChars,
    maxPreviewSourceLines,
  }, maxLines);
}

function wrapEventDisplayLines(event, width, maxLines = Infinity) {
  return _wrapEventDisplayLines(event, watchRenderCache, {
    cwd: process.cwd(),
    maxInlineChars,
    maxPreviewSourceLines,
  }, width, maxLines);
}

function formatCommandPaletteText(command) {
  return _formatCommandPaletteText(command, color);
}

function summarizeRunDetail(detail) {
  return _summarizeRunDetail(detail, watchState);
}

// ─── Planner DAG wrappers binding closure state ─────────────────────

function resetPlannerDagState() {
  _resetPlannerDagState(watchState, plannerDagNodes, plannerDagEdges);
}

function findTrackedPlannerDagKey(input = {}) {
  return _findTrackedPlannerDagKey(plannerDagNodes, input);
}

function ensurePlannerDagNode(input = {}) {
  return _ensurePlannerDagNode(watchState, plannerDagNodes, nowMs, input);
}

function syncPlannerDagEdges(steps = [], edges = [], options = {}) {
  return _syncPlannerDagEdges(plannerDagEdges, steps, edges, options);
}

function recomputePlannerDagStatus() {
  return _recomputePlannerDagStatus(watchState, plannerDagNodes);
}

function updatePlannerDagNode(input = {}) {
  return _updatePlannerDagNode(watchState, plannerDagNodes, nowMs, input);
}

function retirePlannerDagOpenNodes(status = "cancelled", note = null) {
  return _retirePlannerDagOpenNodes(watchState, plannerDagNodes, nowMs, status, note);
}

function ingestPlannerDag(payload = {}, options = {}) {
  return _ingestPlannerDag(watchState, plannerDagNodes, plannerDagEdges, nowMs, payload, options);
}

function hydratePlannerDagFromTraceArtifacts(sessionValue, options = {}) {
  return _hydratePlannerDagFromTraceArtifacts(
    watchState, plannerDagNodes, plannerDagEdges, tracePayloadRoot, nowMs,
    sessionValue, options,
  );
}

function hydratePlannerDagForLiveSession(options = {}) {
  return _hydratePlannerDagForLiveSession(
    watchState, plannerDagNodes, plannerDagEdges, tracePayloadRoot, nowMs,
    options,
  );
}

function ensureSubagentPlanStep(input = {}) {
  return _ensureSubagentPlanStep(watchState, subagentPlanSteps, subagentSessionPlanKeys, nowMs, input);
}

function updateSubagentPlanStep(input = {}) {
  return _updateSubagentPlanStep(
    watchState, plannerDagNodes, plannerDagEdges,
    subagentPlanSteps, subagentSessionPlanKeys, nowMs,
    input,
  );
}

// ─── Transient status & event store ─────────────────────────────────

function setTransientStatus(value) {
  watchState.transientStatus = truncate(sanitizeInlineText(value || "idle"), 160);
  scheduleRender();
}

const eventStore = createWatchEventStore({
  watchState,
  events,
  maxEvents,
  introDismissKinds,
  nextId,
  nowStamp,
  normalizeEventBody,
  sanitizeLargeText,
  sanitizeInlineText,
  stripTerminalControlSequences,
  dismissIntro,
  scheduleRender,
  withPreservedManualTranscriptViewport,
  findLatestPendingAgentEvent,
  nextAgentStreamState,
  setTransientStatus,
  resetDelegationState,
  applyDescriptorRenderingMetadata,
  nowMs,
});

const {
  pushEvent,
  appendAgentStreamChunk,
  commitAgentMessage,
  cancelAgentStream,
  restoreTranscriptFromHistory,
  upsertSubagentHeartbeatEvent,
  clearSubagentHeartbeatEvents,
  replaceLatestToolEvent,
  replaceLatestSubagentToolEvent,
  clearLiveTranscriptView,
} = eventStore;

function authPayload(extra = {}) {
  const payload = { clientKey, workspaceRoot: projectRoot, ...extra };
  if (watchState.ownerToken) {
    payload.ownerToken = watchState.ownerToken;
  }
  return payload;
}

function currentInputValue() {
  return currentComposerInput(watchState);
}

function currentSlashSuggestions(limit = 8) {
  return matchWatchCommands(currentInputValue(), { limit, commands: watchCommands });
}

function currentModelSuggestions(limit = 6) {
  const input = currentInputValue().trimStart();
  const match = input.match(/^\/models?\s+(.*)/i);
  if (!match) return [];
  return matchModelNames(match[1].trim(), { limit });
}

function currentFileTagQuery() {
  return getActiveFileTagQuery({
    input: currentInputValue(),
    cursor: watchState.composerCursor,
  });
}

function currentFileTagSuggestions(limit = 8) {
  return getComposerFileTagSuggestions({
    input: currentInputValue(),
    cursor: watchState.composerCursor,
    fileIndex: workspaceFileIndex,
    limit,
  });
}

function currentFileTagPalette(limit = 8) {
  const activeTag = currentFileTagQuery();
  const suggestions = activeTag ? currentFileTagSuggestions(limit) : [];
  return {
    activeTag,
    suggestions,
    summary: buildFileTagPaletteSummary({
      inputValue: currentInputValue(),
      query: activeTag?.query ?? null,
      suggestions,
      indexReady: workspaceFileIndex.ready,
      indexError: workspaceFileIndex.error,
    }),
  };
}

function resetComposer() {
  resetComposerState(watchState);
}

function insertComposerTextValue(text, options) {
  insertComposerText(watchState, text, options);
}

function moveComposerCursor(direction) {
  moveComposerCursorByWord(watchState, direction);
}

function moveComposerCursorHorizontally(direction) {
  moveComposerCursorByCharacter(watchState, direction);
}

function deleteComposerCharacterBackward() {
  return deleteComposerBackward(watchState);
}

function deleteComposerCharacterForward() {
  return deleteComposerForward(watchState);
}

function deleteComposerTail() {
  deleteComposerToLineEnd(watchState);
}

function navigateComposer(direction) {
  navigateComposerHistory(watchState, direction);
}

function autocompleteComposerInput() {
  if (autocompleteComposerFileTag(watchState, workspaceFileIndex, { limit: 8 })) {
    return true;
  }
  return autocompleteSlashComposerInput(
    watchState,
    (input, options = {}) => matchWatchCommands(input, { ...options, commands: watchCommands }),
  );
}

function composerRenderLine(width) {
  return buildComposerRenderLine({
    input: currentInputValue(),
    cursor: watchState.composerCursor,
    prompt: promptLabel(),
    width,
    visibleLength,
    pastedRanges: watchState.composerPastedRanges,
  });
}

function resolveExit(exitCode = 0) {
  if (resolvedExitCode !== null) {
    return resolvedExitCode;
  }
  resolvedExitCode = exitCode;
  resolveClosed(exitCode);
  return exitCode;
}

function dispose(exitCode = 0) {
  if (disposed) {
    return resolveExit(exitCode);
  }
  disposed = true;
  shuttingDown = true;
  operatorInputBatcher.dispose();
  watchTransportController?.dispose();
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (inputListener) {
    process.stdin.off("data", inputListener);
    inputListener = null;
  }
  if (resizeListener) {
    process.stdout.off("resize", resizeListener);
    resizeListener = null;
  }
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  leaveAltScreen();
  return resolveExit(exitCode);
}

function shutdownWatch(exitCode = 0) {
  return dispose(exitCode);
}

function recordComposerHistory(value) {
  rememberComposerHistory(watchState, value);
}

function requestRunInspect(reason, { force = false } = {}) {
  if (
    !watchState.sessionId ||
    !transportState.isOpen ||
    (!force && watchState.runInspectPending) ||
    (!force && !shouldAutoInspectRun(watchState.runDetail, watchState.runState))
  ) {
    return;
  }
  watchState.runInspectPending = true;
  send("run.inspect", { sessionId: watchState.sessionId });
  setTransientStatus(`refreshing run card (${reason})`);
}

function clearBootstrapTimer() {
  return watchTransportController.clearBootstrapTimer();
}

function clearStatusPollTimer() {
  return watchTransportController.clearStatusPollTimer();
}

function clearActivityPulseTimer() {
  return watchTransportController.clearActivityPulseTimer();
}

function ensureStatusPollTimer() {
  return watchTransportController.ensureStatusPollTimer();
}

function ensureActivityPulseTimer() {
  return watchTransportController.ensureActivityPulseTimer();
}

function bootstrapPending() {
  return watchTransportController.bootstrapPending();
}

function markBootstrapReady(statusText) {
  return watchTransportController.markBootstrapReady(statusText);
}

function sendBootstrapProbe() {
  return watchTransportController.sendBootstrapProbe();
}

function scheduleBootstrap(reason = "restoring session") {
  return watchTransportController.scheduleBootstrap(reason);
}

const watchVoiceController = createWatchVoiceController({
  send,
  authPayload,
  pushEvent,
  setTransientStatus,
  watchState,
});

watchCommandController = createWatchCommandController({
  watchState,
  queuedOperatorInputs,
  WATCH_COMMANDS: watchCommands,
  parseWatchSlashCommand: (input) => parseWatchSlashCommand(input, { commands: watchCommands }),
  authPayload,
  send,
  shutdownWatch,
  dismissIntro,
  clearLiveTranscriptView,
  exportCurrentView,
  exportBundle,
  showInsights,
  showAgents,
  showExtensibility,
  showInputModes,
  showConfig,
  resetLiveRunSurface,
  resetDelegationState,
  persistSessionId,
  currentSessionLabel,
  setSessionLabel: setCurrentSessionLabel,
  clearSessionLabel: clearCurrentSessionLabel,
  currentInputPreferences,
  setInputModeProfile,
  setKeybindingProfile,
  setThemeName,
  currentStatuslineEnabled,
  setStatuslineEnabled,
  trustPluginPackage,
  untrustPluginPackage,
  setMcpServerEnabled,
  captureCheckpoint,
  listCheckpoints,
  listPendingAttachments: currentPendingAttachments,
  formatPendingAttachments,
  queuePendingAttachment,
  resolveImplicitAttachmentInput: (value) => resolveWatchAttachmentInputPath({
    fs,
    pathModule: path,
    inputPath: value,
    projectRoot,
  }),
  removePendingAttachment,
  clearPendingAttachments,
  prepareChatMessagePayload,
  openLatestDiffDetail,
  currentDiffNavigationState: () =>
    watchFrameController?.currentDiffNavigationState() ?? {
      enabled: false,
      currentHunkIndex: 0,
      totalHunks: 0,
      currentFilePath: "",
    },
  jumpCurrentDiffHunk: (direction) => watchFrameController?.jumpCurrentDiffHunk(direction) ?? false,
  closeDetailView: () => {
    const navigation = watchFrameController?.currentDiffNavigationState() ?? { enabled: false };
    if (navigation.enabled !== true) {
      return false;
    }
    watchFrameController?.toggleExpandedEvent();
    return true;
  },
  rewindToCheckpoint,
  clearBootstrapTimer,
  pushEvent,
  setTransientStatus,
  readWatchDaemonLogTail,
  formatLogPayload,
  currentClientKey: () => clientKey,
  isOpen: () => transportState.isOpen,
  bootstrapPending,
  voiceController: watchVoiceController,
  nowMs,
});

function shouldShowSplash() {
  return watchFrameController?.shouldShowSplash() ?? false;
}

function resetLiveRunSurface() {
  watchState.latestAgentSummary = null;
  watchState.latestTool = null;
  watchState.latestToolState = null;
  watchState.lastUsageSummary = null;
  watchState.liveSessionModelRoute = null;
  watchState.activeRunStartedAtMs = null;
}

function latestExpandableEvent() {
  return watchFrameController?.latestExpandableEvent() ?? (events[events.length - 1] ?? null);
}

function currentExpandedEvent() {
  return watchFrameController?.currentExpandedEvent() ??
    (watchState.expandedEventId
      ? events.find((event) => event.id === watchState.expandedEventId) ?? null
      : null);
}

function openLatestDiffDetail() {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isDiffRenderableEvent(event)) {
      continue;
    }
    watchState.expandedEventId = event.id ?? null;
    watchState.detailScrollOffset = 0;
    setTransientStatus(`detail open: ${event.title}`);
    return event;
  }
  return null;
}

function toggleExpandedEvent() {
  watchFrameController?.toggleExpandedEvent();
}

function currentTranscriptRowCount() {
  return watchFrameController?.currentTranscriptRowCount() ?? 0;
}

function withPreservedManualTranscriptViewport(mutator) {
  if (watchFrameController) {
    return watchFrameController.withPreservedManualTranscriptViewport(mutator);
  }
  return mutator({ shouldFollow: isTranscriptFollowing() });
}

function isTranscriptFollowing() {
  return isViewportTranscriptFollowing({
    transcriptFollowMode: watchState.transcriptFollowMode,
    transcriptScrollOffset: watchState.transcriptScrollOffset,
  });
}

function exportCurrentView({ announce = false } = {}) {
  return watchFrameController?.exportCurrentView({ announce }) ?? null;
}

function exportBundle({ announce = false } = {}) {
  const bundle = buildWatchExportBundle({
    projectRoot,
    watchState,
    surfaceSummary: currentSurfaceSummary(),
    frameSnapshot: buildVisibleFrameSnapshot({
      width: termWidth(),
      height: termHeight(),
    }),
    exportedAtMs: nowMs(),
  });
  const exportPath = writeWatchExportBundle({
    fs,
    bundle,
    nowMs,
    pathModule: path,
  });
  if (announce) {
    pushEvent(
      "operator",
      "Bundle Export",
      `Session bundle exported to ${exportPath}.`,
      "teal",
    );
  } else {
    setTransientStatus(`bundle exported to ${exportPath}`);
    scheduleRender();
  }
  return exportPath;
}

function showInsights() {
  const report = buildWatchInsightsReport({
    projectRoot,
    watchState,
    surfaceSummary: currentSurfaceSummary(),
  });
  setTransientStatus("insights ready");
  pushEvent("operator", "Watch Insights", report, "slate");
  return report;
}

function showAgents({
  query = null,
} = {}) {
  const normalizedQuery = String(query ?? "").trim();
  const includeCompleted = /^(all|recent)$/i.test(normalizedQuery);
  const filteredQuery =
    /^(all|recent|active)$/i.test(normalizedQuery) ? null : normalizedQuery || null;
  const focus = currentActiveAgentFocus();
  const report = buildWatchAgentsReport({
    planSteps: includeCompleted
      ? [...subagentPlanSteps.values()]
      : activeAgentEntries(24),
    plannerStatus: watchState.plannerDagStatus,
    plannerNote: watchState.plannerDagNote,
    activeAgentLabel: focus.label,
    activeAgentActivity: focus.activity,
    query: filteredQuery,
    includeCompleted,
    limit: 12,
  });
  setTransientStatus(
    includeCompleted
      ? "agent threads listed"
      : "active agents listed",
  );
  pushEvent(
    "subagent",
    includeCompleted ? "Agent Threads" : "Active Agents",
    report,
    "slate",
  );
  return report;
}

function copyCurrentView() {
  watchFrameController?.copyCurrentView();
}

function scrollCurrentViewBy(delta) {
  watchFrameController?.scrollCurrentViewBy(delta);
}

function leaveAltScreen() {
  watchFrameController?.leaveAltScreen();
}

function promptLabel() {
  const slashMode = isSlashComposerInput(currentInputValue());
  const promptTone = slashMode ? color.teal : color.magenta;
  return `${promptTone}${color.bold}>${color.reset} `;
}

function render() {
  watchFrameController?.render();
}

function scheduleRender() {
  watchFrameController?.scheduleRender();
}

function scheduleReconnect() {
  return watchTransportController.scheduleReconnect();
}

function handleToolResult(toolName, isError, result, toolArgs) {
  const lastEvent = events[events.length - 1];
  const args = toolArgs ?? (lastEvent?.toolName === toolName ? lastEvent.toolArgs : undefined);
  const descriptor = describeToolResult(
    toolName,
    args,
    isError,
    result,
  );
  if (!shouldSuppressToolActivity(toolName, args, { isError })) {
    watchState.latestTool = toolName;
    watchState.latestToolState = isError ? "error" : "ok";
    setTransientStatus(isError ? `${descriptor.title}` : descriptor.title);
  }
  if (replaceLatestToolEvent(toolName, isError, descriptor.body, descriptor)) {
    return;
  }
  if (shouldSuppressToolTranscript(toolName, args, { isError })) {
    return;
  }
  pushEvent(
    isError ? "tool error" : "tool result",
    descriptor.title,
    descriptor.body,
    descriptor.tone,
    descriptorEventMetadata(descriptor, {
      toolName,
      toolArgs: args,
    }),
  );
}

function resetDelegationState() {
  return watchSubagentController.resetDelegationState();
}

function handleSubagentLifecycleMessage(type, payload) {
  return watchSubagentController.handleSubagentLifecycleMessage(type, payload);
}

function handlePlannerTraceEvent(type, payload) {
  return watchPlannerController.handlePlannerTraceEvent(type, payload);
}

function send(type, payload) {
  return watchTransportController.send(type, payload);
}

function requireSession(command) {
  if (!watchState.sessionId) {
    pushEvent("error", "Session Error", `${command} requires an active session`, "red");
    return false;
  }
  return true;
}

const {
  backgroundToolSurfaceLabel,
  compactPathForDisplay,
  describeToolResult,
  describeToolStart,
  formatShellCommand,
  shouldSuppressToolActivity,
  shouldSuppressToolTranscript,
} = createWatchToolPresentation({
  sanitizeInlineText,
  sanitizeLargeText,
  sanitizeDisplayText,
  truncate,
  stable,
  tryParseJson,
  tryPrettyJson,
  parseStructuredJson,
  buildToolSummary,
  maxEventBodyLines,
});

watchPlannerController = createWatchPlannerController({
  watchState,
  plannerDagNodeCount: () => plannerDagNodes.size,
  sessionValuesMatch,
  hydratePlannerDagForLiveSession,
  ingestPlannerDag,
  updatePlannerDagNode,
  retirePlannerDagOpenNodes,
  sanitizeInlineText,
  describeToolStart,
  describeToolResult,
  nowMs,
});

watchSubagentController = createWatchSubagentController({
  watchState,
  recentSubagentLifecycleFingerprints,
  subagentLiveActivity,
  resetDelegatedWatchState,
  plannerDagNodeCount: () => plannerDagNodes.size,
  hydratePlannerDagForLiveSession,
  updateSubagentPlanStep,
  ensureSubagentPlanStep,
  planStepDisplayName,
  compactSessionToken,
  sanitizeInlineText,
  truncate,
  pushEvent,
  setTransientStatus,
  requestRunInspect,
  describeToolStart,
  describeToolResult,
  descriptorEventMetadata,
  shouldSuppressToolTranscript,
  shouldSuppressToolActivity,
  rememberSubagentToolArgs,
  readSubagentToolArgs: (state, subagentSessionId, toolName) =>
    readSubagentToolArgs(state, subagentSessionId, toolName),
  clearSubagentToolArgs,
  replaceLatestSubagentToolEvent,
  clearSubagentHeartbeatEvents,
  compactPathForDisplay,
  formatShellCommand,
  currentDisplayObjective,
  backgroundToolSurfaceLabel,
  retirePlannerDagOpenNodes,
  firstMeaningfulLine,
  tryPrettyJson,
  nowMs,
});

watchTransportController = createWatchTransportController({
  transportState,
  watchState,
  pendingFrames,
  liveEventFilters: LIVE_EVENT_FILTERS,
  connectedStatusText: `connected to ${wsUrl}`,
  reconnectMinDelayMs,
  reconnectMaxDelayMs,
  statusPollIntervalMs,
  activityPulseIntervalMs,
  createSocket: () => new WebSocket(wsUrl),
  nextFrameId: nextId,
  normalizeOperatorMessage,
  projectOperatorSurfaceEvent,
  shouldIgnoreOperatorMessage,
  dispatchOperatorSurfaceEvent: (surfaceEvent, rawMessage) => {
    const rawType = rawMessage?.type;
    // Intercept voice messages
    if (typeof rawType === "string" && rawType.startsWith("voice.")) {
      const handled = watchVoiceController.handleVoiceMessage(
        rawType,
        rawMessage?.payload ?? {},
      );
      if (handled) return;
    }
    // Intercept memory responses
    if (rawType === "memory.results") {
      const entries = Array.isArray(rawMessage?.payload) ? rawMessage.payload : [];
      if (entries.length === 0) {
        pushEvent("memory", "Memory", "No results found.", "slate");
      } else {
        const lines = entries.map((e) => {
          const ts = e.timestamp ? new Date(e.timestamp).toLocaleString() : "";
          const role = e.role === "user" ? "YOU" : "AGENT";
          const text = (e.content ?? "").slice(0, 200);
          return `${ts}  ${role}  ${text}`;
        });
        pushEvent("memory", "Memory Search", lines.join("\n"), "teal");
      }
      setTransientStatus(`memory: ${entries.length} result(s)`);
      return;
    }
    if (rawType === "memory.sessions") {
      const sessions = Array.isArray(rawMessage?.payload) ? rawMessage.payload : [];
      if (sessions.length === 0) {
        pushEvent("memory", "Memory", "No memory sessions found.", "slate");
      } else {
        const lines = sessions.map((s) => {
          const lastActive = s.lastActiveAt ? new Date(s.lastActiveAt).toLocaleString() : "never";
          return `${s.id.slice(0, 24)}\u2026  ${s.messageCount} msgs  last: ${lastActive}`;
        });
        pushEvent("memory", "Memory Sessions", lines.join("\n"), "teal");
      }
      setTransientStatus(`memory: ${sessions.length} session(s)`);
      return;
    }
    if (rawType === "skills.list") {
      const skills = Array.isArray(rawMessage?.payload) ? rawMessage.payload : [];
      watchState.skillCatalog = skills.map((skill) => ({
        name: String(skill?.name ?? "").trim(),
        description: String(skill?.description ?? "").trim(),
        enabled: skill?.enabled === true,
      }));
      pushEvent(
        "operator",
        "Skills",
        watchState.skillCatalog.length > 0
          ? watchState.skillCatalog
            .map((skill) =>
              `${skill.enabled ? "●" : "○"} ${skill.name}${skill.description ? ` — ${skill.description}` : ""}`,
            )
            .join("\n")
          : "No skills available.",
        "slate",
      );
      setTransientStatus(`skills: ${watchState.skillCatalog.length}`);
      return;
    }
    dispatchOperatorSurfaceEvent(surfaceEvent, rawMessage, surfaceDispatchApi);
  },
  scheduleRender,
  setTransientStatus,
  pushEvent,
  authPayload,
  hasActiveSurfaceRun,
  shuttingDown: () => shuttingDown,
  flushQueuedOperatorInputs: () => {
    watchCommandController?.flushQueuedOperatorInputs();
  },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
});

({ api: surfaceDispatchApi } = createWatchSurfaceDispatchBridge({
  stateBindings: createWatchStateBindings({
    state: watchState,
    bindState: bindWatchSurfaceState,
  }),
  helpers: {
    now: () => nowMs(),
    setTransientStatus,
    persistSessionId,
    persistOwnerToken,
    resetLiveRunSurface,
    markBootstrapReady,
    clearBootstrapTimer,
    send,
    authPayload,
    requestRunInspect,
    eventStore,
    formatSessionSummaries: (payload) =>
      formatSessionSummaries(payload, {
        sessionLabels: watchState.sessionLabels,
        activeSessionId: watchState.sessionId,
      }),
    sessionQueryCandidates,
    latestSessionSummary: (payload, preferredSessionId = null) =>
      latestSessionSummary(payload, preferredSessionId, projectRoot),
    formatHistoryPayload,
    shouldAutoInspectRun,
    sanitizeInlineText,
    truncate,
    summarizeUsage,
    normalizeModelRoute,
    describeToolStart,
    descriptorEventMetadata,
    shouldSuppressToolTranscript,
    shouldSuppressToolActivity,
    handleToolResult,
    tryPrettyJson,
    formatLogPayload,
    formatStatusPayload,
    statusFeedFingerprint,
    handlePlannerTraceEvent,
    handleSubagentLifecycleMessage,
    hydratePlannerDagFromTraceArtifacts,
    isExpectedMissingRunInspect,
    isUnavailableBackgroundRunInspect,
    isRetryableBootstrapError,
    scheduleBootstrap,
  },
}));

function attachSocket(socket) {
  return watchTransportController.attachSocket(socket);
}

function connect() {
  return watchTransportController.connect();
}

function printHelp() {
  return watchCommandController.printHelp();
}

function shouldQueueOperatorInput(value) {
  return watchCommandController.shouldQueueOperatorInput(value);
}

function dispatchOperatorInput(value, { replayed = false } = {}) {
  return watchCommandController.dispatchOperatorInput(value, { replayed });
}

watchFrameController = createWatchFrameController({
  fs,
  watchState,
  transportState,
  events,
  queuedOperatorInputs,
  subagentPlanSteps,
  subagentLiveActivity,
  plannerDagNodes,
  plannerDagEdges,
  workspaceFileIndex,
  watchFeatureFlags,
  color,
  enableMouseTracking,
  launchedAtMs,
  startupSplashMinMs,
  introDismissKinds,
  maxInlineChars,
  maxPreviewSourceLines,
  currentSurfaceSummary,
  currentInputValue,
  currentSlashSuggestions,
  currentModelSuggestions,
  currentFileTagPalette,
  currentSessionElapsedLabel,
  currentRunElapsedLabel,
  currentDisplayObjective,
  currentPhaseLabel,
  currentSurfaceToolLabel,
  hasActiveSurfaceRun,
  bootstrapPending,
  shouldShowWatchSplash,
  buildWatchLayout,
  buildWatchFooterSummary,
  buildWatchSidebarPolicy,
  buildTranscriptEventSummary,
  buildDetailPaneSummary,
  buildCommandPaletteSummary,
  buildFileTagPaletteSummary,
  computeTranscriptPreviewMaxLines,
  splitTranscriptPreviewForHeadline,
  currentInputPreferences,
  buildEventDisplayLines,
  wrapEventDisplayLines,
  wrapDisplayLines,
  compactBodyLines,
  createDisplayLine,
  displayLineText,
  displayLinePlainText,
  renderEventBodyLine,
  isDiffRenderableEvent,
  isSourcePreviewEvent,
  isMarkdownRenderableEvent,
  isMutationPreviewEvent,
  isSlashComposerInput,
  composerRenderLine,
  fitAnsi,
  truncate,
  sanitizeInlineText,
  sanitizeDisplayText,
  toneColor,
  stateTone,
  badge,
  chip,
  row,
  renderPanel,
  wrapAndLimit,
  joinColumns,
  blankRow,
  paintSurface,
  flexBetween,
  termWidth,
  termHeight,
  formatClockLabel,
  animatedWorkingGlyph,
  compactSessionToken,
  sanitizePlanLabel,
  plannerDagStatusTone,
  plannerDagStatusGlyph,
  plannerDagTypeGlyph,
  planStatusTone,
  planStatusGlyph,
  planStepDisplayName,
  applyViewportScrollDelta,
  preserveManualTranscriptViewport,
  sliceViewportRowsAroundRange,
  sliceViewportRowsFromBottom,
  bottomAlignViewportRows,
  isViewportTranscriptFollowing,
  setTransientStatus,
  pushEvent,
  buildAltScreenEnterSequence,
  buildAltScreenLeaveSequence,
  stdout: process.stdout,
  nowMs,
  setTimer: setTimeout,
});

watchInputController = createWatchInputController({
  watchState,
  currentInputPreferences,
  shuttingDown: () => shuttingDown,
  parseMouseWheelSequence,
  scrollCurrentViewBy,
  shutdownWatch,
  toggleExpandedEvent,
  currentDiffNavigationState: () => watchFrameController?.currentDiffNavigationState() ?? { enabled: false },
  jumpCurrentDiffHunk: (direction) => watchFrameController?.jumpCurrentDiffHunk(direction) ?? false,
  copyCurrentView,
  clearLiveTranscriptView,
  deleteComposerTail,
  deleteComposerBackward: deleteComposerCharacterBackward,
  deleteComposerForward: deleteComposerCharacterForward,
  autocompleteComposerInput,
  navigateComposer,
  moveComposerCursorByCharacter: moveComposerCursorHorizontally,
  moveComposerCursorByWord: moveComposerCursor,
  insertComposerTextValue,
  dismissIntro,
  resetComposer,
  recordComposerHistory,
  operatorInputBatcher,
  setTransientStatus,
  cancelActiveChat: () => {
    if (!hasActiveSurfaceRun() && !findLatestPendingAgentEvent(events)) {
      setTransientStatus("nothing to cancel");
      return false;
    }
    send("chat.cancel", authPayload());
    setTransientStatus("cancelled");
    return true;
  },
  scheduleRender,
});

function handleTerminalEscapeSequence(input, index) {
  return watchInputController.handleTerminalEscapeSequence(input, index);
}

function handleTerminalInput(input) {
  return watchInputController.handleTerminalInput(input);
}

function buildVisibleFrameSnapshot({ width, height } = {}) {
  return watchFrameController?.buildVisibleFrameSnapshot({ width, height }) ?? {
    lines: [],
    width: Number(width) || 0,
    height: Number(height) || 0,
    composer: { line: "", cursorColumn: 1 },
    diffNavigation: null,
  };
}

function captureReplayCheckpoint(label, { width, height, meta = null } = {}) {
  return {
    label: sanitizeInlineText(label || "checkpoint") || "checkpoint",
    snapshot: buildVisibleFrameSnapshot({ width, height }),
    summary: currentSurfaceSummary(),
    state: {
      connectionState: transportState.connectionState,
      sessionId: normalizeSessionValue(watchState.sessionId),
      objective: currentDisplayObjective("No active objective"),
      phaseLabel: effectiveSurfacePhaseLabel(),
      runState: watchState.runState ?? null,
      runPhase: watchState.runPhase ?? null,
      latestTool: watchState.latestTool ?? null,
      latestToolState: watchState.latestToolState ?? null,
      latestAgentSummary: watchState.latestAgentSummary ?? null,
      eventCount: events.length,
      expandedEventId: watchState.expandedEventId ?? null,
    },
    meta,
  };
}

function flushReplayTimers() {
  if (typeof runtime.flushTimers !== "function") {
    return 0;
  }
  return runtime.flushTimers();
}

async function start() {
  if (started) {
    return;
  }
  started = true;
  try {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    inputListener = (chunk) => {
      const input = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
      handleTerminalInput(input);
    };
    resizeListener = () => {
      scheduleRender();
    };
    process.stdin.on("data", inputListener);
    process.stdout.on("resize", resizeListener);
    connect();
    scheduleRender();
    ensureActivityPulseTimer();
    startupTimer = setTimeout(() => {
      startupTimer = null;
      scheduleRender();
    }, startupSplashMinMs);
  } catch (error) {
    dispose(1);
    throw error;
  }
}

return {
  closed,
  start,
  dispose,
  shutdownWatch,
  buildVisibleFrameSnapshot,
  captureReplayCheckpoint,
  flushReplayTimers,
};
}

export async function runWatchApp(runtime = {}) {
  const app = await createWatchApp(runtime);
  try {
    await app.start();
    return await app.closed;
  } catch (error) {
    app.dispose(1);
    throw error;
  }
}
