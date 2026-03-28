import { describe, expect, it, vi } from "vitest";

import { silentLogger } from "../utils/logger.js";
import { createDaemonCommandRegistry } from "./daemon-command-registry.js";
import {
  SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY,
  SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY,
} from "./session.js";

function makeCommandRegistry(params?: {
  providerOverrides?: Array<Record<string, unknown>>;
  sessionOverrides?: Record<string, unknown>;
  memoryBackendOverrides?: Record<string, unknown>;
  gatewayLlmOverrides?: Record<string, unknown>;
}) {
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

  const registry = createDaemonCommandRegistry(
    {
      logger: silentLogger,
      configPath: "/tmp/config.json",
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
        },
      },
      yolo: false,
      resetWebSessionContext: vi.fn(async () => {}),
      getWebChatChannel: () => null,
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
      handleConfigReload: vi.fn(async () => {}),
      getVoiceBridge: () => null,
      getDesktopManager: () => null,
      getDesktopBridges: () => new Map(),
      getPlaywrightBridges: () => new Map(),
      getContainerMCPBridges: () => new Map(),
      getGoalManager: () => null,
      startSlashInit: vi.fn(async () => ({
        filePath: "/tmp/project/AGENC.md",
        started: true,
      })),
    },
    {
      get: () => session,
    } as any,
    (value) => value,
    providers as any,
    memoryBackend,
    { size: 181 } as any,
    [],
    [],
    {} as any,
    {} as any,
    null,
    undefined,
    undefined,
  );

  return {
    registry,
    session,
    memoryBackend,
    providers,
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
  it("reports a finite local compaction window even when the hard session budget is unlimited", async () => {
    const { registry } = makeCommandRegistry();
    const replies = await dispatchAndCollect(registry, "/context");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Session Budget: unlimited");
    expect(replies[0]).toContain("Free: 574,864 tokens");
    expect(replies[0]).toContain(
      "Compaction: local enabled @ 600,000 tokens; provider disabled",
    );
  });
});

describe("createDaemonCommandRegistry /response", () => {
  it("shows the active stored-response status and encrypted reasoning setting", async () => {
    const { registry } = makeCommandRegistry();
    const replies = await dispatchAndCollect(registry, "/response status");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Retrieval supported: yes");
    expect(replies[0]).toContain("Deletion supported: yes");
    expect(replies[0]).toContain("Encrypted reasoning support: yes");
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
