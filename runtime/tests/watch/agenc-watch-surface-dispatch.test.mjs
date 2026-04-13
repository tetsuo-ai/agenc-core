import test from "node:test";
import assert from "node:assert/strict";

import { dispatchOperatorSurfaceEvent } from "../../src/watch/agenc-watch-surface-dispatch.mjs";

function createHarness(overrides = {}) {
  const calls = [];
  const state = {
    sessionId: null,
    ownerToken: null,
    sessionAttachedAtMs: null,
    runDetail: { id: "run-1" },
    runState: "working",
    runPhase: "active",
    bootstrapReady: false,
    manualSessionsRequestPending: false,
    manualHistoryRequestPending: false,
    pendingResumeHistoryRestore: false,
    currentObjective: "watch it",
    activeRunStartedAtMs: null,
    latestAgentSummary: null,
    latestTool: null,
    latestToolState: null,
    runInspectPending: true,
    lastUsageSummary: null,
    liveSessionModelRoute: null,
    lastStatus: null,
    configuredModelRoute: null,
    manualStatusRequestPending: false,
    lastStatusFeedFingerprint: null,
    manualSessionsQuery: null,
    ...overrides.state,
  };
  const api = {
    state,
    now: () => 123,
    setTransientStatus: (value) => calls.push(["status", value]),
    requestCockpit: (reason) => calls.push(["requestCockpit", reason]),
    persistSessionId: (value) => calls.push(["persistSessionId", value]),
    persistOwnerToken: (value) => calls.push(["persistOwnerToken", value]),
    resetLiveRunSurface: () => calls.push(["resetLiveRunSurface"]),
    markBootstrapReady: (value) => calls.push(["markBootstrapReady", value]),
    clearBootstrapTimer: () => calls.push(["clearBootstrapTimer"]),
    send: (type, payload) => calls.push(["send", type, payload]),
    authPayload: (payload) => ({ auth: true, ...payload }),
    requestRunInspect: (reason, payload) => calls.push(["requestRunInspect", reason, payload ?? null]),
    eventStore: {
      pushEvent: (...args) => calls.push(["pushEvent", ...args]),
      appendAgentStreamChunk: (...args) => calls.push(["appendAgentStreamChunk", ...args]),
      commitAgentMessage: (...args) => calls.push(["commitAgentMessage", ...args]),
      cancelAgentStream: (...args) => calls.push(["cancelAgentStream", ...args]),
      restoreTranscriptFromHistory: (value) => calls.push(["restoreTranscriptFromHistory", value]),
      clearLiveTranscriptView: (...args) => calls.push(["clearLiveTranscriptView", ...args]),
      replaceLatestToolEvent: (...args) => calls.push(["replaceLatestToolEvent", ...args]),
      replaceLatestSubagentToolEvent: (...args) => calls.push(["replaceLatestSubagentToolEvent", ...args]),
      clearSubagentHeartbeatEvents: (...args) =>
        calls.push(["clearSubagentHeartbeatEvents", ...args]),
    },
    formatSessionSummaries: (value) => JSON.stringify(value),
    latestSessionSummary: (value) => value[0] ?? null,
    formatHistoryPayload: (value) => JSON.stringify(value),
    shouldAutoInspectRun: () => true,
    sanitizeInlineText: (value) => String(value ?? "").trim(),
    truncate: (value) => String(value ?? ""),
    summarizeUsage: (value) => ({ summary: value }),
    normalizeModelRoute: (value) => ({ route: value }),
    describeToolStart: (toolName, args) => ({
      title: `Run ${toolName}`,
      body: JSON.stringify(args ?? {}),
      tone: "yellow",
    }),
    descriptorEventMetadata: (descriptor, metadata) => ({
      ...metadata,
      previewMode: descriptor.previewMode,
      renderSignature: descriptor.renderSignature ?? "",
    }),
    shouldSuppressToolTranscript: () => false,
    shouldSuppressToolActivity: () => false,
    handleToolResult: (...args) => calls.push(["handleToolResult", ...args]),
    tryPrettyJson: (value) => JSON.stringify(value),
    formatLogPayload: (value) => JSON.stringify(value),
    formatStatusPayload: (value) => JSON.stringify(value),
    statusFeedFingerprint: (value) => JSON.stringify(value),
    cockpitFeedFingerprint: (value) => JSON.stringify(value),
    handlePlannerTraceEvent: (...args) => {
      calls.push(["handlePlannerTraceEvent", ...args]);
      return true;
    },
    hydrateMarketTaskBrowser: (value) => calls.push(["hydrateMarketTaskBrowser", value]),
    handleSubagentLifecycleMessage: (...args) => {
      calls.push(["handleSubagentLifecycleMessage", ...args]);
      return true;
    },
    hydratePlannerDagFromTraceArtifacts: (value) =>
      calls.push(["hydratePlannerDagFromTraceArtifacts", value]),
    isExpectedMissingRunInspect: (value, payload) =>
      value === "missing run" || payload?.code === "background_run_missing",
    isUnavailableBackgroundRunInspect: (payload) =>
      payload?.code === "background_run_unavailable",
    isRetryableBootstrapError: (value) => value === "bootstrap",
    scheduleBootstrap: (value) => calls.push(["scheduleBootstrap", value]),
    ...overrides.api,
  };
  return { api, state, calls };
}

test("dispatchOperatorSurfaceEvent handles session-ready events", () => {
  const { api, state, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "session",
      type: "chat.session",
      payload: { sessionId: "session-1" },
      payloadRecord: { sessionId: "session-1" },
      payloadList: null,
      isSessionScoped: false,
      message: { error: undefined },
    },
    null,
    api,
  );

  assert.equal(state.sessionId, "session-1");
  assert.equal(state.runState, "idle");
  assert.deepEqual(calls, [
    ["persistSessionId", "session-1"],
    ["resetLiveRunSurface"],
    ["send", "session.command.catalog.get", { auth: true, client: "console", sessionId: "session-1" }],
    ["markBootstrapReady", "session ready: session-1"],
    ["requestCockpit", "session ready"],
  ]);
});

test("dispatchOperatorSurfaceEvent resumes sessions by restoring history and inspecting the run", () => {
  const { api, state, calls } = createHarness({
    state: { bootstrapReady: true },
  });

  dispatchOperatorSurfaceEvent(
    {
      family: "session",
      type: "chat.session.resumed",
      payload: { sessionId: "session-2" },
      payloadRecord: { sessionId: "session-2" },
      payloadList: null,
      isSessionScoped: false,
      message: {},
    },
    null,
    api,
  );

  assert.equal(state.sessionId, "session-2");
  assert.equal(state.sessionAttachedAtMs, 123);
  assert.equal(state.bootstrapReady, true);
  assert.equal(state.pendingResumeHistoryRestore, true);
  assert.deepEqual(calls, [
    ["persistSessionId", "session-2"],
    ["resetLiveRunSurface"],
    ["send", "session.command.catalog.get", { auth: true, client: "console", sessionId: "session-2" }],
    ["send", "chat.history", { auth: true, limit: 50 }],
    ["requestRunInspect", "resume", { force: true }],
    ["markBootstrapReady", "session resumed: session-2; restoring history"],
    ["requestCockpit", "resume"],
  ]);
});

test("dispatchOperatorSurfaceEvent restores bootstrap history before marking the session ready", () => {
  const history = [{ role: "assistant", content: "hello" }];
  const { api, calls } = createHarness({
    state: { sessionId: "session-3", bootstrapReady: false },
  });

  dispatchOperatorSurfaceEvent(
    {
      family: "session",
      type: "chat.history",
      payload: history,
      payloadRecord: {},
      payloadList: history,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    ["restoreTranscriptFromHistory", history],
    ["markBootstrapReady", "history restored: 1 item(s)"],
    ["requestRunInspect", "history restore", { force: true }],
    ["requestCockpit", "history restore"],
  ]);
});

test("dispatchOperatorSurfaceEvent restores resumed history without blocking session input", () => {
  const history = [{ role: "assistant", content: "welcome back" }];
  const { api, state, calls } = createHarness({
    state: {
      sessionId: "session-4",
      bootstrapReady: true,
      pendingResumeHistoryRestore: true,
    },
  });

  dispatchOperatorSurfaceEvent(
    {
      family: "session",
      type: "chat.history",
      payload: history,
      payloadRecord: {},
      payloadList: history,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.equal(state.pendingResumeHistoryRestore, false);
  assert.deepEqual(calls, [
    ["restoreTranscriptFromHistory", history],
    ["status", "history restored: 1 item(s)"],
  ]);
});

test("dispatchOperatorSurfaceEvent filters manual session lists with the active query", () => {
  const { api, state, calls } = createHarness({
    state: {
      manualSessionsRequestPending: true,
      manualSessionsQuery: "alpha",
    },
  });
  const sessions = [
    { sessionId: "session-a", label: "Alpha workspace" },
    { sessionId: "session-b", label: "Beta workspace" },
  ];

  dispatchOperatorSurfaceEvent(
    {
      family: "session",
      type: "chat.session.list",
      payload: sessions,
      payloadRecord: {},
      payloadList: sessions,
      isSessionScoped: false,
      message: {},
    },
    null,
    api,
  );

  assert.equal(state.manualSessionsRequestPending, false);
  assert.equal(state.manualSessionsQuery, null);
  assert.deepEqual(calls, [
    [
      "pushEvent",
      "session",
      "Filtered Sessions",
      JSON.stringify([{ sessionId: "session-a", label: "Alpha workspace" }]),
      "teal",
    ],
    ["status", "session filter loaded: 1 match(es)"],
  ]);
});

test("dispatchOperatorSurfaceEvent bootstraps from canonical session list results", () => {
  const { api, state, calls } = createHarness({
    state: {
      bootstrapReady: false,
      sessionId: "session-prev",
    },
  });
  const sessions = [
    { sessionId: "session-next", label: "Latest" },
  ];

  dispatchOperatorSurfaceEvent(
    {
      family: "chat",
      type: "session.command.result",
      payload: {
        commandName: "session",
        content: "1 session",
        data: {
          kind: "session",
          subcommand: "list",
          sessions,
        },
      },
      payloadRecord: {
        commandName: "session",
        content: "1 session",
        data: {
          kind: "session",
          subcommand: "list",
          sessions,
        },
      },
      payloadList: null,
      isSessionScoped: false,
      message: {},
    },
    null,
    api,
  );

  assert.equal(state.sessionId, "session-prev");
  assert.deepEqual(calls, [
    [
      "status",
      "resuming session session-next",
    ],
    [
      "send",
      "chat.session.resume",
      {
        auth: true,
        sessionId: "session-next",
      },
    ],
  ]);
});

test("dispatchOperatorSurfaceEvent handles canonical session resume results", () => {
  const { api, state, calls } = createHarness({
    state: { bootstrapReady: false },
  });

  dispatchOperatorSurfaceEvent(
    {
      family: "chat",
      type: "session.command.result",
      payload: {
        commandName: "session",
        content: "resumed",
        sessionId: "session-5",
        data: {
          kind: "session",
          subcommand: "resume",
          resumed: {
            sessionId: "session-5",
            messageCount: 12,
          },
        },
      },
      payloadRecord: {
        commandName: "session",
        content: "resumed",
        sessionId: "session-5",
        data: {
          kind: "session",
          subcommand: "resume",
          resumed: {
            sessionId: "session-5",
            messageCount: 12,
          },
        },
      },
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.equal(state.sessionId, "session-5");
  assert.equal(state.pendingResumeHistoryRestore, true);
  assert.deepEqual(calls, [
    ["persistSessionId", "session-5"],
    ["resetLiveRunSurface"],
    ["send", "session.command.catalog.get", { auth: true, client: "console", sessionId: "session-5" }],
    ["send", "chat.history", { auth: true, limit: 50 }],
    ["requestRunInspect", "resume", { force: true }],
    ["markBootstrapReady", "session resumed: session-5; restoring history"],
    ["requestCockpit", "resume"],
  ]);
});

test("dispatchOperatorSurfaceEvent preserves full marketplace task lists in detail metadata", () => {
  const { api, calls } = createHarness();
  const tasks = Array.from({ length: 7 }, (_, index) => ({
    status: index % 2 === 0 ? "open" : "claimed",
    description: `Task ${index + 1}`,
    reward: `${index + 1}`,
  }));

  dispatchOperatorSurfaceEvent(
    {
      family: "market",
      type: "tasks.list",
      payload: tasks,
      payloadRecord: {},
      payloadList: tasks,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    [
      "hydrateMarketTaskBrowser",
      {
        title: "Marketplace Tasks",
        items: tasks,
        kind: "tasks",
      },
    ],
    ["status", "market tasks loaded"],
    [
      "pushEvent",
      "market",
      "Marketplace Tasks",
      [
        "1. [open] Task 1 (1 SOL)",
        "2. [claimed] Task 2 (2 SOL)",
        "3. [open] Task 3 (3 SOL)",
        "4. [claimed] Task 4 (4 SOL)",
        "5. [open] Task 5 (5 SOL)",
        "... 2 more",
      ].join("\n"),
      "teal",
      {
        detailBody: [
          "1. [open] Task 1 (1 SOL)",
          "2. [claimed] Task 2 (2 SOL)",
          "3. [open] Task 3 (3 SOL)",
          "4. [claimed] Task 4 (4 SOL)",
          "5. [open] Task 5 (5 SOL)",
          "6. [claimed] Task 6 (6 SOL)",
          "7. [open] Task 7 (7 SOL)",
        ].join("\n"),
      },
    ],
  ]);
});

test("dispatchOperatorSurfaceEvent preserves full marketplace skill lists in detail metadata", () => {
  const { api, calls } = createHarness();
  const skills = Array.from({ length: 6 }, (_, index) => ({
    skillId: `skill-${index + 1}`,
    skillPda: `skill-pda-${index + 1}`,
    name: `Skill ${index + 1}`,
    priceSol: `${index + 1}`,
    rating: 4.5,
    downloads: index + 10,
  }));

  dispatchOperatorSurfaceEvent(
    {
      family: "market",
      type: "market.skills.list",
      payload: skills,
      payloadRecord: {},
      payloadList: skills,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    [
      "hydrateMarketTaskBrowser",
      {
        title: "Marketplace Skills",
        items: skills,
        kind: "skills",
      },
    ],
    ["status", "market skills loaded"],
    [
      "pushEvent",
      "market",
      "Marketplace Skills",
      [
        "1. Skill 1 · [active] · 1 SOL · rating 4.5 · downloads 10",
        "2. Skill 2 · [active] · 2 SOL · rating 4.5 · downloads 11",
        "3. Skill 3 · [active] · 3 SOL · rating 4.5 · downloads 12",
        "4. Skill 4 · [active] · 4 SOL · rating 4.5 · downloads 13",
        "5. Skill 5 · [active] · 5 SOL · rating 4.5 · downloads 14",
        "... 1 more",
      ].join("\n"),
      "teal",
      {
        detailBody: [
          "1. Skill 1 · [active] · 1 SOL · rating 4.5 · downloads 10",
          "2. Skill 2 · [active] · 2 SOL · rating 4.5 · downloads 11",
          "3. Skill 3 · [active] · 3 SOL · rating 4.5 · downloads 12",
          "4. Skill 4 · [active] · 4 SOL · rating 4.5 · downloads 13",
          "5. Skill 5 · [active] · 5 SOL · rating 4.5 · downloads 14",
          "6. Skill 6 · [active] · 6 SOL · rating 4.5 · downloads 15",
        ].join("\n"),
      },
    ],
  ]);
});

test("dispatchOperatorSurfaceEvent preserves governance lists in browser hydration and detail metadata", () => {
  const { api, calls } = createHarness();
  const proposals = [
    {
      proposalPda: "proposal-pda-1",
      status: "active",
      payloadPreview: "Upgrade validator set",
      votesFor: "12",
      votesAgainst: "3",
    },
    {
      proposalPda: "proposal-pda-2",
      status: "approved",
      proposalType: "budget",
      votesFor: "20",
      votesAgainst: "1",
    },
  ];

  dispatchOperatorSurfaceEvent(
    {
      family: "market",
      type: "market.governance.list",
      payload: proposals,
      payloadRecord: {},
      payloadList: proposals,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    [
      "hydrateMarketTaskBrowser",
      {
        title: "Governance Proposals",
        items: proposals,
        kind: "governance",
      },
    ],
    ["status", "governance proposals loaded"],
    [
      "pushEvent",
      "market",
      "Governance Proposals",
      [
        "1. [active] Upgrade validator set · for 12 · against 3",
        "2. [approved] budget · for 20 · against 1",
      ].join("\n"),
      "teal",
      {},
    ],
  ]);
});

test("dispatchOperatorSurfaceEvent preserves dispute lists in browser hydration and detail metadata", () => {
  const { api, calls } = createHarness();
  const disputes = [
    {
      disputePda: "dispute-pda-1",
      status: "pending",
      resolutionType: "refund",
      votesFor: "2",
      votesAgainst: "1",
    },
    {
      disputePda: "dispute-pda-2",
      status: "resolved",
      resolutionType: "slash",
      votesFor: "5",
      votesAgainst: "0",
    },
  ];

  dispatchOperatorSurfaceEvent(
    {
      family: "market",
      type: "market.disputes.list",
      payload: disputes,
      payloadRecord: {},
      payloadList: disputes,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    [
      "hydrateMarketTaskBrowser",
      {
        title: "Marketplace Disputes",
        items: disputes,
        kind: "disputes",
      },
    ],
    ["status", "market disputes loaded"],
    [
      "pushEvent",
      "market",
      "Marketplace Disputes",
      [
        "1. [pending] refund · dispute-pda-1 · for 2 · against 1",
        "2. [resolved] slash · dispute-pda-2 · for 5 · against 0",
      ].join("\n"),
      "amber",
      {},
    ],
  ]);
});

test("dispatchOperatorSurfaceEvent hydrates reputation summaries into the inline browser", () => {
  const { api, calls } = createHarness();
  const summary = {
    authority: "agent-authority-1",
    agentPda: "agent-pda-1",
    registered: true,
    effectiveReputation: 98,
    tasksCompleted: 14,
    totalEarnedSol: "4.2",
    stakedAmountSol: "1.5",
  };

  dispatchOperatorSurfaceEvent(
    {
      family: "market",
      type: "market.reputation.summary",
      payload: summary,
      payloadRecord: summary,
      payloadList: [],
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    [
      "hydrateMarketTaskBrowser",
      {
        title: "Reputation Summary",
        items: [summary],
        kind: "reputation",
      },
    ],
    ["status", "reputation summary loaded"],
    [
      "pushEvent",
      "market",
      "Reputation Summary",
      "1. [registered] agent-authority-1 · effective 98 · tasks 14 · earned 4.2 SOL",
      "teal",
      {
        detailBody: [
          "authority: agent-authority-1",
          "agent: agent-pda-1",
          "scorecard: effective 98 · 14 tasks",
          "activity: 4.2 SOL earned · 1.5 SOL staked",
        ].join("\n"),
      },
    ],
  ]);
});

test("dispatchOperatorSurfaceEvent filters manual session lists using local session labels", () => {
  const { api, state, calls } = createHarness({
    state: {
      manualSessionsRequestPending: true,
      manualSessionsQuery: "roadmap",
    },
    api: {
      sessionQueryCandidates: (session) =>
        session.sessionId === "session-b" ? ["Roadmap branch"] : [],
    },
  });
  const sessions = [
    { sessionId: "session-a", label: "Alpha workspace" },
    { sessionId: "session-b", label: "Beta workspace" },
  ];

  dispatchOperatorSurfaceEvent(
    {
      family: "session",
      type: "chat.session.list",
      payload: sessions,
      payloadRecord: {},
      payloadList: sessions,
      isSessionScoped: false,
      message: {},
    },
    null,
    api,
  );

  assert.equal(state.manualSessionsRequestPending, false);
  assert.equal(state.manualSessionsQuery, null);
  assert.deepEqual(calls, [
    [
      "pushEvent",
      "session",
      "Filtered Sessions",
      JSON.stringify([{ sessionId: "session-b", label: "Beta workspace" }]),
      "teal",
    ],
    ["status", "session filter loaded: 1 match(es)"],
  ]);
});

test("dispatchOperatorSurfaceEvent routes tool execution events", () => {
  const { api, state, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "tool",
      type: "tools.executing",
      payload: { toolName: "system.bash", args: { command: "pwd" } },
      payloadRecord: { toolName: "system.bash", args: { command: "pwd" } },
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.equal(state.latestTool, "system.bash");
  assert.equal(state.latestToolState, "running");
  assert.deepEqual(calls, [
    ["status", "Run system.bash"],
    [
      "pushEvent",
      "tool",
      "Run system.bash",
      JSON.stringify({ command: "pwd" }),
      "yellow",
      {
        toolName: "system.bash",
        toolArgs: { command: "pwd" },
        previewMode: undefined,
        renderSignature: "",
      },
    ],
    ["requestRunInspect", "tool start", null],
  ]);
});

test("dispatchOperatorSurfaceEvent preserves honest completion states from chat.response", () => {
  const { api, state, calls } = createHarness({
    state: {
      runState: "working",
      runPhase: "planner",
      activeRunStartedAtMs: 99,
    },
  });

  dispatchOperatorSurfaceEvent(
    {
      family: "chat",
      type: "chat.response",
      payload: {
        sessionId: "session-1",
        completionState: "needs_verification",
        stopReason: "completed",
      },
      payloadRecord: {
        sessionId: "session-1",
        completionState: "needs_verification",
        stopReason: "completed",
      },
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.equal(state.runState, "needs_verification");
  assert.equal(state.runPhase, null);
  assert.equal(state.activeRunStartedAtMs, null);
  assert.ok(
    calls.some(
      ([kind, value]) => kind === "status" && value === "run needs verification",
    ),
  );
});

test("dispatchOperatorSurfaceEvent routes final chat messages through stream reconciliation", () => {
  const { api, state, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "chat",
      type: "chat.message",
      payload: { content: "done" },
      payloadRecord: { content: "done" },
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.equal(state.latestAgentSummary, "done");
  assert.deepEqual(calls, [
    ["status", "agent reply received"],
    ["commitAgentMessage", "done"],
    ["requestCockpit", "agent reply"],
    ["requestRunInspect", "agent reply", null],
  ]);
});

test("dispatchOperatorSurfaceEvent accepts content-based chat.stream payloads", () => {
  const { api, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "chat",
      type: "chat.stream",
      payload: { content: "partial", done: false },
      payloadRecord: { content: "partial", done: false },
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    ["appendAgentStreamChunk", "partial", { done: false }],
    ["status", "streaming: partial"],
  ]);
});

test("dispatchOperatorSurfaceEvent retains delta fallback for older chat.stream payloads", () => {
  const { api, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "chat",
      type: "chat.stream",
      payload: { delta: "legacy" },
      payloadRecord: { delta: "legacy" },
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    ["appendAgentStreamChunk", "legacy", { done: false }],
    ["status", "streaming: legacy"],
  ]);
});

test("dispatchOperatorSurfaceEvent cancels live stream state when chats are cancelled", () => {
  const { api, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "chat",
      type: "chat.cancelled",
      payload: { cancelled: true },
      payloadRecord: { cancelled: true },
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    ["cancelAgentStream", "cancelled"],
    ["status", "chat cancelled"],
    ["pushEvent", "cancelled", "Chat Cancelled", JSON.stringify({ cancelled: true }), "amber"],
  ]);
});

test("dispatchOperatorSurfaceEvent keeps the live stream when chat cancellation fails", () => {
  const { api, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "chat",
      type: "chat.cancelled",
      payload: { cancelled: false },
      payloadRecord: { cancelled: false },
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    ["status", "chat cancel failed"],
    ["pushEvent", "error", "Chat Cancel Failed", JSON.stringify({ cancelled: false }), "red"],
  ]);
});

test("dispatchOperatorSurfaceEvent routes planner families through the planner handler", () => {
  const { api, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "planner",
      type: "planner_step_started",
      payload: { stepName: "Compile" },
      payloadRecord: { stepName: "Compile" },
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    ["handlePlannerTraceEvent", "planner_step_started", { stepName: "Compile" }],
  ]);
});

test("dispatchOperatorSurfaceEvent routes subagent families through the subagent handler", () => {
  const { api, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "subagent",
      type: "subagents.tool.executing",
      payload: {
        subagentSessionId: "subagent:child-1",
        toolName: "system.bash",
        args: { command: "pwd" },
      },
      payloadRecord: {
        subagentSessionId: "subagent:child-1",
        toolName: "system.bash",
        args: { command: "pwd" },
      },
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    [
      "handleSubagentLifecycleMessage",
      "subagents.tool.executing",
      {
        subagentSessionId: "subagent:child-1",
        toolName: "system.bash",
        args: { command: "pwd" },
      },
    ],
  ]);
});

test("dispatchOperatorSurfaceEvent updates run state from run.inspect payloads", () => {
  const payload = {
    sessionId: "session-4",
    objective: "Ship it",
    state: "running",
    currentPhase: "execute",
    createdAt: "456",
  };
  const { api, state, calls } = createHarness({
    state: { sessionId: "session-4", runInspectPending: true, activeRunStartedAtMs: null },
  });

  dispatchOperatorSurfaceEvent(
    {
      family: "run",
      type: "run.inspect",
      payload,
      payloadRecord: payload,
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.equal(state.runInspectPending, false);
  assert.equal(state.runDetail, payload);
  assert.equal(state.currentObjective, "Ship it");
  assert.equal(state.runState, "running");
  assert.equal(state.runPhase, "execute");
  assert.equal(state.activeRunStartedAtMs, 456);
  assert.deepEqual(calls, [
    ["hydratePlannerDagFromTraceArtifacts", "session-4"],
    ["status", "run inspect loaded: running"],
    ["requestCockpit", "run inspect"],
  ]);
});

test("dispatchOperatorSurfaceEvent prefers completion truth from run.inspect payloads", () => {
  const payload = {
    sessionId: "session-4",
    objective: "Ship it",
    state: "working",
    completionState: "needs_verification",
    remainingRequirements: ["workflow_verifier_pass"],
    currentPhase: "execute",
    createdAt: "456",
  };
  const { api, state, calls } = createHarness({
    state: { sessionId: "session-4", runInspectPending: true, activeRunStartedAtMs: null },
  });

  dispatchOperatorSurfaceEvent(
    {
      family: "run",
      type: "run.inspect",
      payload,
      payloadRecord: payload,
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.equal(state.runState, "needs_verification");
  assert.equal(state.runPhase, "execute");
  assert.equal(state.activeRunStartedAtMs, 456);
  assert.deepEqual(calls, [
    ["hydratePlannerDagFromTraceArtifacts", "session-4"],
    ["status", "run inspect loaded: needs verification"],
    ["requestCockpit", "run inspect"],
  ]);
});

test("dispatchOperatorSurfaceEvent preserves completion truth on run.updated payloads", () => {
  const payload = {
    sessionId: "session-5",
    state: "working",
    completionState: "needs_verification",
    remainingRequirements: ["workflow_verifier_pass"],
    currentPhase: "active",
    explanation: "Verification is still required.",
    createdAt: 456,
  };
  const { api, state, calls } = createHarness({
    state: {
      sessionId: "session-5",
      runState: "working",
      runPhase: "planning",
      activeRunStartedAtMs: null,
    },
  });

  dispatchOperatorSurfaceEvent(
    {
      family: "run",
      type: "run.updated",
      payload,
      payloadRecord: payload,
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.equal(state.runState, "needs_verification");
  assert.equal(state.runPhase, "active");
  assert.equal(state.activeRunStartedAtMs, 456);
  assert.deepEqual(calls, [
    ["status", "run updated: needs verification"],
    [
      "pushEvent",
      "run",
      "Run Update",
      [
        "completion state: needs_verification",
        "run state: working",
        "phase: active",
        "remaining requirements: workflow_verifier_pass",
        "session: session-5",
        "explanation: Verification is still required.",
      ].join("\n"),
      "magenta",
    ],
    ["requestRunInspect", "run update", null],
    ["requestCockpit", "run update"],
  ]);
});

test("dispatchOperatorSurfaceEvent emits status updates when the fingerprint changes", () => {
  const payload = { provider: "openai", model: "gpt-5.4" };
  const { api, state, calls } = createHarness({
    state: {
      manualStatusRequestPending: false,
      lastStatusFeedFingerprint: null,
      configuredModelRoute: null,
    },
  });

  dispatchOperatorSurfaceEvent(
    {
      family: "status",
      type: "status.update",
      payload,
      payloadRecord: payload,
      payloadList: null,
      isSessionScoped: false,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(state.lastStatus, payload);
  assert.deepEqual(state.configuredModelRoute, {
    route: { ...payload, source: "status" },
  });
  assert.equal(state.lastStatusFeedFingerprint, JSON.stringify(payload));
  assert.deepEqual(calls, [
    ["status", "gateway status loaded"],
    ["requestCockpit", "status poll"],
    ["pushEvent", "status", "Gateway Status", JSON.stringify(payload), "blue"],
  ]);
});

test("dispatchOperatorSurfaceEvent keeps a local model selection when gateway status reports a different default model", () => {
  const payload = { provider: "grok", model: "grok-4.20" };
  const { api, state, calls } = createHarness({
    state: {
      configuredModelRoute: {
        provider: "openai",
        model: "gpt-4.1",
        source: "local",
        updatedAt: 200,
      },
    },
  });

  dispatchOperatorSurfaceEvent(
    {
      family: "status",
      type: "status.update",
      payload,
      payloadRecord: payload,
      payloadList: null,
      isSessionScoped: false,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(state.lastStatus, payload);
  assert.deepEqual(state.configuredModelRoute, {
    provider: "openai",
    model: "gpt-4.1",
    source: "local",
    updatedAt: 200,
  });
  assert.equal(state.lastStatusFeedFingerprint, JSON.stringify(payload));
  assert.deepEqual(calls, [
    ["status", "gateway status loaded"],
    ["requestCockpit", "status poll"],
    ["pushEvent", "status", "Gateway Status", JSON.stringify(payload), "blue"],
  ]);
});

test("dispatchOperatorSurfaceEvent surfaces durable-run disabled status explicitly", () => {
  const payload = {
    state: "running",
    backgroundRuns: {
      enabled: false,
      operatorAvailable: false,
      disabledCode: "background_runs_feature_disabled",
      disabledReason: "Durable background runs are disabled in autonomy feature flags.",
    },
  };
  const { api, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "status",
      type: "status.update",
      payload,
      payloadRecord: payload,
      payloadList: null,
      isSessionScoped: false,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    ["status", "durable runs disabled"],
    ["requestCockpit", "status poll"],
    ["pushEvent", "status", "Gateway Status", JSON.stringify(payload), "blue"],
  ]);
});

test("dispatchOperatorSurfaceEvent resets run state for expected missing-run errors", () => {
  const { api, state, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "error",
      type: "error",
      payload: { code: "E_NO_RUN" },
      payloadRecord: { code: "E_NO_RUN" },
      payloadList: null,
      isSessionScoped: false,
      message: { error: "missing run" },
    },
    null,
    api,
  );

  assert.equal(state.runDetail, null);
  assert.equal(state.runState, "idle");
  assert.equal(state.runPhase, null);
  assert.deepEqual(calls, [
    ["status", "no active background run for this session"],
  ]);
});

test("dispatchOperatorSurfaceEvent schedules bootstrap retries for transient startup errors", () => {
  const { api, state, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "error",
      type: "error",
      payload: { code: "E_BOOTSTRAP" },
      payloadRecord: { code: "E_BOOTSTRAP" },
      payloadList: null,
      isSessionScoped: false,
      message: { error: "bootstrap" },
    },
    null,
    api,
  );

  assert.equal(state.runInspectPending, false);
  assert.equal(state.manualStatusRequestPending, false);
  assert.equal(state.manualSessionsRequestPending, false);
  assert.equal(state.manualHistoryRequestPending, false);
  assert.deepEqual(calls, [
    ["scheduleBootstrap", "webchat handler still starting"],
  ]);
});

test("dispatchOperatorSurfaceEvent clears stale missing sessions during bootstrap", () => {
  const { api, state, calls } = createHarness({
    state: {
      sessionId: "session:stale-session",
      bootstrapReady: false,
    },
  });

  dispatchOperatorSurfaceEvent(
    {
      family: "error",
      type: "error",
      payload: {},
      payloadRecord: {},
      payloadList: null,
      isSessionScoped: false,
      message: { error: 'Session "session:stale-session" not found' },
    },
    null,
    api,
  );

  assert.equal(state.sessionId, null);
  assert.deepEqual(calls, [
    ["persistSessionId", null],
    ["scheduleBootstrap", "stale session missing; retrying bootstrap"],
  ]);
});

test("dispatchOperatorSurfaceEvent records unavailable durable-run operator errors", () => {
  const { api, state, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "error",
      type: "error",
      payload: {
        code: "background_run_unavailable",
        backgroundRunAvailability: {
          enabled: false,
          operatorAvailable: false,
          disabledReason:
            "Durable background runs are disabled in autonomy feature flags.",
        },
      },
      payloadRecord: {
        code: "background_run_unavailable",
        backgroundRunAvailability: {
          enabled: false,
          operatorAvailable: false,
          disabledReason:
            "Durable background runs are disabled in autonomy feature flags.",
        },
      },
      payloadList: null,
      isSessionScoped: false,
      message: {
        error:
          "Durable background runs are disabled in autonomy feature flags.",
      },
    },
    null,
    api,
  );

  assert.equal(state.runDetail, null);
  assert.equal(state.runState, "idle");
  assert.equal(state.runPhase, null);
  assert.deepEqual(calls, [
    [
      "status",
      "Durable background runs are disabled in autonomy feature flags.",
    ],
    [
      "pushEvent",
      "run",
      "Durable Run Unavailable",
      "Durable background runs are disabled in autonomy feature flags.",
      "amber",
    ],
  ]);
});

test("dispatchOperatorSurfaceEvent preserves approval escalations in the transcript", () => {
  const { api, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "approval",
      type: "approval.escalated",
      payload: { rule: "system.delete", reason: "dangerous action" },
      payloadRecord: { rule: "system.delete", reason: "dangerous action" },
      payloadList: null,
      isSessionScoped: true,
      message: {},
    },
    null,
    api,
  );

  assert.deepEqual(calls, [
    [
      "pushEvent",
      "approval",
      "Approval Escalated",
      JSON.stringify({ rule: "system.delete", reason: "dangerous action" }),
      "amber",
    ],
    ["requestCockpit", "approval escalated"],
  ]);
});

test("dispatchOperatorSurfaceEvent falls back to a raw event transcript entry for unknown families", () => {
  const { api, calls } = createHarness();

  dispatchOperatorSurfaceEvent(
    {
      family: "unknown",
      type: "mystery.event",
      payload: { hello: "world" },
      payloadRecord: { hello: "world" },
      payloadList: null,
      isSessionScoped: false,
      message: {},
    },
    { type: "mystery.event", payload: { hello: "world" } },
    api,
  );

  assert.deepEqual(calls, [
    ["pushEvent", "mystery.event", "mystery.event", JSON.stringify({ hello: "world" }), "slate"],
  ]);
});
