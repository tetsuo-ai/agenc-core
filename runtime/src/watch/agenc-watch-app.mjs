import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createOperatorInputBatcher,
  buildWatchCommands,
  mergeWatchCommandCatalog,
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
  applyComposerFileTagSuggestion,
  applySlashCommandCompletion,
  applySlashModelCompletion,
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
  clearWatchXaiApiKey,
  listWatchUserSkills,
  readWatchXaiConfigStatus,
  readWatchRuntimeConfig,
  updateWatchXaiApiKey,
} from "./agenc-watch-extensibility.mjs";
import {
  createQueuedWatchAttachment,
  formatQueuedWatchAttachments,
  resolveQueuedWatchAttachmentPayloads,
} from "./agenc-watch-attachments.mjs";
import {
  buildWatchExportBundle,
  writeWatchExportBundle,
} from "./agenc-watch-export-bundle.mjs";
import { validateXaiApiKey } from "../onboarding/xai-validation.js";
import { createAnsiArtRenderer } from "./agenc-watch-art.mjs";
import {
  buildWatchInsightsReport,
  buildWatchMaintenanceReport,
} from "./agenc-watch-insights.mjs";
import { buildWatchUiPreferencesReport } from "./agenc-watch-ui-preferences.mjs";
import {
  buildWatchSessionQueryCandidates,
  clearWatchSessionLabel,
  resolveWatchSessionLabel,
  setWatchSessionLabel,
} from "./agenc-watch-session-indexing.mjs";
import {
  formatMarketTaskBrowserTimestamp,
  marketBrowserKind,
  marketTaskBrowserDefaultTitle,
  marketTaskBrowserItemKey,
  marketTaskBrowserItemLabel,
  marketTaskBrowserNoun,
  marketTaskBrowserUsesStatuses,
  normalizeMarketTaskBrowserItems,
} from "../marketplace/surfaces.mjs";

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
  markerChip,
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
  cockpitFeedFingerprint,
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

export function resolveWatchMouseTrackingEnabled(env = globalThis.process?.env ?? {}) {
  // Mouse tracking defaults to ON so the wheel scrolls the in-app
  // transcript via the SGR mouse handler in agenc-watch-input.mjs (the
  // `scrollCurrentViewBy(mouseWheel.delta)` path). Without it, wheel
  // events fall through to the terminal and scroll the alt-screen
  // viewport up — revealing the empty area above the header, which is
  // never what the user wants.
  //
  // Users who prefer terminal-native click-to-select can opt out with
  // AGENC_WATCH_ENABLE_MOUSE=0 (or false / no / off). On macOS, holding
  // Option while clicking also bypasses mouse tracking for text selection.
  const rawValue = String(env.AGENC_WATCH_ENABLE_MOUSE ?? "").trim().toLowerCase();
  if (/^(0|false|no|off)$/.test(rawValue)) return false;
  return true;
}

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
const enableMouseTracking = resolveWatchMouseTrackingEnabled(process.env);
const watchFeatureFlags = resolveWatchFeatureFlags({ env: process.env });
const baseWatchCommands = buildWatchCommands({ featureFlags: watchFeatureFlags });
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
let artRenderer = null;
let artRendererImagePath = null;
let artRefreshPending = false;
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

function queuePendingAttachment(inputPath) {
  const attachment = createQueuedWatchAttachment({
    fs,
    pathModule: path,
    inputPath,
    projectRoot,
    id: nextAttachmentId(),
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

function currentSecretPrompt() {
  return watchState.secretPrompt && typeof watchState.secretPrompt === "object"
    ? watchState.secretPrompt
    : null;
}

function formatXaiModelList(models = []) {
  if (!Array.isArray(models) || models.length === 0) {
    return "none reported";
  }
  const visibleModels = models.slice(0, 5);
  return visibleModels.length === models.length
    ? visibleModels.join(", ")
    : `${visibleModels.join(", ")} (+${models.length - visibleModels.length} more)`;
}

function showXaiStatus() {
  const status = readWatchXaiConfigStatus({
    fs,
    env: process.env,
    osModule: os,
    pathModule: path,
  });
  const daemonSummary =
    status.daemonState === "running"
      ? `running (pid ${status.daemonPid})`
      : status.daemonState === "stale"
        ? `not running (stale pid ${status.daemonPid ?? "unknown"} ignored)`
        : "not detected";
  const body = [
    `Config: ${status.configPath}`,
    `Config source: ${status.source}`,
    `Daemon: ${daemonSummary}`,
    `Provider: ${status.provider ?? "unset"}`,
    `Base URL: ${status.baseUrl}`,
    `Model: ${status.model ?? "unset"}`,
    `API key: ${status.hasApiKey ? `configured (${status.maskedApiKey})` : "not configured"}`,
    ...(status.error ? [`Config load: ${status.error}`] : []),
  ].join("\n");
  setTransientStatus(status.hasApiKey ? "xai credentials configured" : "xai credentials missing");
  pushEvent("operator", "xAI Credentials", body, "slate");
  return status;
}

async function validateAndPersistXaiApiKey(apiKey, {
  existingBaseUrl = null,
  completionLabel = "xAI Credentials Updated",
} = {}) {
  const trimmedApiKey = String(apiKey ?? "").trim();
  if (!trimmedApiKey) {
    setTransientStatus("xai api key required");
    pushEvent("error", "xAI Validation Failed", "xAI API key cannot be empty.", "red");
    return false;
  }

  const { configSnapshot } = readExtensibilityContext();
  const llmConfig =
    configSnapshot.config?.llm && typeof configSnapshot.config.llm === "object"
      ? configSnapshot.config.llm
      : {};
  const baseUrl = String(existingBaseUrl ?? llmConfig.baseUrl ?? "").trim() || "https://api.x.ai/v1";

  setTransientStatus("validating xai key");
  const validation = await validateXaiApiKey({
    apiKey: trimmedApiKey,
    baseUrl,
  });
  if (!validation.ok) {
    setTransientStatus("xai validation failed");
    pushEvent("error", "xAI Validation Failed", validation.message, "red");
    return false;
  }

  const result = updateWatchXaiApiKey({
    fs,
    configPath: configSnapshot.configPath,
    apiKey: trimmedApiKey,
    provider: "grok",
    baseUrl,
  });
  setTransientStatus("xai key saved");
  pushEvent(
    "operator",
    completionLabel,
    [
      `Config: ${result.configPath}`,
      `Provider: ${result.provider}`,
      `Base URL: ${result.baseUrl}`,
      `API key: ${result.maskedApiKey}`,
      `Available models: ${formatXaiModelList(validation.availableModels)}`,
      "Config watcher should pick up the change automatically if the daemon is live.",
    ].join("\n"),
    "teal",
  );
  return true;
}

async function validateConfiguredXaiKey() {
  const { configSnapshot } = readExtensibilityContext();
  const llmConfig =
    configSnapshot.config?.llm && typeof configSnapshot.config.llm === "object"
      ? configSnapshot.config.llm
      : {};
  const apiKey = String(llmConfig.apiKey ?? "").trim();
  if (!apiKey) {
    setTransientStatus("xai api key missing");
    pushEvent(
      "error",
      "xAI Validation Failed",
      "No local xAI API key is configured. Use /xai set first.",
      "red",
    );
    return false;
  }
  return validateAndPersistXaiApiKey(apiKey, {
    existingBaseUrl: llmConfig.baseUrl,
    completionLabel: "xAI Credentials Validated",
  });
}

function clearXaiApiKey() {
  const status = readWatchXaiConfigStatus({
    fs,
    env: process.env,
    osModule: os,
    pathModule: path,
  });
  if (!status.hasApiKey) {
    setTransientStatus("xai api key not configured");
    pushEvent(
      "operator",
      "xAI Credentials",
      "No local xAI API key is configured.",
      "slate",
    );
    return null;
  }
  const result = clearWatchXaiApiKey({
    fs,
    configPath: status.configPath,
  });
  setTransientStatus("xai key cleared");
  pushEvent(
    "operator",
    "xAI Credentials Cleared",
    [
      `Config: ${result.configPath}`,
      `Provider: ${result.provider ?? "unset"}`,
      `Base URL: ${result.baseUrl}`,
      `Removed key: ${result.maskedApiKey}`,
      "Config watcher should pick up the change automatically if the daemon is live.",
    ].join("\n"),
    "amber",
  );
  return result;
}

function promptForXaiApiKey() {
  watchState.secretPrompt = {
    kind: "xai-api-key",
    label: "xai key",
    value: "",
    pending: false,
    onSubmit: async (rawValue) => {
      const prompt = currentSecretPrompt();
      if (!prompt || prompt.kind !== "xai-api-key" || prompt.pending) {
        return false;
      }
      prompt.pending = true;
      scheduleRender();
      const saved = await validateAndPersistXaiApiKey(rawValue);
      const nextPrompt = currentSecretPrompt();
      if (!saved) {
        if (nextPrompt && nextPrompt.kind === "xai-api-key") {
          nextPrompt.pending = false;
          nextPrompt.value = "";
        }
        scheduleRender();
        return false;
      }
      watchState.secretPrompt = null;
      scheduleRender();
      return true;
    },
    onCancel: () => {
      watchState.secretPrompt = null;
      setTransientStatus("xai prompt cancelled");
      scheduleRender();
    },
  };
  setTransientStatus("enter xai api key");
  pushEvent(
    "operator",
    "xAI Credentials",
    [
      "Enter your xAI API key in the masked prompt below.",
      "The key stays local to this machine until validation succeeds and the runtime config is updated.",
    ].join("\n\n"),
    "teal",
  );
  scheduleRender();
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
  workspaceIndex: workspaceFileIndex,
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

function renderEventBodyLine(event, line, options = {}) {
  const { inline = false, ...rest } = options;
  return _renderEventBodyLine(event, line, {
    inline,
    ...rest,
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
  if (currentSecretPrompt()) {
    return "";
  }
  return currentComposerInput(watchState);
}

function currentWatchCommands() {
  return mergeWatchCommandCatalog(
    baseWatchCommands,
    Array.isArray(watchState.sharedCommandCatalog) ? watchState.sharedCommandCatalog : [],
  );
}

function currentSlashSuggestions(limit = 8) {
  return matchWatchCommands(currentInputValue(), { limit, commands: currentWatchCommands() });
}

function currentModelSuggestions(limit = 6) {
  const input = currentInputValue().trimStart();
  const match = input.match(/^\/models?\s+(.*)/i);
  if (!match) return [];
  return matchModelNames(match[1].trim(), { limit });
}

function inferModelProvider(modelName) {
  const normalized = String(modelName ?? "").trim().toLowerCase();
  if (!normalized) {
    return effectiveModelRoute()?.provider ?? "unknown";
  }
  if (normalized.startsWith("grok")) return "grok";
  if (
    normalized.startsWith("gpt") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4")
  ) {
    return "openai";
  }
  if (normalized.startsWith("claude")) return "anthropic";
  if (normalized.startsWith("gemini")) return "google";
  if (normalized.startsWith("llama")) return "meta";
  return effectiveModelRoute()?.provider ?? "unknown";
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

const MAX_COMPOSER_PALETTE_ENTRIES = 64;

function resetComposerPaletteSelection() {
  watchState.composerPaletteIndex = 0;
}

function normalizeComposerPaletteIndex(entryCount) {
  if (!Number.isInteger(entryCount) || entryCount <= 0) {
    watchState.composerPaletteIndex = 0;
    return -1;
  }
  const nextIndex = Number.isInteger(watchState.composerPaletteIndex)
    ? watchState.composerPaletteIndex
    : 0;
  const clampedIndex = Math.max(0, Math.min(entryCount - 1, nextIndex));
  watchState.composerPaletteIndex = clampedIndex;
  return clampedIndex;
}

function currentComposerPalette(limit = MAX_COMPOSER_PALETTE_ENTRIES) {
  if (watchState.expandedEventId || currentSecretPrompt()) {
    resetComposerPaletteSelection();
    return { mode: "none", entries: [], activeIndex: -1, summary: null };
  }

  const fileTagPalette = currentFileTagPalette(limit);
  if (fileTagPalette.activeTag) {
    const entries = fileTagPalette.suggestions.map((entry) => ({
      kind: "file",
      path: entry.path,
      label: entry.label,
      detail: entry.directory,
      raw: entry,
    }));
    return {
      mode: "file",
      entries,
      activeIndex: normalizeComposerPaletteIndex(entries.length),
      summary: fileTagPalette.summary,
    };
  }

  const input = currentInputValue();
  if (!isSlashComposerInput(input)) {
    resetComposerPaletteSelection();
    return { mode: "none", entries: [], activeIndex: -1, summary: null };
  }

  const modelSuggestions = currentModelSuggestions(limit);
  if (input.trimStart().match(/^\/models?\s+/i)) {
    const entries = modelSuggestions.map((model) => ({
      kind: "model",
      label: model,
      value: model,
    }));
    return {
      mode: "model",
      entries,
      activeIndex: normalizeComposerPaletteIndex(entries.length),
      summary: {
        title: "Models",
        empty: entries.length === 0,
      },
    };
  }

  const suggestions = currentSlashSuggestions(limit);
  const entries = suggestions.map((command) => ({
    kind: "command",
    label: command.usage,
    detail: command.description,
    value: command.name,
    raw: command,
  }));
  return {
    mode: "command",
    entries,
    activeIndex: normalizeComposerPaletteIndex(entries.length),
    summary: buildCommandPaletteSummary({
      inputValue: input,
      suggestions,
      modelSuggestions: [],
    }),
  };
}

function hasActiveComposerPalette() {
  return currentComposerPalette().mode !== "none";
}

function navigateComposerPalette(direction) {
  const palette = currentComposerPalette();
  if (palette.entries.length === 0) {
    return false;
  }
  const delta = direction < 0 ? -1 : 1;
  const nextIndex = Math.max(
    0,
    Math.min(palette.entries.length - 1, palette.activeIndex + delta),
  );
  if (nextIndex === palette.activeIndex) {
    return false;
  }
  watchState.composerPaletteIndex = nextIndex;
  return true;
}

function resetComposer() {
  resetComposerState(watchState);
  resetComposerPaletteSelection();
}

function insertComposerTextValue(text, options) {
  insertComposerText(watchState, text, options);
  resetComposerPaletteSelection();
}

function moveComposerCursor(direction) {
  moveComposerCursorByWord(watchState, direction);
}

function moveComposerCursorHorizontally(direction) {
  moveComposerCursorByCharacter(watchState, direction);
}

function deleteComposerCharacterBackward() {
  const deleted = deleteComposerBackward(watchState);
  if (deleted) {
    resetComposerPaletteSelection();
  }
  return deleted;
}

function deleteComposerCharacterForward() {
  const deleted = deleteComposerForward(watchState);
  if (deleted) {
    resetComposerPaletteSelection();
  }
  return deleted;
}

function deleteComposerTail() {
  const previousInput = watchState.composerInput;
  deleteComposerToLineEnd(watchState);
  if (watchState.composerInput !== previousInput) {
    resetComposerPaletteSelection();
  }
}

function navigateComposer(direction) {
  navigateComposerHistory(watchState, direction);
  resetComposerPaletteSelection();
}

function autocompleteComposerInput() {
  const palette = currentComposerPalette();
  const selectedEntry =
    palette.activeIndex >= 0
      ? palette.entries[palette.activeIndex] ?? palette.entries[0]
      : palette.entries[0];
  if (selectedEntry) {
    const applied = palette.mode === "file"
      ? applyComposerFileTagSuggestion(watchState, selectedEntry.raw)
      : palette.mode === "model"
        ? applySlashModelCompletion(watchState, selectedEntry.value)
        : applySlashCommandCompletion(watchState, selectedEntry.value);
    if (applied) {
      resetComposerPaletteSelection();
      return true;
    }
  }
  if (autocompleteComposerFileTag(watchState, workspaceFileIndex, { limit: 8 })) {
    resetComposerPaletteSelection();
    return true;
  }
  const completed = autocompleteSlashComposerInput(
    watchState,
    (input, options = {}) => matchWatchCommands(input, {
      ...options,
      commands: currentWatchCommands(),
    }),
  );
  if (completed) {
    resetComposerPaletteSelection();
  }
  return completed;
}

function acceptComposerPaletteSelection() {
  const palette = currentComposerPalette();
  if (palette.mode === "none" || palette.entries.length === 0) {
    return false;
  }
  const selectedEntry =
    palette.activeIndex >= 0
      ? palette.entries[palette.activeIndex] ?? palette.entries[0]
      : palette.entries[0];
  if (!selectedEntry) {
    return false;
  }
  const applied = palette.mode === "file"
    ? applyComposerFileTagSuggestion(watchState, selectedEntry.raw)
    : palette.mode === "model"
      ? applySlashModelCompletion(watchState, selectedEntry.value)
      : applySlashCommandCompletion(watchState, selectedEntry.value);
  if (applied) {
    resetComposerPaletteSelection();
  }
  return applied;
}

function applyOptimisticModelSelection(modelName) {
  const normalizedModel = String(modelName ?? "").trim();
  if (!normalizedModel || /^(current|list)$/i.test(normalizedModel)) {
    return false;
  }
  watchState.configuredModelRoute = normalizeModelRoute({
    provider: inferModelProvider(normalizedModel),
    model: normalizedModel,
    source: "local",
    updatedAt: nowMs(),
  });
  scheduleRender();
  return true;
}

function composerRenderLine(width) {
  const secretPrompt = currentSecretPrompt();
  if (secretPrompt) {
    const maskedValue = "*".repeat(String(secretPrompt.value ?? "").length);
    return buildComposerRenderLine({
      input: maskedValue,
      cursor: maskedValue.length,
      prompt: `${color.softInk}${secretPrompt.pending ? "xai key (validating)" : secretPrompt.label}>${color.reset} `,
      width,
      visibleLength,
      pastedRanges: [],
    });
  }
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

function requestCockpit(reason = "refresh") {
  return watchTransportController.requestCockpit(reason);
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
  getWatchCommands: currentWatchCommands,
  parseWatchSlashCommand: (input) =>
    parseWatchSlashCommand(input, { commands: currentWatchCommands() }),
  authPayload,
  send,
  shutdownWatch,
  dismissIntro,
  clearLiveTranscriptView,
  exportCurrentView,
  exportBundle,
  showInsights,
  showMaintenance,
  showExtensibility,
  showInputModes,
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
  showXaiStatus,
  validateConfiguredXaiKey,
  clearXaiApiKey,
  promptForXaiApiKey,
  captureCheckpoint,
  listCheckpoints,
  listPendingAttachments: currentPendingAttachments,
  formatPendingAttachments,
  queuePendingAttachment,
  removePendingAttachment,
  clearPendingAttachments,
  prepareChatMessagePayload,
  applyOptimisticModelSelection,
  openMarketTaskBrowser,
  dismissMarketTaskBrowser,
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
  watchState.agentStreamingText = null;
  watchState.agentStreamingPreview = null;
  // Intentionally preserve `latestTool`, `latestToolState`, and
  // `lastUsageSummary` across run boundaries. The server only emits
  // `chat.usage` at completion, and tool events fire mid-stream — wiping
  // these on every reset (chat.session, chat.resumed, /new) was the reason
  // the header showed "—" while the agent was thinking and only snapped to
  // real values at the end of an operation. Letting the previous values
  // ride forward gives the user persistent context until fresh data arrives.
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

function currentMarketTaskBrowser() {

  const browser = watchState.marketTaskBrowser;
  return browser && typeof browser === "object" && browser.open === true
    ? browser
    : null;
}

function hasActiveMarketTaskBrowser({ requireBlankComposer = false } = {}) {
  const browser = currentMarketTaskBrowser();
  if (!browser) {
    return false;
  }
  if (!requireBlankComposer) {
    return true;
  }
  return String(watchState.composerInput ?? "").trim().length === 0;
}

function openMarketTaskBrowser({
  title = "Marketplace Tasks",
  statuses = [],
  kind = "tasks",
  query = "",
  activeOnly = true,
} = {}) {
  const browserKind = marketBrowserKind(kind);
  const current = currentMarketTaskBrowser();
  const currentKind = marketBrowserKind(current);
  const normalizedStatuses = marketTaskBrowserUsesStatuses(browserKind) && Array.isArray(statuses)
    ? statuses.map((value) => String(value ?? "").trim()).filter(Boolean)
    : [];
  const normalizedQuery = browserKind === "skills"
    ? String(query ?? "").trim()
    : "";
  const defaultTitle = marketTaskBrowserDefaultTitle(browserKind);
  watchState.expandedEventId = null;
  watchState.detailScrollOffset = 0;
  watchState.marketTaskBrowser = {
    open: true,
    kind: browserKind,
    title: String(title ?? defaultTitle).trim() || defaultTitle,
    statuses: marketTaskBrowserUsesStatuses(browserKind)
      ? normalizedStatuses
      : [],
    query: browserKind === "skills" ? normalizedQuery : "",
    activeOnly: browserKind === "skills" ? activeOnly !== false : true,
    loading: true,
    items:
      browserKind === currentKind && Array.isArray(current?.items)
        ? current.items
        : [],
    selectedIndex:
      browserKind === currentKind && Number.isFinite(Number(current?.selectedIndex))
        ? Number(current.selectedIndex)
        : 0,
    expandedTaskKey:
      browserKind === currentKind ? current?.expandedTaskKey ?? null : null,
    updatedAtMs: nowMs(),
  };
  return watchState.marketTaskBrowser;
}

function hydrateMarketTaskBrowser({ title = "Marketplace Tasks", items = [], kind = "tasks" } = {}) {
  const browserKind = marketBrowserKind(kind);
  const normalizedItems = normalizeMarketTaskBrowserItems(items, browserKind);
  const current = currentMarketTaskBrowser();
  const currentKind = marketBrowserKind(current);
  const currentSelectedKey =
    current && browserKind === currentKind && Array.isArray(current.items) && current.items.length > 0
      ? current.items[Math.max(0, Math.min(current.items.length - 1, Number(current.selectedIndex) || 0))]?.key ?? null
      : null;
  let selectedIndex = normalizedItems.findIndex((item) => item.key === currentSelectedKey);
  if (selectedIndex < 0) {
    selectedIndex = Math.max(
      0,
      Math.min(
        normalizedItems.length - 1,
        browserKind === currentKind ? Number(current?.selectedIndex) || 0 : 0,
      ),
    );
  }
  const expandedTaskKey =
    current?.expandedTaskKey && browserKind === currentKind && normalizedItems.some((item) => item.key === current.expandedTaskKey)
      ? current.expandedTaskKey
      : null;
  const defaultTitle = marketTaskBrowserDefaultTitle(browserKind);
  watchState.expandedEventId = null;
  watchState.detailScrollOffset = 0;
  watchState.marketTaskBrowser = {
    open: true,
    kind: browserKind,
    title: String(title ?? current?.title ?? defaultTitle).trim() || defaultTitle,
    statuses: marketTaskBrowserUsesStatuses(browserKind) && browserKind === currentKind && Array.isArray(current?.statuses)
      ? current.statuses
      : [],
    query: browserKind === "skills" && browserKind === currentKind
      ? String(current?.query ?? "").trim()
      : "",
    activeOnly: browserKind === "skills" && browserKind === currentKind
      ? current?.activeOnly !== false
      : true,
    loading: false,
    items: normalizedItems,
    selectedIndex: normalizedItems.length > 0 ? selectedIndex : 0,
    expandedTaskKey,
    updatedAtMs: nowMs(),
  };
  return watchState.marketTaskBrowser;
}

function navigateMarketTaskBrowser(direction) {

  const browser = currentMarketTaskBrowser();
  if (!browser || !Array.isArray(browser.items) || browser.items.length === 0) {
    return false;
  }
  const delta = direction < 0 ? -1 : 1;
  const nextIndex = Math.max(0, Math.min(browser.items.length - 1, browser.selectedIndex + delta));
  if (nextIndex === browser.selectedIndex) {
    return false;
  }
  browser.selectedIndex = nextIndex;
  if (browser.expandedTaskKey) {
    browser.expandedTaskKey = browser.items[nextIndex]?.key ?? null;
  }
  return true;
}

function toggleMarketTaskBrowserExpansion() {
  const browser = currentMarketTaskBrowser();
  const browserKind = marketBrowserKind(browser);
  const noun = marketTaskBrowserNoun(browserKind);
  if (!browser || !Array.isArray(browser.items) || browser.items.length === 0) {
    setTransientStatus(`no marketplace ${noun} selected`);
    return false;
  }
  const item = browser.items[Math.max(0, Math.min(browser.items.length - 1, browser.selectedIndex))];
  if (!item) {
    setTransientStatus(`no marketplace ${noun} selected`);
    return false;
  }
  const label = String(marketTaskBrowserItemLabel(item, browserKind) ?? "").trim() || `selected ${noun}`;
  if (browser.expandedTaskKey === item.key) {
    browser.expandedTaskKey = null;
    setTransientStatus(`${noun} details collapsed`);
    return true;
  }
  browser.expandedTaskKey = item.key;
  setTransientStatus(`${noun} details open: ${label}`);
  return true;
}

function dismissMarketTaskBrowser() {
  const browser = currentMarketTaskBrowser();
  if (!browser) {
    return false;
  }
  const browserKind = marketBrowserKind(browser);
  const noun = marketTaskBrowserNoun(browserKind);
  if (browser.expandedTaskKey) {
    browser.expandedTaskKey = null;
    setTransientStatus(`${noun} details collapsed`);
    return true;
  }
  watchState.marketTaskBrowser = null;
  setTransientStatus(`market ${noun} browser closed`);
  return true;
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
    maintenanceStatus: watchState.maintenanceSnapshot ?? null,
    workspaceIndex: workspaceFileIndex,
  });
  setTransientStatus("insights ready");
  pushEvent("operator", "Watch Insights", report, "slate");
  return report;
}

function showMaintenance() {
  const report = buildWatchMaintenanceReport({
    projectRoot,
    watchState,
    surfaceSummary: currentSurfaceSummary(),
    maintenanceStatus: watchState.maintenanceSnapshot ?? null,
    workspaceIndex: workspaceFileIndex,
  });
  setTransientStatus("maintenance ready");
  pushEvent("operator", "Maintenance Status", report, "slate");
  return report;
}

function copyCurrentView() {
  watchFrameController?.copyCurrentView();
}

function toggleTerminalSelectionMode() {
  watchFrameController?.toggleTerminalSelectionMode();
}

function isTerminalSelectionModeActive() {
  return watchFrameController?.isTerminalSelectionModeActive() ?? false;
}

function scrollCurrentViewBy(delta) {
  watchFrameController?.scrollCurrentViewBy(delta);
}

function leaveAltScreen() {
  watchFrameController?.leaveAltScreen();
}

function promptLabel() {
  return `${color.softInk}>${color.reset} `;
}

function render() {
  watchFrameController?.render();
}

function scheduleRender() {
  watchFrameController?.scheduleRender();
}

// Right-side ANSI art panel: loads the configured image once, then
// re-rasterizes on terminal resize. Mirrors the ansi_art.py output
// (standard ramp + 24-bit color) in the runtime TUI. Config lives in
// gateway `config.watch.art` and is read from the same extensibility
// surface the rest of the watch UI uses.
function readArtPanelConfig() {
  try {
    const { configSnapshot } = readExtensibilityContext();
    const cfg = configSnapshot?.config?.watch?.art;
    if (!cfg || typeof cfg !== "object") return null;
    const enabled = cfg.enabled === true;
    const imagePath =
      typeof cfg.imagePath === "string" && cfg.imagePath.length > 0
        ? cfg.imagePath
        : null;
    const widthFractionRaw = Number(cfg.widthFraction);
    const widthFraction =
      Number.isFinite(widthFractionRaw) && widthFractionRaw > 0
        ? Math.min(0.8, Math.max(0.05, widthFractionRaw))
        : 0.4;
    const ramp = typeof cfg.ramp === "string" ? cfg.ramp : "standard";
    const invert = cfg.invert === true;
    if (!enabled || !imagePath) return null;
    return { imagePath, widthFraction, ramp, invert };
  } catch {
    return null;
  }
}

async function refreshArtPanel() {
  if (artRefreshPending) return;
  artRefreshPending = true;
  try {
    const cfg = readArtPanelConfig();
    if (!cfg) {
      watchState.artPanelRows = null;
      watchState.artPanelCols = 0;
      return;
    }
    if (!artRenderer || artRendererImagePath !== cfg.imagePath) {
      artRenderer = await createAnsiArtRenderer({
        imagePath: cfg.imagePath,
        ramp: cfg.ramp,
        invert: cfg.invert,
      });
      artRendererImagePath = cfg.imagePath;
    }
    if (!artRenderer) {
      watchState.artPanelRows = null;
      watchState.artPanelCols = 0;
      return;
    }
    const width = termWidth();
    const height = termHeight();
    const artCols = Math.max(
      10,
      Math.min(
        Math.floor(width * 0.6),
        Math.floor(width * cfg.widthFraction),
      ),
    );
    if (artCols >= width) {
      watchState.artPanelRows = null;
      watchState.artPanelCols = 0;
      return;
    }
    const rows = await artRenderer.render({ cols: artCols, rows: height });
    watchState.artPanelRows = rows;
    watchState.artPanelCols = artCols;
    scheduleRender();
  } catch {
    watchState.artPanelRows = null;
    watchState.artPanelCols = 0;
  } finally {
    artRefreshPending = false;
  }
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
    "tool result",
    descriptor.title,
    descriptor.body,
    descriptor.tone,
    descriptorEventMetadata(descriptor, {
      toolName,
      toolArgs: args,
      toolState: isError ? "error" : "ok",
      isError,
    }),
  );
}

function resetDelegationState() {
  return watchSubagentController.resetDelegationState();
}

function handleSubagentLifecycleMessage(type, payload) {
  return watchSubagentController.handleSubagentLifecycleMessage(type, payload);
}

function getActiveSubagentProgress(parentToolCallId) {
  return watchSubagentController.getActiveSubagentProgress(parentToolCallId);
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
    if (
      rawType === "status.update" &&
      !watchState.maintenanceSnapshot &&
      watchState.maintenanceRequestPending !== true
    ) {
      send("maintenance.status", authPayload({ limit: 8 }));
    }
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
    if (rawType === "maintenance.status") {
      watchState.maintenanceSnapshot =
        rawMessage?.payload && typeof rawMessage.payload === "object"
          ? rawMessage.payload
          : null;
      const shouldAnnounce = watchState.maintenanceRequestPending === true;
      watchState.maintenanceRequestPending = false;
      if (shouldAnnounce) {
        showMaintenance();
      } else {
        setTransientStatus("maintenance updated");
        scheduleRender();
      }
      return;
    }
    if (rawType === "skills.list") {
      const skills = Array.isArray(rawMessage?.payload) ? rawMessage.payload : [];
      watchState.skillCatalog = skills.map((skill) => ({
        name: String(skill?.name ?? "").trim(),
        description: String(skill?.description ?? "").trim(),
        enabled: skill?.enabled === true,
        available:
          typeof skill?.available === "boolean" ? skill.available : undefined,
        tier:
          typeof skill?.tier === "string" && skill.tier.trim().length > 0
            ? skill.tier.trim()
            : undefined,
        sourcePath:
          typeof skill?.sourcePath === "string" && skill.sourcePath.trim().length > 0
            ? skill.sourcePath.trim()
            : undefined,
        tags: Array.isArray(skill?.tags)
          ? skill.tags
              .map((tag) => String(tag ?? "").trim())
              .filter(Boolean)
          : [],
        primaryEnv:
          typeof skill?.primaryEnv === "string" && skill.primaryEnv.trim().length > 0
            ? skill.primaryEnv.trim()
            : undefined,
        unavailableReason:
          typeof skill?.unavailableReason === "string" &&
          skill.unavailableReason.trim().length > 0
            ? skill.unavailableReason.trim()
            : undefined,
        missingRequirements: Array.isArray(skill?.missingRequirements)
          ? skill.missingRequirements
              .map((requirement) => String(requirement ?? "").trim())
              .filter(Boolean)
          : [],
      }));
      pushEvent(
        "operator",
        "Skills",
        watchState.skillCatalog.length > 0
          ? watchState.skillCatalog
            .map((skill) =>
              `${skill.enabled ? "●" : "○"} ${skill.name}${
                skill.available === false ? " [unavailable]" : ""
              }${
                skill.tier ? ` [${skill.tier}]` : ""
              }${skill.description ? ` — ${skill.description}` : ""}${
                skill.primaryEnv ? ` (${skill.primaryEnv})` : ""
              }${
                skill.unavailableReason
                  ? ` | ${skill.unavailableReason}`
                  : skill.missingRequirements.length > 0
                    ? ` | missing: ${skill.missingRequirements.join(", ")}`
                    : ""
              }`,
            )
            .join("\n")
          : "No skills available.",
        "slate",
      );
      setTransientStatus(`skills: ${watchState.skillCatalog.length}`);
      return;
    }
    if (rawType === "hooks.list") {
      const hooks = Array.isArray(rawMessage?.payload) ? rawMessage.payload : [];
      watchState.hookCatalog = hooks.map((hook) => ({
        event: String(hook?.event ?? "").trim(),
        name: String(hook?.name ?? "").trim(),
        priority: Number.isFinite(Number(hook?.priority)) ? Number(hook.priority) : 100,
        source: String(hook?.source ?? "runtime").trim() || "runtime",
        kind: String(hook?.kind ?? "custom").trim() || "custom",
        handlerType: String(hook?.handlerType ?? "runtime").trim() || "runtime",
        target:
          typeof hook?.target === "string" && hook.target.trim().length > 0
            ? hook.target.trim()
            : undefined,
        supported: hook?.supported !== false,
      }));
      pushEvent(
        "operator",
        "Hooks",
        watchState.hookCatalog.length > 0
          ? watchState.hookCatalog
              .map((hook) =>
                `${hook.supported ? "●" : "○"} ${hook.event} :: ${hook.name} [${
                  hook.source
                }/${hook.kind}/${hook.handlerType}] p=${hook.priority}${
                  hook.target ? ` -> ${hook.target}` : ""
                }`,
              )
              .join("\n")
          : "No hooks available.",
        "slate",
      );
      setTransientStatus(`hooks: ${watchState.hookCatalog.length}`);
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
    requestCockpit,
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
    cockpitFeedFingerprint,
    handlePlannerTraceEvent,
    handleSubagentLifecycleMessage,
    hydratePlannerDagFromTraceArtifacts,
    hydrateMarketTaskBrowser,
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
  workspaceRoot: projectRoot,
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
  markerChip,
  row,
  renderPanel,
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
  toggleTerminalSelectionMode,
  currentDiffNavigationState: () => watchFrameController?.currentDiffNavigationState() ?? { enabled: false },
  jumpCurrentDiffHunk: (direction) => watchFrameController?.jumpCurrentDiffHunk(direction) ?? false,
  copyCurrentView,
  isTerminalSelectionModeActive,
  clearLiveTranscriptView,
  deleteComposerTail,
  deleteComposerBackward: deleteComposerCharacterBackward,
  deleteComposerForward: deleteComposerCharacterForward,
  autocompleteComposerInput,
  acceptComposerPaletteSelection,
  navigateComposer,
  hasActiveMarketTaskBrowser: () => hasActiveMarketTaskBrowser({ requireBlankComposer: true }),
  navigateMarketTaskBrowser,
  toggleMarketTaskBrowserExpansion,
  dismissMarketTaskBrowser,
  hasActiveComposerPalette,
  navigateComposerPalette,
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
      void refreshArtPanel();
    };
    process.stdin.on("data", inputListener);
    process.stdout.on("resize", resizeListener);
    connect();
    scheduleRender();
    void refreshArtPanel();
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
