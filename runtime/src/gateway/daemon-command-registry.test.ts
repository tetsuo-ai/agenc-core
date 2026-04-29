import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { silentLogger } from "../utils/logger.js";
import { createDaemonCommandRegistry } from "./daemon-command-registry.js";
import { PluginCatalog } from "../skills/catalog.js";
import {
  SESSION_SHELL_PROFILE_METADATA_KEY,
  SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY,
  SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY,
  SESSION_WORKFLOW_STATE_METADATA_KEY,
} from "./session.js";

function makeCommandRegistry(params?: {
  providerOverrides?: Array<Record<string, unknown>>;
  sessionOverrides?: Record<string, unknown>;
  memoryBackendOverrides?: Record<string, unknown>;
  gatewayLlmOverrides?: Record<string, unknown>;
  gatewayAutonomyOverrides?: Record<string, unknown>;
  toolResponses?: Record<string, unknown>;
  toolCatalog?: Array<Record<string, unknown>>;
  shellSkills?: Array<Record<string, unknown>>;
  skillDiscoveryPaths?: Record<string, unknown>;
  mcpManagerOverrides?: Record<string, unknown>;
  pluginCatalogSetup?: (catalog: PluginCatalog) => void;
}) {
  const configDir = mkdtempSync(join(tmpdir(), "agenc-daemon-cmd-"));
  const configPath = join(configDir, "config.json");
  const localSkillsDir = join(configDir, "skills");
  mkdirSync(localSkillsDir, { recursive: true });
  const localSkillPath = join(localSkillsDir, "local-skill.md");
  writeFileSync(
    localSkillPath,
    [
      "---",
      "name: local-skill",
      "description: Local shell helper",
      "---",
      "",
      "# local skill",
      "",
      "Use this for local shell testing.",
    ].join("\n"),
    "utf8",
  );
  const pluginCatalogPath = join(configDir, ".agenc", "plugins.json");
  mkdirSync(join(configDir, ".agenc"), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      llm: {
        provider: "grok",
        model: "grok-4.20-beta-0309-reasoning",
        reasoningEffort: "medium",
        statefulResponses: { enabled: true, store: true },
      },
      mcp: {
        servers: [{ name: "demo", enabled: true, trustTier: "trusted" }],
      },
    }),
    "utf8",
  );
  const session = {
    history: new Array(6).fill({}),
    metadata: {
      [SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY]: {
        previousResponseId: "resp-anchor-1",
      },
      [SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY]: true,
      ...(params?.sessionOverrides ?? {}),
    },
  } as any;

  const providers = (
    params?.providerOverrides ?? [
      {
        name: "grok",
        getCapabilities: () => ({
          provider: "grok",
          stateful: {
            assistantPhase: false,
            previousResponseId: true,
            encryptedReasoning: true,
            storedResponseRetrieval: true,
            storedResponseDeletion: true,
            opaqueCompaction: false,
            deterministicFallback: true,
          },
        }),
        retrieveStoredResponse: vi.fn(async () => ({
          id: "resp-anchor-1",
          provider: "grok",
          model: "grok-4.20-reasoning",
          status: "completed",
          content: "stored response content",
          toolCalls: [],
          encryptedReasoning: { requested: true, available: true },
          providerEvidence: {
            citations: ["https://x.ai"],
            serverSideToolUsage: [
              {
                category: "SERVER_SIDE_TOOL_WEB_SEARCH",
                toolType: "web_search",
                count: 1,
              },
            ],
          },
          raw: { id: "resp-anchor-1", output_text: "stored response content" },
        })),
        deleteStoredResponse: vi.fn(async () => ({
          id: "resp-anchor-1",
          provider: "grok",
          deleted: true,
          raw: { id: "resp-anchor-1", deleted: true },
        })),
      },
    ]
  ) as any[];

  const memoryBackend = {
    name: "sqlite",
    delete: vi.fn(async () => {}),
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => {}),
    ...(params?.memoryBackendOverrides ?? {}),
  } as any;
  const getSessionPolicyState = vi.fn(() => ({
    elevatedPatterns: [],
    deniedPatterns: [],
  }));
  const listAgentRoles = vi.fn(() => [
    {
      id: "coding",
      displayName: "Coding",
      description: "Implement code changes",
      source: "runtime",
      trustLabel: "builtin",
      curated: true,
      definitionName: "implement",
      defaultShellProfile: "coding",
      defaultToolBundle: "coding-core",
      mutating: true,
      worktreeEligible: true,
    },
    {
      id: "review",
      displayName: "Reviewer",
      description: "Review the current changes",
      source: "runtime",
      trustLabel: "builtin",
      curated: true,
      definitionName: "review",
      defaultShellProfile: "coding",
      defaultToolBundle: "verification-probes",
      mutating: false,
      worktreeEligible: false,
    },
    {
      id: "verify",
      displayName: "Verifier",
      description: "Verify the current implementation",
      source: "runtime",
      trustLabel: "builtin",
      curated: true,
      definitionName: "verify",
      defaultShellProfile: "validation",
      defaultToolBundle: "verification-probes",
      mutating: false,
      worktreeEligible: false,
    },
  ]);
  const launchShellAgentTask = vi.fn(async ({ roleId, taskId, wait }) => ({
    role:
      listAgentRoles().find((role: { id: string }) => role.id === roleId) ??
      listAgentRoles()[0],
    sessionId: `child-${roleId}-1`,
    taskId: taskId ?? `task-${roleId}-1`,
    output: `${roleId} complete`,
    success: true,
    status: "completed",
    waited: wait === true,
  }));
  const inspectShellAgentTask = vi.fn(async (parentSessionId: string, target: string) => ({
    sessionId: target.startsWith("child-") ? target : "child-coding-1",
    taskId: target.startsWith("task-") ? target : "task-coding-1",
    status: "running",
    task: "Implement the task",
    role: "coding",
    roleSource: "runtime",
    toolBundle: "coding-core",
    shellProfile: "coding",
    executionLocation: "host",
    workspaceRoot: "/tmp/project",
    workingDirectory: "/tmp/project/src",
    outputPreview: `inspect ${parentSessionId}`,
  }));
  const stopShellAgentTask = vi.fn(async (_parentSessionId: string, target: string) => ({
    stopped: true,
    sessionId: target.startsWith("child-") ? target : "child-coding-1",
    taskId: target.startsWith("task-") ? target : "task-coding-1",
  }));
  const listSubAgentInfo = vi.fn(() => [
    {
      sessionId: "child-coding-1",
      status: "running",
      task: "Implement the task",
      role: "coding",
      roleSource: "runtime",
      toolBundle: "coding-core",
      taskId: "task-coding-1",
      shellProfile: "coding",
      workspaceRoot: "/tmp/project",
      workingDirectory: "/tmp/project/src",
      executionLocation: "host",
      worktreePath: "/tmp/project/.worktrees/child-coding-1",
    },
  ]);
  const webChatChannel = {
    loadSessionWorkspaceRoot: vi.fn(async () => "/tmp/project"),
    listContinuitySessionsForSession: vi.fn(async () => [
      {
        sessionId: "session-1",
        preview: "Ship shell",
        shellProfile: "coding",
        workflowStage: "implement",
        resumabilityState: "active",
        messageCount: 6,
        branch: "feature/coding-first-shell",
      },
    ]),
    inspectOwnedSession: vi.fn(async () => ({
      sessionId: "session-1",
      label: "session-1",
      preview: "Ship shell",
      messageCount: 6,
      createdAt: 0,
      updatedAt: 0,
      lastActiveAt: 0,
      connected: true,
      shellProfile: "coding",
      workflowStage: "implement",
      resumabilityState: "active",
      pendingApprovalCount: 0,
      childSessionCount: 1,
      worktreeCount: 1,
      workspaceRoot: "/tmp/project",
      repoRoot: "/tmp/project",
      branch: "feature/coding-first-shell",
      head: "abc123",
      workflowState: {
        stage: "implement",
        worktreeMode: "child_optional",
      },
      recentHistory: [
        { sender: "user", content: "ship it" },
        { sender: "agent", content: "working on it" },
      ],
    })),
    loadOwnedSessionHistory: vi.fn(async () => [
      { sender: "user", content: "ship it" },
      { sender: "tool", toolName: "system.grep", content: "match" },
    ]),
    resumeOwnedSession: vi.fn(async () => ({
      sessionId: "session-2",
      messageCount: 4,
      workspaceRoot: "/tmp/project",
    })),
    forkOwnedSessionForRequester: vi.fn(async () => ({
      sourceSessionId: "session-1",
      targetSessionId: "session-fork-1",
      forkSource: "runtime_state",
      session: {
        sessionId: "session-fork-1",
        preview: "Ship shell",
      },
    })),
  };
  const updateSessionPolicyState = vi.fn((params) => ({
    elevatedPatterns:
      params.operation === "allow" && params.pattern ? [params.pattern] : [],
    deniedPatterns:
      params.operation === "deny" && params.pattern ? [params.pattern] : [],
  }));
  const handleConfigReload = vi.fn(async () => {});
  const mcpManager = {
    getConnectedServers: vi.fn(() => ["demo"]),
    reconnectServer: vi.fn(async (serverName: string) => ({
      serverName,
      success: true,
      toolCount: 1,
    })),
    ...(params?.mcpManagerOverrides ?? {}),
  } as any;
  const pluginCatalog = new PluginCatalog(pluginCatalogPath);
  pluginCatalog.install(
    {
      id: "agenc.demo.plugin",
      version: "1.0.0",
      schemaVersion: 1,
      displayName: "Demo Plugin",
      description: "Demo plugin for shell command tests",
      labels: ["demo", "shell"],
      permissions: [{ type: "tool_call", scope: "system.grep", required: true }],
      allowDeny: { allow: ["system.grep"], deny: ["wallet.sign"] },
    },
    "workspace",
    { slot: "llm", sourcePath: "/tmp/plugins/demo-plugin" },
  );
  params?.pluginCatalogSetup?.(pluginCatalog);
  const shellSkills = (params?.shellSkills ?? [
    {
      skill: {
        name: "local-skill",
        description: "Local shell helper",
        sourcePath: localSkillPath,
        body: "Use this for local shell testing.",
        metadata: {
          tags: ["local", "shell"],
          primaryEnv: "AGENC_TEST_ENV",
        },
      },
      available: true,
      tier: "project",
      missingRequirements: [],
    },
  ]) as any[];
  const skillDiscoveryPaths = {
    agentSkills: undefined,
    projectSkills: localSkillsDir,
    userSkills: "/tmp/user-skills",
    builtinSkills: "/tmp/builtin-skills",
    ...(params?.skillDiscoveryPaths ?? {}),
  } as any;
  const defaultToolResponses: Record<string, unknown> = {
    "system.repoInventory": {
      repoRoot: "/tmp/project",
      branch: "feature/coding-first-shell",
      fileCount: 120,
      manifests: ["package.json"],
      topLevelDirectories: ["src", "docs", "tests"],
      languages: [
        { language: "TypeScript", count: 80 },
        { language: "Markdown", count: 10 },
      ],
    },
    "system.searchFiles": {
      matches: ["src/shell-profile.ts", "src/cli/index.ts"],
    },
    "system.grep": {
      matches: [
        {
          filePath: "src/shell-profile.ts",
          line: 12,
          column: 5,
          matchText: "shellProfile",
        },
      ],
      truncated: false,
    },
    "system.gitStatus": {
      repoRoot: "/tmp/project",
      branch: "feature/coding-first-shell",
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      changed: [{ path: "src/cli/index.ts" }],
      summary: {
        staged: 1,
        unstaged: 2,
        untracked: 0,
        conflicted: 0,
      },
    },
    "system.gitBranchInfo": {
      repoRoot: "/tmp/project",
      branch: "feature/coding-first-shell",
      head: "abc123",
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
    },
    "system.gitChangeSummary": {
      summary: {
        staged: 1,
        unstaged: 2,
        untracked: 0,
        renamed: 0,
        deleted: 0,
        conflicted: 0,
      },
    },
    "system.gitDiff": {
      diff: "diff --git a/src/cli/index.ts b/src/cli/index.ts\n+new line\n",
      truncated: false,
    },
    "system.gitShow": {
      output: "commit abc123\nAuthor: Test\n",
    },
    "system.gitWorktreeList": {
      worktrees: [
        {
          path: "/tmp/project",
          branch: "feature/coding-first-shell",
          head: "abc123",
          detached: false,
        },
      ],
    },
    "system.gitWorktreeCreate": {
      worktreePath: "/tmp/project-alt",
      branch: "alt",
      ref: null,
    },
    "system.gitWorktreeRemove": {
      worktreePath: "/tmp/project-alt",
      dirty: false,
    },
    "system.gitWorktreeStatus": {
      worktreePath: "/tmp/project-alt",
      branch: "alt",
      head: "def456",
      dirty: false,
      statusLines: [],
    },
    "task.list": {
      tasks: [{ id: "1", subject: "Ship shell", status: "in_progress" }],
    },
    "task.get": {
      task: {
        id: "1",
        subject: "Ship shell",
        status: "in_progress",
        description: "Do the work",
      },
    },
    "task.wait": {
      task: {
        id: "1",
        subject: "Ship shell",
        status: "completed",
        description: "Do the work",
      },
    },
    "task.output": {
      output: "done",
    },
  };
  const toolResponses = {
    ...defaultToolResponses,
    ...(params?.toolResponses ?? {}),
  };
  const baseToolHandler = vi.fn(async (name: string) =>
    JSON.stringify(toolResponses[name] ?? { error: `Unknown tool: ${name}` }),
  );
  const toolCatalog =
    params?.toolCatalog ?? [
      {
        name: "mcp.demo.lookup",
        description: "Lookup from MCP",
        inputSchema: {},
        metadata: { source: "mcp", family: "mcp", hiddenByDefault: false, mutating: false },
      },
      {
        name: "system.grep",
        description: "Search files",
        inputSchema: {},
        metadata: { source: "builtin", family: "coding", hiddenByDefault: false, mutating: false },
      },
    ];

  const registry = createDaemonCommandRegistry(
    {
      logger: silentLogger,
      configPath,
      gateway: {
        config: {
          llm: {
            provider: "grok",
            model: "grok-4.20-beta-0309-reasoning",
            sessionTokenBudget: 0,
            statefulResponses: {
              enabled: true,
              store: true,
            },
            includeEncryptedReasoning: true,
            ...(params?.gatewayLlmOverrides ?? {}),
          },
          autonomy: {
            enabled: true,
            featureFlags: {
              backgroundRuns: true,
              multiAgent: true,
              notifications: true,
              replayGates: true,
              canaryRollout: false,
              shellProfiles: true,
              codingCommands: true,
              shellExtensions: true,
              watchCockpit: true,
            },
            killSwitches: {
              backgroundRuns: false,
              multiAgent: false,
              notifications: false,
              replayGates: false,
              canaryRollout: false,
              shellProfiles: false,
              codingCommands: false,
              shellExtensions: false,
              watchCockpit: false,
            },
            ...(params?.gatewayAutonomyOverrides ?? {}),
          },
          mcp: {
            servers: [
              { name: "demo", enabled: true, trustTier: "trusted" },
            ],
          },
        },
      },
      yolo: false,
      resetWebSessionContext: vi.fn(async () => {}),
      getWebChatChannel: () => webChatChannel as any,
      getHostWorkspacePath: () => "/tmp/project",
      getChatExecutor: () =>
        ({
          getSessionTokenUsage: () => 25_136,
        }) as any,
      getResolvedContextWindowTokens: () => 2_000_000,
      getSystemPrompt: () => "# Agent\n# Repository Guidelines\n# Tool\n# Memory\n",
      getMemoryBackendName: () => "sqlite",
      getPolicyEngineState: () => undefined,
      isPolicyEngineEnabled: () => false,
      isGovernanceAuditLogEnabled: () => false,
      listSessionCredentialLeases: () => [],
      revokeSessionCredentials: vi.fn(async () => 0),
      resolvePolicyScopeForSession: ({ sessionId, runId, channel }) => ({
        sessionId,
        runId,
        channel: channel ?? "webchat",
      }),
      buildPolicySimulationPreview: vi.fn(async () => ({
        toolName: "system.readFile",
        sessionId: "session-1",
        policy: { allowed: true, mode: "normal", violations: [] },
        approval: { required: false, elevated: false, denied: false },
      })),
      getSessionPolicyState,
      updateSessionPolicyState,
      getSubAgentRuntimeConfig: () => null,
      getActiveDelegationAggressiveness: () => "balanced",
      resolveDelegationScoreThreshold: () => 0,
      getDelegationAggressivenessOverride: () => null,
      setDelegationAggressivenessOverride: () => {},
      configureDelegationRuntimeServices: () => {},
      getWebChatInboundHandler: () => null,
      getDesktopHandleBySession: () => undefined,
      getSessionModelInfo: () => ({
        provider: "grok",
        model: "grok-4.20-reasoning",
        usedFallback: false,
      }),
      handleConfigReload,
      getMcpManager: () => mcpManager,
      getPluginCatalog: () => pluginCatalog,
      discoverShellSkills: vi.fn(async () => shellSkills),
      resolveShellSkillDiscoveryPaths: vi.fn(async () => skillDiscoveryPaths),
      getVoiceBridge: () => null,
      getDesktopManager: () => null,
      getDesktopBridges: () => new Map(),
      getPlaywrightBridges: () => new Map(),
      getContainerMCPBridges: () => new Map(),
      startSlashInit: vi.fn(async () => ({
        filePath: "/tmp/project/AGENC.md",
        started: true,
      })),
      listAgentRoles,
      launchShellAgentTask,
      inspectShellAgentTask,
      stopShellAgentTask,
      listSubAgentInfo,
    },
    {
      get: () => session,
      getByIdOrSenderId: () => session,
    } as any,
    (value) => value,
    providers as any,
    memoryBackend,
    {
      size: 181,
      listCatalog: () => toolCatalog,
    } as any,
    [],
    [],
    {} as any,
    baseToolHandler as any,
    null,
    undefined,
    undefined,
  );

  return {
    registry,
    session,
    memoryBackend,
    providers,
    getSessionPolicyState,
    listAgentRoles,
    launchShellAgentTask,
    inspectShellAgentTask,
    stopShellAgentTask,
    listSubAgentInfo,
    webChatChannel,
    updateSessionPolicyState,
    baseToolHandler,
    configPath,
    localSkillPath,
    handleConfigReload,
    mcpManager,
    pluginCatalog,
  };
}

async function dispatchAndCollect(
  registry: ReturnType<typeof createDaemonCommandRegistry>,
  command: string,
): Promise<string[]> {
  const replies: string[] = [];
  const handled = await registry.dispatch(
    command,
    "session-1",
    "user-1",
    "webchat",
    async (content) => {
      replies.push(content);
    },
  );
  expect(handled).toBe(true);
  return replies;
}

describe("createDaemonCommandRegistry /context", () => {
  it("reports current-view context pressure with effective-window thresholds", async () => {
    const { registry } = makeCommandRegistry();
    const replies = await dispatchAndCollect(registry, "/context");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Effective Window:");
    expect(replies[0]).toContain("Session Budget: unlimited");
    expect(replies[0]).toContain("Current View:");
    expect(replies[0]).toContain("Autocompact Threshold:");
    expect(replies[0]).toContain(
      "Compaction: local current-view autocompact; provider disabled",
    );
  });
});

describe("createDaemonCommandRegistry /profile", () => {
  it("shows the current shell profile in /status", async () => {
    const { registry } = makeCommandRegistry({
      sessionOverrides: {
        [SESSION_SHELL_PROFILE_METADATA_KEY]: "coding",
        [SESSION_WORKFLOW_STATE_METADATA_KEY]: {
          stage: "plan",
          worktreeMode: "child_optional",
          enteredAt: 1,
          updatedAt: 1,
        },
      },
    });

    const replies = await dispatchAndCollect(registry, "/status");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Shell Profile: coding");
    expect(replies[0]).toContain("Workflow Stage: plan");
    expect(replies[0]).toContain("Worktree Mode: child optional");
  });

  it("lists the available shell profiles", async () => {
    const { registry } = makeCommandRegistry();

    const replies = await dispatchAndCollect(registry, "/profile list");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Shell profile: general");
    expect(replies[0]).toContain("general (current)");
    expect(replies[0]).toContain("coding");
    expect(replies[0]).toContain("operator");
  });

  it("updates the shell profile and persists web session runtime state", async () => {
    const { registry, session, memoryBackend } = makeCommandRegistry();

    const replies = await dispatchAndCollect(registry, "/profile coding");

    expect(session.metadata[SESSION_SHELL_PROFILE_METADATA_KEY]).toBe("coding");
    expect(memoryBackend.set).toHaveBeenCalled();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Shell profile set to coding.");
  });
});

describe("createDaemonCommandRegistry /policy", () => {
  it("shows session allow and deny overrides in policy status", async () => {
    const { registry, getSessionPolicyState } = makeCommandRegistry();
    getSessionPolicyState.mockReturnValue({
      elevatedPatterns: ["system.writeFile"],
      deniedPatterns: ["wallet.*"],
    });

    const replies = await dispatchAndCollect(registry, "/policy status");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Session allow patterns: system.writeFile");
    expect(replies[0]).toContain("Session deny patterns: wallet.*");
  });

  it("updates session allow overrides", async () => {
    const { registry, updateSessionPolicyState } = makeCommandRegistry();

    const replies = await dispatchAndCollect(
      registry,
      "/policy update allow system.writeFile",
    );

    expect(updateSessionPolicyState).toHaveBeenCalledWith({
      sessionId: "session-1",
      operation: "allow",
      pattern: "system.writeFile",
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Policy update: allow system.writeFile");
    expect(replies[0]).toContain("Session allow patterns: system.writeFile");
  });

  it("updates session deny and clear overrides", async () => {
    const { registry, updateSessionPolicyState } = makeCommandRegistry();
    updateSessionPolicyState
      .mockReturnValueOnce({
        elevatedPatterns: [],
        deniedPatterns: ["wallet.*"],
      })
      .mockReturnValueOnce({
        elevatedPatterns: [],
        deniedPatterns: [],
      });

    const denyReplies = await dispatchAndCollect(
      registry,
      "/policy update deny wallet.*",
    );
    const clearReplies = await dispatchAndCollect(
      registry,
      "/policy update clear wallet.*",
    );

    expect(updateSessionPolicyState).toHaveBeenNthCalledWith(1, {
      sessionId: "session-1",
      operation: "deny",
      pattern: "wallet.*",
    });
    expect(updateSessionPolicyState).toHaveBeenNthCalledWith(2, {
      sessionId: "session-1",
      operation: "clear",
      pattern: "wallet.*",
    });
    expect(denyReplies[0]).toContain("Policy update: deny wallet.*");
    expect(denyReplies[0]).toContain("Session deny patterns: wallet.*");
    expect(clearReplies[0]).toContain("Policy update: clear wallet.*");
    expect(clearReplies[0]).toContain("Session deny patterns: none");
  });

  it("resets session overrides", async () => {
    const { registry, updateSessionPolicyState } = makeCommandRegistry();
    updateSessionPolicyState.mockReturnValue({
      elevatedPatterns: [],
      deniedPatterns: [],
    });

    const replies = await dispatchAndCollect(registry, "/policy update reset");

    expect(updateSessionPolicyState).toHaveBeenCalledWith({
      sessionId: "session-1",
      operation: "reset",
      pattern: undefined,
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Policy update: reset");
    expect(replies[0]).toContain("Session allow patterns: none");
    expect(replies[0]).toContain("Session deny patterns: none");
  });
});

describe("createDaemonCommandRegistry /response", () => {
  it("shows the active stored-response status and encrypted reasoning setting", async () => {
    const { registry } = makeCommandRegistry();
    const replies = await dispatchAndCollect(registry, "/response status");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Stored response state:");
    expect(replies[0]).toContain("Replay provider available: yes");
    expect(replies[0]).toContain("Runtime includeEncryptedReasoning: enabled");
    expect(replies[0]).toContain("Current response anchor: resp-anchor-1");
  });

  it("retrieves the latest stored response via the active anchor", async () => {
    const { registry, providers } = makeCommandRegistry();
    const replies = await dispatchAndCollect(registry, "/response get latest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Stored response: resp-anchor-1");
    expect(replies[0]).toContain("stored response content");
    expect(providers[0].retrieveStoredResponse).toHaveBeenCalledWith(
      "resp-anchor-1",
    );
  });

  it("deletes the active stored response and clears the live continuation anchor", async () => {
    const { registry, session, memoryBackend, providers } = makeCommandRegistry();
    const replies = await dispatchAndCollect(registry, "/response delete latest");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Stored response delete: confirmed");
    expect(replies[0]).toContain("Cleared active anchor: yes");
    expect(
      session.metadata[SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY],
    ).toBeUndefined();
    expect(
      session.metadata[SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY],
    ).toBeUndefined();
    expect(memoryBackend.delete).toHaveBeenCalled();
    expect(providers[0].deleteStoredResponse).toHaveBeenCalledWith(
      "resp-anchor-1",
    );
  });

  it("returns raw JSON for stored-response inspection when requested", async () => {
    const { registry } = makeCommandRegistry();
    const replies = await dispatchAndCollect(registry, "/response get latest --json");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("\"id\": \"resp-anchor-1\"");
    expect(replies[0]).toContain("\"output_text\": \"stored response content\"");
  });
});

describe("createDaemonCommandRegistry coding shell commands", () => {
  it("shows workflow stage in the shell session surface", async () => {
    const { registry } = makeCommandRegistry({
      sessionOverrides: {
        [SESSION_WORKFLOW_STATE_METADATA_KEY]: {
          stage: "review",
          worktreeMode: "child_optional",
          objective: "Review the shell workflow",
          enteredAt: 10,
          updatedAt: 20,
        },
      },
    });

    const replies = await dispatchAndCollect(registry, "/session");

    expect(replies[0]).toContain("Workflow stage: review");
    expect(replies[0]).toContain("Worktree mode: child optional");
    expect(replies[0]).toContain("Objective: Review the shell workflow");
  });

  it("lists resumable sessions via /session list", async () => {
    const { registry, webChatChannel } = makeCommandRegistry();

    const replies = await dispatchAndCollect(
      registry,
      '/session list {"activeOnly":true,"limit":5,"profile":"coding"}',
    );

    expect(replies[0]).toContain("Resumable sessions (1):");
    expect(replies[0]).toContain("session-1");
    expect(webChatChannel.listContinuitySessionsForSession).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        activeOnly: true,
        limit: 5,
        shellProfile: "coding",
      }),
    );
  });

  it("shows continuity detail via /session inspect", async () => {
    const { registry, webChatChannel } = makeCommandRegistry();

    const replies = await dispatchAndCollect(registry, "/session inspect session-1");

    expect(replies[0]).toContain("Session detail:");
    expect(replies[0]).toContain("Branch: feature/coding-first-shell");
    expect(webChatChannel.inspectOwnedSession).toHaveBeenCalledWith(
      "session-1",
      "session-1",
    );
  });

  it("shows continuity history via /session history", async () => {
    const { registry, webChatChannel } = makeCommandRegistry();

    const replies = await dispatchAndCollect(
      registry,
      "/session history session-1 --include-tools",
    );

    expect(replies[0]).toContain("Session history (2):");
    expect(replies[0]).toContain("tool system.grep: match");
    expect(webChatChannel.loadOwnedSessionHistory).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        sessionId: "session-1",
        includeTools: true,
      }),
    );
  });

  it("resumes another owned session via /session resume", async () => {
    const { registry, webChatChannel } = makeCommandRegistry();

    const replies = await dispatchAndCollect(registry, "/session resume session-2");

    expect(replies[0]).toContain("Resumed session session-2.");
    expect(webChatChannel.resumeOwnedSession).toHaveBeenCalledWith(
      "session-1",
      "session-2",
    );
  });

  it("forks a session via /session fork", async () => {
    const { registry, webChatChannel } = makeCommandRegistry();

    const replies = await dispatchAndCollect(
      registry,
      "/session fork session-1 --objective Investigate --profile research",
    );

    expect(replies[0]).toContain("Forked session session-fork-1 from session-1.");
    expect(replies[0]).toContain("Use /session resume <sessionId> to switch into the fork.");
    expect(webChatChannel.forkOwnedSessionForRequester).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        sessionId: "session-1",
        objective: "Investigate",
        shellProfile: "research",
      }),
    );
  });

  it("shows repo inventory for /files", async () => {
    const { registry, baseToolHandler } = makeCommandRegistry();

    const replies = await dispatchAndCollect(registry, "/files");

    expect(replies[0]).toContain("Repo inventory:");
    expect(replies[0]).toContain("feature/coding-first-shell");
    expect(baseToolHandler).toHaveBeenCalledWith("system.repoInventory", {});
  });

  it("runs the structured grep command", async () => {
    const { registry, baseToolHandler } = makeCommandRegistry();

    const replies = await dispatchAndCollect(
      registry,
      '/grep {"pattern":"shellProfile"}',
    );

    expect(replies[0]).toContain("src/shell-profile.ts:12:5");
    expect(baseToolHandler).toHaveBeenCalledWith(
      "system.grep",
      expect.objectContaining({ pattern: "shellProfile" }),
    );
  });

  it("runs structured git status and worktree commands", async () => {
    const { registry, baseToolHandler } = makeCommandRegistry();

    const statusReplies = await dispatchAndCollect(registry, "/git status");
    const worktreeReplies = await dispatchAndCollect(
      registry,
      '/worktree {"action":"list"}',
    );

    expect(statusReplies[0]).toContain("Git status:");
    expect(statusReplies[0]).toContain("Changed files: 1");
    expect(worktreeReplies[0]).toContain("Worktrees (1):");
    expect(baseToolHandler).toHaveBeenCalledWith("system.gitStatus", {});
    expect(baseToolHandler).toHaveBeenCalledWith("system.gitWorktreeList", {
      action: "list",
      subcommand: "worktree",
    });
  });

  it("shows task state and MCP state", async () => {
    const { registry, baseToolHandler } = makeCommandRegistry();

    const taskReplies = await dispatchAndCollect(registry, "/tasks list");
    const mcpReplies = await dispatchAndCollect(registry, "/mcp list");

    expect(taskReplies[0]).toContain("Tasks (1):");
    expect(taskReplies[0]).toContain("Ship shell");
    expect(mcpReplies[0]).toContain("Configured servers: 1");
    expect(mcpReplies[0]).toContain("Connected servers: 1");
    expect(mcpReplies[0]).toContain("Visible MCP tools: 1");
    expect(baseToolHandler).toHaveBeenCalledWith("task.list", {
      __agencTaskListId: "session-1",
    });
  });

  it("inspects, validates, reconnects, and disables an MCP server", async () => {
    const { registry, baseToolHandler, configPath, handleConfigReload, mcpManager } =
      makeCommandRegistry();

    const inspectReplies = await dispatchAndCollect(registry, "/mcp inspect demo");
    const validateReplies = await dispatchAndCollect(registry, "/mcp validate demo");
    const reconnectReplies = await dispatchAndCollect(registry, "/mcp reconnect demo");
    const disableReplies = await dispatchAndCollect(registry, "/mcp disable demo");

    expect(inspectReplies[0]).toContain("MCP server: demo");
    expect(inspectReplies[0]).toContain("Visible tools: 1");
    expect(validateReplies[0]).toContain("MCP validate: demo");
    expect(validateReplies[0]).toContain("Catalog integrity: not configured");
    expect(reconnectReplies[0]).toContain('MCP server "demo" reconnected (1 tools).');
    expect(disableReplies[0]).toContain('MCP server "demo" disabled via config reload.');
    expect(baseToolHandler).not.toHaveBeenCalledWith("mcp.reconnect", expect.anything());
    expect(mcpManager.reconnectServer).toHaveBeenCalledWith("demo");
    expect(handleConfigReload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(configPath, "utf8")).mcp.servers[0].enabled).toBe(false);
  });

  it("shows local skill inventory, sources, and toggle state", async () => {
    const { registry, localSkillPath } = makeCommandRegistry();

    const listReplies = await dispatchAndCollect(registry, "/skills list");
    const inspectReplies = await dispatchAndCollect(registry, "/skills inspect local-skill");
    const sourcesReplies = await dispatchAndCollect(registry, "/skills sources");
    const disableReplies = await dispatchAndCollect(registry, "/skills disable local-skill");

    expect(listReplies[0]).toContain("Local skills:");
    expect(listReplies[0]).toContain("local-skill");
    expect(listReplies[0]).toContain("Marketplace listings: use `agenc market skills ...`.");
    expect(inspectReplies[0]).toContain("Skill: local-skill");
    expect(inspectReplies[0]).toContain("Tier: project");
    expect(sourcesReplies[0]).toContain("Skill discovery sources:");
    expect(sourcesReplies[0]).toContain("Agent: not configured");
    expect(disableReplies[0]).toContain('Skill "local-skill" disabled.');
    expect(existsSync(`${localSkillPath}.disabled`)).toBe(true);
  });

  it("lists, inspects, and toggles the shell plugin catalog", async () => {
    const { registry } = makeCommandRegistry();

    const listReplies = await dispatchAndCollect(registry, "/plugin list");
    const inspectReplies = await dispatchAndCollect(
      registry,
      "/plugin inspect agenc.demo.plugin",
    );
    const disableReplies = await dispatchAndCollect(
      registry,
      "/plugin disable agenc.demo.plugin",
    );

    expect(listReplies[0]).toContain("Plugin catalog:");
    expect(listReplies[0]).toContain("agenc.demo.plugin");
    expect(inspectReplies[0]).toContain("Plugin: agenc.demo.plugin");
    expect(inspectReplies[0]).toContain("Display name: Demo Plugin");
    expect(disableReplies[0]).toContain('Plugin "agenc.demo.plugin" disabled');
    expect(disableReplies[0]).toContain("Catalog updated. Live plugin effects depend");
  });

  it("shows the shell agent role catalog and active child agents", async () => {
    const { registry, listAgentRoles, listSubAgentInfo } = makeCommandRegistry();

    const roleReplies = await dispatchAndCollect(registry, "/agents roles");
    const listReplies = await dispatchAndCollect(registry, "/agents list");

    expect(roleReplies[0]).toContain("Child-agent roles (3):");
    expect(roleReplies[0]).toContain("coding");
    expect(roleReplies[0]).toContain("verification-probes");
    expect(listReplies[0]).toContain("Child agents (1):");
    expect(listReplies[0]).toContain("child-coding-1");
    expect(listReplies[0]).toContain("role=coding");
    expect(listAgentRoles).toHaveBeenCalled();
    expect(listSubAgentInfo).toHaveBeenCalledWith("session-1");
  });

  it("spawns, inspects, assigns, and stops child agents through the shared launcher", async () => {
    const {
      registry,
      launchShellAgentTask,
      inspectShellAgentTask,
      stopShellAgentTask,
      baseToolHandler,
    } = makeCommandRegistry();

    const spawnReplies = await dispatchAndCollect(
      registry,
      '/agents {"subcommand":"spawn","roleId":"coding","objective":"Implement the task","profile":"coding","toolBundle":"coding-core","worktree":"auto","wait":true}',
    );
    const inspectReplies = await dispatchAndCollect(
      registry,
      "/agents inspect child-coding-1",
    );
    const assignReplies = await dispatchAndCollect(
      registry,
      '/agents {"subcommand":"assign","taskId":"1","roleId":"verify","wait":true}',
    );
    const stopReplies = await dispatchAndCollect(
      registry,
      "/agents stop task-coding-1",
    );

    expect(spawnReplies[0]).toContain("Coding agent child-coding-1 [completed]");
    expect(spawnReplies[0]).toContain("Task: task-coding-1");
    expect(assignReplies[0]).toContain("Verifier agent child-verify-1 [completed]");
    expect(inspectReplies[0]).toContain("Child agent:");
    expect(inspectReplies[0]).toContain("Tool bundle: coding-core");
    expect(stopReplies[0]).toContain("Stopped child agent child-coding-1. Task task-coding-1.");
    expect(launchShellAgentTask).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        parentSessionId: "session-1",
        roleId: "coding",
        objective: "Implement the task",
        shellProfile: "coding",
        toolBundle: "coding-core",
        worktree: "auto",
        wait: true,
      }),
    );
    expect(baseToolHandler).toHaveBeenCalledWith("task.get", {
      __agencTaskListId: "session-1",
      taskId: "1",
    });
    expect(launchShellAgentTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        parentSessionId: "session-1",
        taskId: "1",
        roleId: "verify",
        objective: "Ship shell",
        wait: true,
      }),
    );
    expect(inspectShellAgentTask).toHaveBeenCalledWith("session-1", "child-coding-1");
    expect(stopShellAgentTask).toHaveBeenCalledWith("session-1", "task-coding-1");
  });

  it("shows and updates reasoning effort", async () => {
    const { registry } = makeCommandRegistry();

    const statusReplies = await dispatchAndCollect(registry, "/effort");
    const updateReplies = await dispatchAndCollect(registry, "/effort high");

    expect(statusReplies[0]).toContain("Reasoning effort:");
    expect(updateReplies[0]).toContain("Reasoning effort switched: medium → high");
  });

  it("enters plan mode with a coding-default child worktree posture", async () => {
    const { registry, session, memoryBackend } = makeCommandRegistry({
      sessionOverrides: {
        [SESSION_SHELL_PROFILE_METADATA_KEY]: "coding",
      },
    });

    const replies = await dispatchAndCollect(
      registry,
      '/plan {"subcommand":"enter","objective":"Ship Phase 4"}',
    );

    expect(replies[0]).toContain("Workflow stage set to plan.");
    expect(replies[0]).toContain("Worktree mode: child optional");
    expect(replies[0]).toContain("Objective: Ship Phase 4");
    expect(session.metadata[SESSION_WORKFLOW_STATE_METADATA_KEY]).toMatchObject({
      stage: "plan",
      worktreeMode: "child_optional",
      objective: "Ship Phase 4",
    });
    expect(memoryBackend.set).toHaveBeenCalled();
  });

  it("only allows /plan exit from plan mode", async () => {
    const { registry } = makeCommandRegistry({
      sessionOverrides: {
        [SESSION_WORKFLOW_STATE_METADATA_KEY]: {
          stage: "idle",
          worktreeMode: "off",
          enteredAt: 1,
          updatedAt: 1,
        },
      },
    });

    const replies = await dispatchAndCollect(registry, "/plan exit");

    expect(replies[0]).toContain(
      "Workflow exit is only available while the session is in plan mode.",
    );
  });

  it("delegates review through the restricted reviewer child without silently changing the stage", async () => {
    const { registry, launchShellAgentTask } = makeCommandRegistry();

    const replies = await dispatchAndCollect(registry, '/review {"delegate":true}');

    expect(replies[0]).toContain("Review surface:");
    expect(replies[0]).toContain("Delegated reviewer session: child-review-1 [completed]");
    expect(replies[0]).toContain("review complete");
    expect(launchShellAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        roleId: "review",
        parentSessionId: "session-1",
        wait: true,
      }),
    );
  });

  it("delegates verification through the restricted verifier child", async () => {
    const { registry, launchShellAgentTask } = makeCommandRegistry();

    const replies = await dispatchAndCollect(registry, '/verify {"delegate":true}');

    expect(replies[0]).toContain("Verification surface:");
    expect(replies[0]).toContain("Delegated verifier session: child-verify-1 [completed]");
    expect(replies[0]).toContain("verify complete");
    expect(launchShellAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        roleId: "verify",
        parentSessionId: "session-1",
        wait: true,
      }),
    );
  });

  it("holds back coding commands when rollout disables them", async () => {
    const { registry } = makeCommandRegistry({
      gatewayAutonomyOverrides: {
        featureFlags: {
          backgroundRuns: true,
          multiAgent: true,
          notifications: true,
          replayGates: true,
          canaryRollout: false,
          shellProfiles: true,
          codingCommands: false,
          shellExtensions: true,
          watchCockpit: true,
        },
      },
    });

    const replies = await dispatchAndCollect(registry, "/files");

    expect(replies[0]).toContain("Files command is unavailable for this session because rollout policy is holding it back.");
  });

  it("holds back shell extensions when rollout disables them", async () => {
    const { registry } = makeCommandRegistry({
      gatewayAutonomyOverrides: {
        featureFlags: {
          backgroundRuns: true,
          multiAgent: true,
          notifications: true,
          replayGates: true,
          canaryRollout: false,
          shellProfiles: true,
          codingCommands: true,
          shellExtensions: false,
          watchCockpit: true,
        },
      },
    });

    const replies = await dispatchAndCollect(registry, "/mcp list");

    expect(replies[0]).toContain("MCP command is unavailable for this session because rollout policy is holding it back.");
  });

  it("holds back shell multi-agent orchestration when rollout disables it", async () => {
    const { registry } = makeCommandRegistry({
      gatewayAutonomyOverrides: {
        featureFlags: {
          backgroundRuns: true,
          multiAgent: false,
          notifications: true,
          replayGates: true,
          canaryRollout: false,
          shellProfiles: true,
          codingCommands: true,
          shellExtensions: true,
          watchCockpit: true,
        },
      },
    });

    const replies = await dispatchAndCollect(registry, "/agents list");

    expect(replies[0]).toContain("Agents command is unavailable for this session because rollout policy is holding it back.");
  });

  it("coerces non-general profiles to general when shell profiles are held back", async () => {
    const { registry, session } = makeCommandRegistry({
      gatewayAutonomyOverrides: {
        featureFlags: {
          backgroundRuns: true,
          multiAgent: true,
          notifications: true,
          replayGates: true,
          canaryRollout: false,
          shellProfiles: false,
          codingCommands: true,
          shellExtensions: true,
          watchCockpit: true,
        },
      },
    });

    const replies = await dispatchAndCollect(registry, "/profile coding");

    expect(replies[0]).toContain("Shell profile set to general.");
    expect(session.metadata[SESSION_SHELL_PROFILE_METADATA_KEY]).toBe("general");
  });
});
