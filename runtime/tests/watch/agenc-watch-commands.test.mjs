import test from "node:test";
import assert from "node:assert/strict";

import { createWatchCommandController } from "../../src/watch/agenc-watch-commands.mjs";

function createCommandHarness(overrides = {}) {
  const watchState = {
    sessionId: "sess-1",
    currentObjective: null,
    runDetail: null,
    runState: "idle",
    runPhase: null,
    bootstrapAttempts: 0,
    manualSessionsRequestPending: false,
    manualHistoryRequestPending: false,
    manualStatusRequestPending: false,
    runInspectPending: false,
    transcriptScrollOffset: 7,
    transcriptFollowMode: false,
    activeRunStartedAtMs: null,
    activeCheckpointId: null,
    manualSessionsQuery: null,
    pendingAttachments: [],
    inputPreferences: {
      inputModeProfile: "default",
      keybindingProfile: "default",
      themeName: "default",
    },
    composerMode: "insert",
    sessionLabels: new Map([
      ["sess-1", "Roadmap"],
    ]),
    skillCatalog: [],
    hookCatalog: [],
    voiceCompanion: null,
    maintenanceSnapshot: null,
    maintenanceRequestPending: false,
  };
  const queuedOperatorInputs = [];
  const pendingAttachments = watchState.pendingAttachments;
  const calls = [];
  let statuslineEnabled = overrides.initialStatuslineEnabled ?? false;
  let nextEventId = 1;
  const watchCommands = overrides.WATCH_COMMANDS ?? [
    { name: "/help", usage: "/help", description: "show help", aliases: [] },
    { name: "/clear", usage: "/clear", description: "clear console", aliases: [] },
    { name: "/export", usage: "/export", description: "export view", aliases: [] },
    { name: "/bundle", usage: "/bundle", description: "bundle", aliases: ["/export-bundle"] },
    { name: "/insights", usage: "/insights", description: "insights", aliases: [] },
    { name: "/maintenance", usage: "/maintenance", description: "maintenance", aliases: [] },
    { name: "/agents", usage: "/agents [query]", description: "agents", aliases: ["/threads"] },
    { name: "/extensibility", usage: "/extensibility [overview|skills|plugins|mcp|hooks]", description: "extensibility", aliases: ["/extensions"] },
    { name: "/skills", usage: "/skills [list|enable <name>|disable <name>]", description: "skills", aliases: [] },
    { name: "/plugins", usage: "/plugins [list|trust <packageName> [subpath ...]|untrust <packageName>]", description: "plugins", aliases: [] },
    { name: "/mcp", usage: "/mcp [list|enable <serverName>|disable <serverName>]", description: "mcp", aliases: [] },
    { name: "/hooks", usage: "/hooks [list|events]", description: "hooks", aliases: [] },
    { name: "/config", usage: "/config [show]", description: "config", aliases: [] },
    { name: "/input-mode", usage: "/input-mode [show|default|vim]", description: "input mode", aliases: [] },
    { name: "/keybindings", usage: "/keybindings [show|default|vim]", description: "keybindings", aliases: [] },
    { name: "/theme", usage: "/theme [show|default|aurora|ember|matrix]", description: "theme", aliases: [] },
    { name: "/statusline", usage: "/statusline [show|on|off|toggle]", description: "statusline", aliases: [] },
    { name: "/vim", usage: "/vim [show|on|off|toggle]", description: "vim", aliases: [] },
    { name: "/init", usage: "/init", description: "init guide", aliases: [] },
    { name: "/logs", usage: "/logs [lines]", description: "logs", aliases: [] },
    { name: "/status", usage: "/status", description: "status", aliases: [] },
    { name: "/new", usage: "/new", description: "new session", aliases: [] },
    { name: "/review", usage: "/review [scope]", description: "review", aliases: [] },
    { name: "/security-review", usage: "/security-review [scope]", description: "security", aliases: [] },
    { name: "/pr-comments", usage: "/pr-comments [scope]", description: "comments", aliases: [] },
    { name: "/diff", usage: "/diff", description: "diff", aliases: [] },
    { name: "/compact", usage: "/compact", description: "compact", aliases: [] },
    { name: "/permissions", usage: "/permissions", description: "permissions", aliases: ["/policy"] },
    { name: "/approvals", usage: "/approvals", description: "approvals", aliases: ["/approve"] },
    { name: "/checkpoint", usage: "/checkpoint", description: "checkpoint", aliases: [] },
    { name: "/checkpoints", usage: "/checkpoints", description: "checkpoints", aliases: [] },
    { name: "/rewind", usage: "/rewind", description: "rewind", aliases: ["/rollback"] },
    { name: "/run-cancel", usage: "/run-cancel [reason]", description: "run cancel", aliases: [] },
    { name: "/run-objective", usage: "/run-objective <objective>", description: "run objective", aliases: [] },
    { name: "/run-constraints", usage: "/run-constraints <json>", description: "run constraints", aliases: [] },
    { name: "/run-budget", usage: "/run-budget <json>", description: "run budget", aliases: [] },
    { name: "/run-compact", usage: "/run-compact [reason]", description: "run compact", aliases: [] },
    { name: "/run-worker", usage: "/run-worker <json>", description: "run worker", aliases: [] },
    { name: "/retry-run", usage: "/retry-run [reason]", description: "retry run", aliases: ["/rerun"] },
    { name: "/retry-step", usage: "/retry-step <stepName> [--trace <traceId>] [--reason <text>]", description: "retry step", aliases: [] },
    { name: "/retry-trace", usage: "/retry-trace <traceId> [stepName] [--reason <text>]", description: "retry trace", aliases: [] },
    { name: "/run-fork", usage: "/run-fork <targetSessionId> [--objective <text>] [--reason <text>]", description: "run fork", aliases: [] },
    { name: "/verify-override", usage: "/verify-override <continue|complete|fail> <reason> [--user-update <text>]", description: "verify override", aliases: [] },
    { name: "/desktop", usage: "/desktop <start|stop|status|vnc|list|attach>", description: "desktop", aliases: [] },
    { name: "/sessions", usage: "/sessions", description: "sessions", aliases: [] },
    { name: "/session", usage: "/session <id>", description: "session", aliases: [] },
    { name: "/session-label", usage: "/session-label [show|clear|<label>]", description: "session label", aliases: ["/rename-session"] },
    { name: "/history", usage: "/history", description: "history", aliases: [] },
    { name: "/model", usage: "/model", description: "model", aliases: ["/models"] },
    { name: "/memory", usage: "/memory", description: "memory", aliases: [] },
    { name: "/voice", usage: "/voice [start|stop|status|<persona>]", description: "voice", aliases: [] },
    { name: "/attach", usage: "/attach <path>", description: "attach", aliases: [] },
    { name: "/attachments", usage: "/attachments", description: "attachments", aliases: [] },
    { name: "/unattach", usage: "/unattach [ref]", description: "unattach", aliases: ["/detach"] },
  ];
  const commandLookup = new Map();
  for (const command of watchCommands) {
    commandLookup.set(command.name, command);
    for (const alias of command.aliases ?? []) {
      commandLookup.set(alias, command);
    }
  }
  const controller = createWatchCommandController({
    watchState,
    queuedOperatorInputs,
    WATCH_COMMANDS: watchCommands,
    parseWatchSlashCommand(value) {
      const trimmed = String(value ?? "").trim();
      if (!trimmed.startsWith("/")) return null;
      const [commandToken, ...args] = trimmed.split(/\s+/);
      return {
        commandToken,
        args,
        command: commandLookup.get(commandToken) ?? null,
      };
    },
    authPayload(extra = {}) {
      return { auth: true, ...extra };
    },
    send(type, payload) {
      calls.push({ type: "send", frameType: type, payload });
    },
    shutdownWatch(code) {
      calls.push({ type: "shutdown", code });
    },
    dismissIntro() {
      calls.push({ type: "dismissIntro" });
    },
    clearLiveTranscriptView() {
      calls.push({ type: "clear" });
    },
    exportCurrentView(options) {
      calls.push({ type: "export", options });
    },
    exportBundle(options) {
      calls.push({ type: "exportBundle", options });
      return "/tmp/agenc-watch-bundle-1.json";
    },
    showInsights() {
      calls.push({ type: "showInsights" });
      return "Watch Insights\n- ok";
    },
    showMaintenance() {
      calls.push({ type: "showMaintenance" });
      return "Maintenance Status\n- ok";
    },
    showAgents({ query = null } = {}) {
      calls.push({ type: "showAgents", query });
      return "Agent Threads\n- ok";
    },
    showExtensibility({ section = "overview" } = {}) {
      calls.push({ type: "showExtensibility", section });
      return `Extensibility\n- ${section}`;
    },
    showInputModes() {
      calls.push({ type: "showInputModes" });
      return "Input Preferences\n- ok";
    },
    showConfig() {
      calls.push({ type: "showConfig" });
      return "Local Config\n- ok";
    },
    resetLiveRunSurface() {
      calls.push({ type: "resetLiveRunSurface" });
    },
    resetDelegationState() {
      calls.push({ type: "resetDelegationState" });
    },
    persistSessionId(sessionId) {
      calls.push({ type: "persistSessionId", sessionId });
    },
    currentSessionLabel() {
      calls.push({ type: "currentSessionLabel" });
      return watchState.sessionLabels.get("sess-1") ?? null;
    },
    setSessionLabel(label) {
      calls.push({ type: "setSessionLabel", label });
      const previous = watchState.sessionLabels.get("sess-1") ?? null;
      watchState.sessionLabels.set("sess-1", label);
      return {
        sessionId: "sess-1",
        label,
        previous,
        changed: previous !== label,
      };
    },
    clearSessionLabel() {
      calls.push({ type: "clearSessionLabel" });
      const previous = watchState.sessionLabels.get("sess-1") ?? null;
      watchState.sessionLabels.delete("sess-1");
      return previous;
    },
    currentInputPreferences() {
      calls.push({ type: "currentInputPreferences" });
      return watchState.inputPreferences;
    },
    setInputModeProfile(profile) {
      calls.push({ type: "setInputModeProfile", profile });
      watchState.inputPreferences.inputModeProfile = profile;
      return watchState.inputPreferences;
    },
    setKeybindingProfile(profile) {
      calls.push({ type: "setKeybindingProfile", profile });
      watchState.inputPreferences.keybindingProfile = profile;
      return watchState.inputPreferences;
    },
    setThemeName(themeName) {
      calls.push({ type: "setThemeName", themeName });
      watchState.inputPreferences.themeName = themeName;
      return watchState.inputPreferences;
    },
    currentStatuslineEnabled() {
      calls.push({ type: "currentStatuslineEnabled" });
      return statuslineEnabled;
    },
    setStatuslineEnabled(enabled) {
      calls.push({ type: "setStatuslineEnabled", enabled });
      statuslineEnabled = enabled === true;
      return statuslineEnabled;
    },
    trustPluginPackage(packageName, allowedSubpaths = []) {
      calls.push({ type: "trustPluginPackage", packageName, allowedSubpaths });
      return { packageName, allowedSubpaths };
    },
    untrustPluginPackage(packageName) {
      calls.push({ type: "untrustPluginPackage", packageName });
      return { packageName };
    },
    setMcpServerEnabled(serverName, enabled) {
      calls.push({ type: "setMcpServerEnabled", serverName, enabled });
      return { serverName, enabled };
    },
    captureCheckpoint(label, options) {
      calls.push({ type: "captureCheckpoint", label, options });
      return {
        id: "cp-1",
        label: label || "Checkpoint 1",
        reason: options?.reason ?? "manual",
        createdAtMs: 1_000,
        sessionId: watchState.sessionId,
        objective: watchState.currentObjective,
        runState: watchState.runState,
        eventCount: 0,
        active: true,
      };
    },
    listCheckpoints(options) {
      calls.push({ type: "listCheckpoints", limit: options?.limit });
      return [{
        id: "cp-1",
        label: "Checkpoint 1",
        reason: "manual",
        createdAtMs: 1_000,
        sessionId: watchState.sessionId,
        objective: "ship it",
        runState: "working",
        eventCount: 2,
        active: true,
      }];
    },
    listPendingAttachments() {
      calls.push({ type: "listPendingAttachments" });
      return pendingAttachments.map((attachment, index) => ({
        ...attachment,
        index: index + 1,
      }));
    },
    formatPendingAttachments() {
      calls.push({ type: "formatPendingAttachments" });
      if (pendingAttachments.length === 0) {
        return "No attachments queued.";
      }
      return pendingAttachments
        .map((attachment, index) => `${index + 1}. ${attachment.filename ?? attachment.id ?? "attachment"}`)
        .join("\n");
    },
    queuePendingAttachment(inputPath, options = {}) {
      calls.push({ type: "queuePendingAttachment", inputPath, options });
      const attachment = {
        id: `att-${pendingAttachments.length + 1}`,
        path: inputPath,
        displayPath: inputPath,
        filename: inputPath.split("/").at(-1) || inputPath,
        mimeType: "image/png",
        type: "image",
        sizeBytes: 1024,
      };
      pendingAttachments.push(attachment);
      return { attachment, duplicate: false };
    },
    resolveImplicitAttachmentInput(inputPath) {
      calls.push({ type: "resolveImplicitAttachmentInput", inputPath });
      return overrides.resolveImplicitAttachmentInput
        ? overrides.resolveImplicitAttachmentInput(inputPath)
        : null;
    },
    removePendingAttachment(reference) {
      calls.push({ type: "removePendingAttachment", reference });
      if (pendingAttachments.length === 0) {
        return { removed: [], error: "No attachments are currently queued." };
      }
      if (reference === "all") {
        return { removed: pendingAttachments.splice(0, pendingAttachments.length) };
      }
      const removed = pendingAttachments.splice(-1, 1);
      return { removed };
    },
    clearPendingAttachments() {
      calls.push({ type: "clearPendingAttachments" });
      return pendingAttachments.splice(0, pendingAttachments.length);
    },
    prepareChatMessagePayload(content, { consumeAttachments = true } = {}) {
      calls.push({ type: "prepareChatMessagePayload", content, consumeAttachments });
      const attachments = pendingAttachments.map((attachment) => ({
        type: attachment.type,
        mimeType: attachment.mimeType,
        filename: attachment.filename,
        sizeBytes: attachment.sizeBytes,
        data: "QUJD",
      }));
      const attachmentSummaries = pendingAttachments.map((attachment, index) => ({
        ...attachment,
        index: index + 1,
      }));
      if (consumeAttachments) {
        pendingAttachments.splice(0, pendingAttachments.length);
      }
      return {
        payload: {
          auth: true,
          content,
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        attachmentSummaries,
      };
    },
    openLatestDiffDetail() {
      calls.push({ type: "openLatestDiffDetail" });
      return {
        id: "evt-diff",
        title: "Patch Preview",
      };
    },
    currentDiffNavigationState() {
      calls.push({ type: "currentDiffNavigationState" });
      return {
        enabled: false,
        currentHunkIndex: 0,
        totalHunks: 0,
        currentFilePath: "",
      };
    },
    jumpCurrentDiffHunk(direction) {
      calls.push({ type: "jumpCurrentDiffHunk", direction });
      return false;
    },
    closeDetailView() {
      calls.push({ type: "closeDetailView" });
      return true;
    },
    rewindToCheckpoint(reference) {
      calls.push({ type: "rewindToCheckpoint", reference });
      return {
        id: reference === "latest" ? "cp-1" : reference,
        label: "Checkpoint 1",
        reason: "manual",
        createdAtMs: 1_000,
        sessionId: watchState.sessionId,
        objective: "ship it",
        runState: "working",
        eventCount: 2,
        active: true,
      };
    },
    clearBootstrapTimer() {
      calls.push({ type: "clearBootstrapTimer" });
    },
    pushEvent(kind, title, body, tone) {
      const event = {
        id: `evt-${nextEventId}`,
        kind,
        title,
        body,
        tone,
      };
      nextEventId += 1;
      calls.push({ type: "event", ...event });
      return event;
    },
    setTransientStatus(status) {
      calls.push({ type: "status", status });
    },
    readWatchDaemonLogTail({ lines }) {
      calls.push({ type: "logs", lines });
      return { lines: ["a", "b"] };
    },
    formatLogPayload(payload) {
      return payload.lines.join("\n");
    },
    currentClientKey() {
      return "tmux-live-watch";
    },
    isOpen() {
      return true;
    },
    bootstrapPending() {
      return false;
    },
    voiceController: overrides.voiceController ?? {
      startVoice() {
        calls.push({ type: "startVoice" });
      },
      stopVoice() {
        calls.push({ type: "stopVoice" });
      },
      formatStatusReport() {
        calls.push({ type: "formatStatusReport" });
        return "Voice Companion\n- ok";
      },
    },
    ...overrides,
  });
  return { controller, watchState, queuedOperatorInputs, pendingAttachments, calls };
}

test("command controller clears and exports through explicit operator actions", () => {
  const { controller, calls, watchState } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("/clear"), true);
  assert.equal(controller.dispatchOperatorInput("/export"), true);

  assert.equal(watchState.transcriptScrollOffset, 0);
  assert.equal(watchState.transcriptFollowMode, true);
  assert.ok(calls.some((entry) => entry.type === "clear"));
  assert.ok(calls.some((entry) => entry.type === "export" && entry.options?.announce === true));
});

test("command controller exports a local watch bundle through /bundle", () => {
  const { controller, calls } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("/bundle"), true);

  assert.ok(
    calls.some(
      (entry) => entry.type === "exportBundle" && entry.options?.announce === true,
    ),
  );
});

test("command controller opens the full help detail through /help", () => {
  const { controller, calls, watchState } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("/help"), true);

  const helpEvent = calls.find(
    (entry) => entry.type === "event" && entry.kind === "help" && entry.title === "Command Help",
  );
  assert.ok(helpEvent);
  assert.equal(watchState.expandedEventId, helpEvent.id);
  assert.equal(watchState.detailScrollOffset, 0);
  assert.match(String(helpEvent.body), /Ctrl\+O opens the newest event/);
  assert.match(String(helpEvent.body), /\/help/);
});

test("command controller shows local watch insights through /insights", () => {
  const { controller, calls } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("/insights"), true);

  assert.ok(calls.some((entry) => entry.type === "showInsights"));
});

test("command controller shows agent threads through /agents", () => {
  const { controller, calls } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("/agents all"), true);

  assert.ok(calls.some((entry) => entry.type === "showAgents" && entry.query === "all"));
});

test("command controller shows extensibility sections and mutates local config helpers", () => {
  const { controller, calls } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("/extensibility mcp"), true);
  assert.equal(controller.dispatchOperatorInput("/extensibility hooks"), true);
  assert.equal(controller.dispatchOperatorInput("/plugins trust @demo/plugin channels"), true);
  assert.equal(controller.dispatchOperatorInput("/plugins untrust @demo/plugin"), true);
  assert.equal(controller.dispatchOperatorInput("/mcp enable browser"), true);
  assert.equal(controller.dispatchOperatorInput("/hooks"), true);

  assert.ok(calls.some((entry) => entry.type === "showExtensibility" && entry.section === "mcp"));
  assert.ok(calls.some((entry) => entry.type === "showExtensibility" && entry.section === "hooks"));
  assert.ok(calls.some((entry) => entry.type === "trustPluginPackage" && entry.packageName === "@demo/plugin"));
  assert.ok(calls.some((entry) => entry.type === "untrustPluginPackage" && entry.packageName === "@demo/plugin"));
  assert.ok(calls.some((entry) => entry.type === "setMcpServerEnabled" && entry.serverName === "browser" && entry.enabled === true));
  assert.equal(
    calls.filter((entry) => entry.type === "send" && entry.frameType === "hooks.list").length,
    2,
  );
});

test("command controller manages input preferences locally", () => {
  const { controller, watchState, calls } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("/input-mode vim"), true);
  assert.equal(controller.dispatchOperatorInput("/keybindings vim"), true);
  assert.equal(controller.dispatchOperatorInput("/theme aurora"), true);

  assert.equal(watchState.inputPreferences.inputModeProfile, "vim");
  assert.equal(watchState.inputPreferences.keybindingProfile, "vim");
  assert.equal(watchState.inputPreferences.themeName, "aurora");
  assert.ok(calls.some((entry) => entry.type === "showInputModes"));
});

test("command controller serves local config, statusline, and vim toggles", () => {
  const { controller, watchState, calls } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("/config"), true);
  assert.equal(controller.dispatchOperatorInput("/statusline on"), true);
  assert.equal(controller.dispatchOperatorInput("/vim on"), true);
  assert.equal(controller.dispatchOperatorInput("/vim off"), true);

  assert.ok(calls.some((entry) => entry.type === "showConfig"));
  assert.ok(calls.some((entry) => entry.type === "setStatuslineEnabled" && entry.enabled === true));
  assert.ok(calls.some((entry) => entry.type === "setInputModeProfile" && entry.profile === "vim"));
  assert.ok(calls.some((entry) => entry.type === "setKeybindingProfile" && entry.profile === "vim"));
  assert.ok(calls.some((entry) => entry.type === "setInputModeProfile" && entry.profile === "default"));
  assert.ok(calls.some((entry) => entry.type === "setKeybindingProfile" && entry.profile === "default"));
  assert.equal(watchState.composerMode, "insert");
});

test("command controller requests maintenance snapshots through /maintenance", () => {
  const { controller, watchState, calls } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("/maintenance"), true);

  assert.equal(watchState.maintenanceRequestPending, true);
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "send" &&
        entry.frameType === "maintenance.status" &&
        entry.payload?.auth === true &&
        entry.payload?.limit === 8,
    ),
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "status" &&
        entry.status === "refreshing maintenance",
    ),
  );
});

test("command controller routes voice companion controls locally", () => {
  const { controller, calls } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("/voice"), true);
  assert.equal(controller.dispatchOperatorInput("/voice stop"), true);
  assert.equal(controller.dispatchOperatorInput("/voice status"), true);

  assert.ok(calls.some((entry) => entry.type === "startVoice"));
  assert.ok(calls.some((entry) => entry.type === "stopVoice"));
  assert.ok(calls.some((entry) => entry.type === "formatStatusReport"));
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.kind === "voice" &&
        entry.title === "Voice Companion",
    ),
  );
});

test("command controller uses the typed skill catalog messages", () => {
  const { controller, calls } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("/skills"), true);
  assert.equal(controller.dispatchOperatorInput("/skills enable browser"), true);
  assert.equal(controller.dispatchOperatorInput("/skills disable browser"), true);

  assert.ok(calls.some((entry) => entry.type === "send" && entry.frameType === "skills.list"));
  assert.ok(calls.some((entry) =>
    entry.type === "send" &&
    entry.frameType === "skills.toggle" &&
    entry.payload?.skillName === "browser" &&
    entry.payload?.enabled === true
  ));
  assert.ok(calls.some((entry) =>
    entry.type === "send" &&
    entry.frameType === "skills.toggle" &&
    entry.payload?.skillName === "browser" &&
    entry.payload?.enabled === false
  ));
});

test("command controller queues input while bootstrap is pending", () => {
  const { controller, queuedOperatorInputs, calls } = createCommandHarness({
    isOpen() {
      return false;
    },
    bootstrapPending() {
      return true;
    },
  });

  assert.equal(controller.dispatchOperatorInput("hello world"), true);
  assert.deepEqual(queuedOperatorInputs, ["hello world"]);
  assert.ok(calls.some((entry) => entry.type === "event" && entry.kind === "queued"));
});

test("command controller dispatches normal prompts onto chat.message", () => {
  const { controller, watchState, calls } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("ship it"), true);

  assert.equal(watchState.currentObjective, "ship it");
  assert.equal(watchState.runState, "starting");
  assert.equal(watchState.runPhase, "queued");
  assert.ok(calls.some((entry) => entry.type === "send" && entry.frameType === "chat.message"));
  assert.ok(calls.some((entry) => entry.type === "event" && entry.kind === "you"));
});

test("command controller sends queued attachments with the next prompt", () => {
  const { controller, pendingAttachments, calls } = createCommandHarness();
  pendingAttachments.push({
    id: "att-1",
    path: "/tmp/diagram.png",
    displayPath: "diagram.png",
    filename: "diagram.png",
    mimeType: "image/png",
    type: "image",
    sizeBytes: 1024,
  });

  assert.equal(controller.dispatchOperatorInput("use this screenshot"), true);

  const sendEntry = calls.find(
    (entry) => entry.type === "send" && entry.frameType === "chat.message",
  );
  assert.equal(Array.isArray(sendEntry?.payload?.attachments), true);
  assert.equal(sendEntry?.payload?.attachments?.length, 1);
  assert.equal(pendingAttachments.length, 0);
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.kind === "you" &&
        /Attachments/.test(entry.body),
    ),
  );
});

test("command controller manages local attachment queue commands without daemon calls", () => {
  const { controller, pendingAttachments, calls } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("/attach ./assets/diagram.png"), true);
  assert.equal(pendingAttachments.length, 1);
  assert.equal(controller.dispatchOperatorInput("/attachments"), true);
  assert.equal(controller.dispatchOperatorInput("/unattach all"), true);
  assert.equal(pendingAttachments.length, 0);

  const sendCalls = calls.filter((entry) => entry.type === "send");
  assert.equal(sendCalls.length, 0);
  assert.ok(calls.some((entry) => entry.type === "queuePendingAttachment"));
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "queuePendingAttachment" &&
        entry.inputPath === "./assets/diagram.png" &&
        entry.options?.allowMissing === false,
    ),
  );
  assert.ok(calls.some((entry) => entry.type === "removePendingAttachment"));
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.title === "Queued Attachments",
    ),
  );
});

test("command controller treats a dragged local file path as an implicit attachment", () => {
  const screenshotPath = "/var/folders/demo/NSIRD_screencaptureui_RE96fZ/Screen Shot 2026-03-30 at 18.14.38.png";
  let resolvedInput = null;
  const { controller, pendingAttachments, calls } = createCommandHarness({
    resolveImplicitAttachmentInput(inputPath) {
      resolvedInput = inputPath;
      return inputPath === screenshotPath ? screenshotPath : null;
    },
  });

  assert.equal(controller.dispatchOperatorInput(screenshotPath), true);
  assert.equal(pendingAttachments.length, 1);
  assert.equal(resolvedInput, screenshotPath);
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "queuePendingAttachment" &&
        entry.inputPath === screenshotPath &&
        entry.options?.allowMissing === true,
    ),
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.title === "Attachment Queued From Path",
    ),
  );
  assert.equal(
    calls.some((entry) => entry.type === "event" && entry.title === "Unknown Command"),
    false,
  );
});

test("command controller serves daemon logs locally for /logs", () => {
  const { controller, calls } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("/logs 5"), true);

  assert.ok(calls.some((entry) => entry.type === "logs" && entry.lines === 5));
  assert.ok(calls.some((entry) => entry.type === "event" && entry.kind === "logs"));
});

test("command controller forwards /init to the daemon chat surface", () => {
  const { controller, calls } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("/init --force"), true);

  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "send" &&
        entry.frameType === "chat.message" &&
        entry.payload?.content === "/init --force",
    ),
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" && entry.title === "Project Guide Init",
    ),
  );
});

test("command controller translates review mode commands into findings-first chat prompts", () => {
  const { controller, watchState, calls } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("/review runtime/src/watch"), true);
  assert.equal(watchState.currentObjective, "Code Review");
  assert.equal(watchState.runState, "starting");
  assert.equal(watchState.runPhase, "queued");
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.kind === "operator" &&
        entry.title === "Code Review",
    ),
  );
  const reviewSend = calls.find(
    (entry) => entry.type === "send" && entry.frameType === "chat.message",
  );
  assert.match(reviewSend?.payload?.content ?? "", /Focus on bugs, regressions, risky assumptions, and missing tests\./);
  assert.match(reviewSend?.payload?.content ?? "", /Scope: runtime\/src\/watch\./);
});

test("command controller translates security review and pr comments distinctly", () => {
  const { controller, calls } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("/security-review auth"), true);
  assert.equal(controller.dispatchOperatorInput("/pr-comments diff"), true);

  const chatPayloads = calls
    .filter((entry) => entry.type === "send" && entry.frameType === "chat.message")
    .map((entry) => entry.payload?.content ?? "");

  assert.ok(chatPayloads.some((content) => /security-focused review/i.test(content)));
  assert.ok(chatPayloads.some((content) => /Draft concise PR review comments/i.test(content)));
});

test("command controller opens the latest diff preview through /diff", () => {
  const { controller, calls } = createCommandHarness({
    WATCH_COMMANDS: [
      { name: "/diff", usage: "/diff", description: "open diff", aliases: [] },
    ],
    parseWatchSlashCommand(value) {
      const trimmed = String(value ?? "").trim();
      if (!trimmed.startsWith("/")) return null;
      const [commandToken, ...args] = trimmed.split(/\s+/);
      return {
        commandToken,
        args,
        command: commandToken === "/diff" ? { name: commandToken } : null,
      };
    },
  });

  assert.equal(controller.dispatchOperatorInput("/diff"), true);
  assert.ok(calls.some((entry) => entry.type === "openLatestDiffDetail"));
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.kind === "operator" &&
        entry.title === "Diff View",
    ),
  );
});

test("command controller navigates and closes diff detail through /diff subcommands", () => {
  let currentHunkIndex = 0;
  const { controller, calls } = createCommandHarness({
    WATCH_COMMANDS: [
      { name: "/diff", usage: "/diff [open|next|prev|close]", description: "open diff", aliases: [] },
    ],
    parseWatchSlashCommand(value) {
      const trimmed = String(value ?? "").trim();
      if (!trimmed.startsWith("/")) return null;
      const [commandToken, ...args] = trimmed.split(/\s+/);
      return {
        commandToken,
        args,
        command: commandToken === "/diff" ? { name: commandToken } : null,
      };
    },
    currentDiffNavigationState() {
      calls.push({ type: "currentDiffNavigationState" });
      return {
        enabled: true,
        currentHunkIndex,
        totalHunks: 3,
        currentFilePath: "/repo/src/file.ts",
      };
    },
    jumpCurrentDiffHunk(direction) {
      calls.push({ type: "jumpCurrentDiffHunk", direction });
      currentHunkIndex = Math.max(0, Math.min(2, currentHunkIndex + (direction >= 0 ? 1 : -1)));
      return true;
    },
    closeDetailView() {
      calls.push({ type: "closeDetailView" });
      return true;
    },
  });

  assert.equal(controller.dispatchOperatorInput("/diff next"), true);
  assert.equal(controller.dispatchOperatorInput("/diff prev"), true);
  assert.equal(controller.dispatchOperatorInput("/diff close"), true);

  assert.ok(calls.some((entry) => entry.type === "jumpCurrentDiffHunk" && entry.direction === 1));
  assert.ok(calls.some((entry) => entry.type === "jumpCurrentDiffHunk" && entry.direction === -1));
  assert.ok(calls.some((entry) => entry.type === "closeDetailView"));
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.kind === "operator" &&
        entry.title === "Diff View" &&
        /Focused hunk/.test(entry.body),
    ),
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.kind === "operator" &&
        entry.title === "Diff View" &&
        /Closed the active diff detail view\./.test(entry.body),
    ),
  );
});

test("command controller translates compaction commands onto the daemon session surface", () => {
  const { controller, calls } = createCommandHarness({
    WATCH_COMMANDS: [
      { name: "/compact", usage: "/compact [now|status]", description: "compact", aliases: [] },
    ],
    parseWatchSlashCommand(value) {
      const trimmed = String(value ?? "").trim();
      if (!trimmed.startsWith("/")) return null;
      const [commandToken, ...args] = trimmed.split(/\s+/);
      return {
        commandToken,
        args,
        command: commandToken === "/compact" ? { name: commandToken } : null,
      };
    },
  });

  assert.equal(controller.dispatchOperatorInput("/compact"), true);
  assert.equal(controller.dispatchOperatorInput("/compact status"), true);

  const chatPayloads = calls
    .filter((entry) => entry.type === "send" && entry.frameType === "chat.message")
    .map((entry) => entry.payload?.content ?? "");

  assert.ok(chatPayloads.includes("/compact"));
  assert.ok(chatPayloads.includes("/context"));
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.kind === "operator" &&
        entry.title === "Compaction",
    ),
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.kind === "operator" &&
        entry.title === "Compaction Status",
    ),
  );
});

test("command controller translates permissions commands onto the daemon policy surface", () => {
  const { controller, calls } = createCommandHarness({
    WATCH_COMMANDS: [
      {
        name: "/permissions",
        usage: "/permissions [status|simulate <toolName> [jsonArgs]|credentials|revoke-credentials [credentialId]]",
        description: "permissions",
        aliases: ["/policy"],
      },
    ],
    parseWatchSlashCommand(value) {
      const trimmed = String(value ?? "").trim();
      if (!trimmed.startsWith("/")) return null;
      const [commandToken, ...args] = trimmed.split(/\s+/);
      return {
        commandToken,
        args,
        command: ["/permissions", "/policy"].includes(commandToken)
          ? { name: "/permissions" }
          : null,
      };
    },
  });

  assert.equal(controller.dispatchOperatorInput("/permissions"), true);
  assert.equal(
    controller.dispatchOperatorInput('/permissions simulate system.writeFile {"path":"README.md"}'),
    true,
  );
  assert.equal(controller.dispatchOperatorInput("/permissions allow system.writeFile"), true);
  assert.equal(controller.dispatchOperatorInput("/permissions deny wallet.*"), true);
  assert.equal(controller.dispatchOperatorInput("/permissions clear wallet.*"), true);
  assert.equal(controller.dispatchOperatorInput("/permissions reset"), true);

  const chatPayloads = calls
    .filter((entry) => entry.type === "send" && entry.frameType === "chat.message")
    .map((entry) => entry.payload?.content ?? "");

  assert.ok(chatPayloads.includes("/policy status"));
  assert.ok(
    chatPayloads.includes('/policy simulate system.writeFile {"path":"README.md"}'),
  );
  assert.ok(chatPayloads.includes("/policy update allow system.writeFile"));
  assert.ok(chatPayloads.includes("/policy update deny wallet.*"));
  assert.ok(chatPayloads.includes("/policy update clear wallet.*"));
  assert.ok(chatPayloads.includes("/policy update reset"));
});

test("command controller translates approvals commands onto the daemon approval surface", () => {
  const { controller, calls } = createCommandHarness({
    WATCH_COMMANDS: [
      {
        name: "/approvals",
        usage: "/approvals [list|approve <requestId>|deny <requestId>|always <requestId>]",
        description: "approvals",
        aliases: ["/approve"],
      },
    ],
    parseWatchSlashCommand(value) {
      const trimmed = String(value ?? "").trim();
      if (!trimmed.startsWith("/")) return null;
      const [commandToken, ...args] = trimmed.split(/\s+/);
      return {
        commandToken,
        args,
        command: ["/approvals", "/approve"].includes(commandToken)
          ? { name: "/approvals" }
          : null,
      };
    },
  });

  assert.equal(controller.dispatchOperatorInput("/approvals"), true);
  assert.equal(controller.dispatchOperatorInput("/approvals deny req-7"), true);
  assert.equal(controller.dispatchOperatorInput("/approve req-8 always"), true);

  const chatPayloads = calls
    .filter((entry) => entry.type === "send" && entry.frameType === "chat.message")
    .map((entry) => entry.payload?.content ?? "");

  assert.ok(chatPayloads.includes("approve list"));
  assert.ok(chatPayloads.includes("approve req-7 no"));
  assert.ok(chatPayloads.includes("approve req-8 always"));
});

test("command controller forwards extended durable run controls onto run.control", () => {
  const { controller, calls, watchState } = createCommandHarness();
  watchState.runDetail = {
    availability: {
      controlAvailable: true,
    },
    checkpointAvailable: true,
  };

  assert.equal(controller.dispatchOperatorInput("/run-cancel operator abort"), true);
  assert.equal(controller.dispatchOperatorInput("/run-objective Watch the verifier until it exits"), true);
  assert.equal(
    controller.dispatchOperatorInput('/run-constraints {"nextCheckMs":7000,"requiresUserStop":true}'),
    true,
  );
  assert.equal(
    controller.dispatchOperatorInput('/run-budget {"maxRuntimeMs":120000,"maxCycles":12}'),
    true,
  );
  assert.equal(controller.dispatchOperatorInput("/run-compact planner pressure"), true);
  assert.equal(
    controller.dispatchOperatorInput('/run-worker {"preferredWorkerId":"worker-2","workerAffinityKey":"frontend"}'),
    true,
  );

  const payloads = calls
    .filter((entry) => entry.type === "send" && entry.frameType === "run.control")
    .map((entry) => entry.payload);

  assert.deepEqual(payloads, [
    {
      action: "cancel",
      sessionId: "sess-1",
      reason: "operator abort",
    },
    {
      action: "edit_objective",
      sessionId: "sess-1",
      objective: "Watch the verifier until it exits",
      reason: "operator updated durable run objective",
    },
    {
      action: "amend_constraints",
      sessionId: "sess-1",
      constraints: {
        nextCheckMs: 7000,
        requiresUserStop: true,
      },
      reason: "operator amended durable run constraints",
    },
    {
      action: "adjust_budget",
      sessionId: "sess-1",
      budget: {
        maxRuntimeMs: 120000,
        maxCycles: 12,
      },
      reason: "operator adjusted durable run budget",
    },
    {
      action: "force_compact",
      sessionId: "sess-1",
      reason: "planner pressure",
    },
    {
      action: "reassign_worker",
      sessionId: "sess-1",
      worker: {
        preferredWorkerId: "worker-2",
        workerAffinityKey: "frontend",
      },
      reason: "operator reassigned durable run worker",
    },
  ]);
});

test("command controller retries the active durable run from checkpoint", () => {
  const { controller, calls, watchState } = createCommandHarness();
  watchState.runDetail = {
    availability: {
      controlAvailable: true,
    },
    checkpointAvailable: true,
  };

  assert.equal(controller.dispatchOperatorInput("/retry-run verifier asked for replay"), true);

  assert.equal(watchState.runInspectPending, true);
  const sendEntry = calls.find(
    (entry) => entry.type === "send" && entry.frameType === "run.control",
  );
  assert.deepEqual(sendEntry?.payload, {
    action: "retry_from_checkpoint",
    sessionId: "sess-1",
    reason: "verifier asked for replay",
  });
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.kind === "operator" &&
        entry.title === "Retry Run" &&
        /last checkpoint/.test(entry.body),
    ),
  );
});

test("command controller retries the active durable run from a step and a trace", () => {
  const { controller, calls, watchState } = createCommandHarness();
  watchState.runDetail = {
    availability: {
      controlAvailable: true,
    },
    checkpointAvailable: true,
  };

  assert.equal(
    controller.dispatchOperatorInput("/retry-step verify tests --trace trace-1 --reason replay this failure"),
    true,
  );
  assert.equal(
    controller.dispatchOperatorInput("/retry-trace trace-9 planner verify --reason inspect verifier"),
    true,
  );

  const payloads = calls
    .filter((entry) => entry.type === "send" && entry.frameType === "run.control")
    .map((entry) => entry.payload);

  assert.deepEqual(payloads, [
    {
      action: "retry_from_step",
      sessionId: "sess-1",
      stepName: "verify tests",
      traceId: "trace-1",
      reason: "replay this failure",
    },
    {
      action: "retry_from_trace",
      sessionId: "sess-1",
      traceId: "trace-9",
      stepName: "planner verify",
      reason: "inspect verifier",
    },
  ]);
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "status" &&
        entry.status === "retrying step",
    ),
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "status" &&
        entry.status === "retrying trace",
    ),
  );
});

test("command controller forks the active durable run from checkpoint", () => {
  const { controller, calls, watchState } = createCommandHarness();
  watchState.runDetail = {
    availability: {
      controlAvailable: true,
    },
    checkpointAvailable: true,
  };

  assert.equal(
    controller.dispatchOperatorInput("/run-fork sess-2 --objective compare branch --reason operator branch"),
    true,
  );

  const sendEntry = calls.find(
    (entry) => entry.type === "send" && entry.frameType === "run.control",
  );
  assert.deepEqual(sendEntry?.payload, {
    action: "fork_from_checkpoint",
    sessionId: "sess-1",
    targetSessionId: "sess-2",
    objective: "compare branch",
    reason: "operator branch",
  });
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "status" &&
        entry.status === "forking run",
    ),
  );
});

test("command controller applies verification overrides through the durable run control plane", () => {
  const { controller, calls, watchState } = createCommandHarness();
  watchState.runDetail = {
    availability: {
      controlAvailable: true,
    },
    checkpointAvailable: true,
  };

  assert.equal(
    controller.dispatchOperatorInput(
      "/verify-override fail replay invalid --user-update Operator marked replay invalid",
    ),
    true,
  );

  const sendEntry = calls.find(
    (entry) => entry.type === "send" && entry.frameType === "run.control",
  );
  assert.deepEqual(sendEntry?.payload, {
    action: "verification_override",
    sessionId: "sess-1",
    override: {
      mode: "fail",
      reason: "replay invalid",
      userUpdate: "Operator marked replay invalid",
    },
  });
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "status" &&
        entry.status === "override fail",
    ),
  );
});

test("command controller validates extended durable run control usage before sending", () => {
  const { controller, calls, watchState } = createCommandHarness();
  watchState.runDetail = {
    availability: {
      controlAvailable: true,
    },
    checkpointAvailable: true,
  };

  assert.equal(controller.dispatchOperatorInput("/run-objective"), true);
  assert.equal(controller.dispatchOperatorInput("/run-budget not-json"), true);
  assert.equal(controller.dispatchOperatorInput("/run-constraints"), true);
  assert.equal(controller.dispatchOperatorInput("/run-worker []"), true);
  assert.equal(controller.dispatchOperatorInput("/retry-step"), true);
  assert.equal(controller.dispatchOperatorInput("/retry-trace"), true);
  assert.equal(controller.dispatchOperatorInput("/run-fork"), true);
  assert.equal(controller.dispatchOperatorInput("/verify-override maybe nope"), true);

  assert.equal(
    calls.filter((entry) => entry.type === "send" && entry.frameType === "run.control").length,
    0,
  );
  assert.ok(
    calls.filter((entry) => entry.type === "event" && entry.kind === "error").length >= 8,
  );
});

test("command controller reports unavailable run controls and missing checkpoints", () => {
  const { controller, calls, watchState } = createCommandHarness();
  watchState.runDetail = {
    availability: {
      controlAvailable: false,
      disabledReason: "Run controls disabled for this runtime.",
    },
    checkpointAvailable: false,
  };

  assert.equal(controller.dispatchOperatorInput("/retry-run"), true);

  assert.equal(
    calls.filter((entry) => entry.type === "send" && entry.frameType === "run.control").length,
    0,
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.kind === "error" &&
        entry.title === "Run Control Unavailable",
    ),
  );

  calls.length = 0;
  watchState.runDetail = {
    availability: {
      controlAvailable: true,
    },
    checkpointAvailable: false,
  };

  assert.equal(controller.dispatchOperatorInput("/retry-run"), true);
  assert.equal(
    calls.filter((entry) => entry.type === "send" && entry.frameType === "run.control").length,
    0,
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.kind === "error" &&
        entry.title === "Checkpoint Unavailable",
    ),
  );

  calls.length = 0;
  assert.equal(controller.dispatchOperatorInput("/retry-step verify tests"), true);
  assert.equal(controller.dispatchOperatorInput("/retry-trace trace-1"), true);
  assert.equal(controller.dispatchOperatorInput("/run-fork sess-2"), true);
  assert.equal(
    calls.filter((entry) => entry.type === "send" && entry.frameType === "run.control").length,
    0,
  );
  assert.equal(
    calls.filter(
      (entry) =>
        entry.type === "event" &&
        entry.kind === "error" &&
        entry.title === "Checkpoint Unavailable",
    ).length,
    3,
  );
});

test("command controller forwards desktop tooling commands onto chat.message", () => {
  const { controller, calls } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("/desktop list"), true);
  assert.equal(controller.dispatchOperatorInput("/desktop attach 1"), true);
  assert.equal(controller.dispatchOperatorInput("/desktop nope"), true);

  const chatPayloads = calls
    .filter((entry) => entry.type === "send" && entry.frameType === "chat.message")
    .map((entry) => entry.payload?.content ?? "");

  assert.ok(chatPayloads.includes("/desktop list"));
  assert.ok(chatPayloads.includes("/desktop attach 1"));
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.kind === "operator" &&
        entry.title === "Desktop Tools",
    ),
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.kind === "error" &&
        entry.title === "Usage Error" &&
        /Usage: \/desktop/.test(entry.body),
    ),
  );
});

test("command controller saves and lists checkpoints through dedicated commands", () => {
  const { controller, calls } = createCommandHarness({
    WATCH_COMMANDS: [
      { name: "/checkpoint", usage: "/checkpoint [label]", description: "save", aliases: [] },
      { name: "/checkpoints", usage: "/checkpoints", description: "list", aliases: [] },
    ],
    parseWatchSlashCommand(value) {
      const trimmed = String(value ?? "").trim();
      if (!trimmed.startsWith("/")) return null;
      const [commandToken, ...args] = trimmed.split(/\s+/);
      return {
        commandToken,
        args,
        command: ["/checkpoint", "/checkpoints"].includes(commandToken)
          ? { name: commandToken }
          : null,
      };
    },
  });

  assert.equal(controller.dispatchOperatorInput("/checkpoint before-review"), true);
  assert.equal(controller.dispatchOperatorInput("/checkpoints 3"), true);

  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "captureCheckpoint" &&
        entry.label === "before-review" &&
        entry.options?.reason === "manual",
    ),
  );
  assert.ok(calls.some((entry) => entry.type === "listCheckpoints"));
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "listCheckpoints" &&
        entry.limit === 3,
    ),
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.kind === "checkpoint" &&
        entry.title === "Checkpoint Saved",
    ),
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.kind === "checkpoint" &&
        entry.title === "Checkpoint History",
    ),
  );
});

test("command controller stores session list filters before requesting chat.sessions", () => {
  const { controller, watchState, calls } = createCommandHarness({
    WATCH_COMMANDS: [
      { name: "/sessions", usage: "/sessions [query]", description: "sessions", aliases: [] },
    ],
    parseWatchSlashCommand(value) {
      const trimmed = String(value ?? "").trim();
      if (!trimmed.startsWith("/")) return null;
      const [commandToken, ...args] = trimmed.split(/\s+/);
      return {
        commandToken,
        args,
        command: commandToken === "/sessions" ? { name: commandToken } : null,
      };
    },
  });

  assert.equal(controller.dispatchOperatorInput("/sessions runtime"), true);

  assert.equal(watchState.manualSessionsRequestPending, true);
  assert.equal(watchState.manualSessionsQuery, "runtime");
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "send" &&
        entry.frameType === "chat.sessions",
    ),
  );
});

test("command controller shows, updates, and clears the active session label", () => {
  const { controller, calls, watchState } = createCommandHarness();

  assert.equal(controller.dispatchOperatorInput("/session-label"), true);
  assert.equal(controller.dispatchOperatorInput("/session-label Release branch"), true);
  assert.equal(controller.dispatchOperatorInput("/session-label clear"), true);

  assert.ok(calls.some((entry) => entry.type === "currentSessionLabel"));
  assert.ok(calls.some((entry) => entry.type === "setSessionLabel" && entry.label === "Release branch"));
  assert.ok(calls.some((entry) => entry.type === "clearSessionLabel"));
  assert.equal(watchState.sessionLabels.has("sess-1"), false);
});

test("command controller rewinds to a saved checkpoint and reports missing references", () => {
  const { controller, calls } = createCommandHarness({
    WATCH_COMMANDS: [
      { name: "/rewind", usage: "/rewind [checkpoint-id|latest|active]", description: "rewind", aliases: [] },
    ],
    parseWatchSlashCommand(value) {
      const trimmed = String(value ?? "").trim();
      if (!trimmed.startsWith("/")) return null;
      const [commandToken, ...args] = trimmed.split(/\s+/);
      return {
        commandToken,
        args,
        command: commandToken === "/rewind" ? { name: commandToken } : null,
      };
    },
    rewindToCheckpoint(reference) {
      calls.push({ type: "rewindToCheckpoint", reference });
      if (reference === "missing") {
        return null;
      }
      return {
        id: "cp-7",
        label: "Checkpoint 7",
        reason: "manual",
        createdAtMs: 1_000,
        sessionId: "sess-1",
        objective: "ship it",
        runState: "working",
        eventCount: 3,
        active: true,
      };
    },
  });

  assert.equal(controller.dispatchOperatorInput("/rewind cp-7"), true);
  assert.equal(controller.dispatchOperatorInput("/rewind missing"), true);

  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "rewindToCheckpoint" &&
        entry.reference === "cp-7",
    ),
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.kind === "checkpoint" &&
        entry.title === "Checkpoint Rewind",
    ),
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.kind === "error" &&
        entry.title === "Checkpoint Not Found",
    ),
  );
});

test("command controller captures a checkpoint before starting a new session when checkpointing is enabled", () => {
  const { controller, calls } = createCommandHarness({
    WATCH_COMMANDS: [
      { name: "/new", usage: "/new", description: "new session", aliases: [] },
      { name: "/checkpoint", usage: "/checkpoint [label]", description: "checkpoint", aliases: [] },
    ],
    parseWatchSlashCommand(value) {
      const trimmed = String(value ?? "").trim();
      if (!trimmed.startsWith("/")) return null;
      const [commandToken, ...args] = trimmed.split(/\s+/);
      return {
        commandToken,
        args,
        command: ["/new", "/checkpoint"].includes(commandToken)
          ? { name: commandToken }
          : null,
      };
    },
  });

  assert.equal(controller.dispatchOperatorInput("/new"), true);
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "captureCheckpoint" &&
        entry.label === "Before new session" &&
        entry.options?.reason === "new-session",
    ),
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry.type === "event" &&
        entry.kind === "operator" &&
        entry.title === "New Session" &&
        /Saved cp-1 before reset\./.test(entry.body),
    ),
  );
});
