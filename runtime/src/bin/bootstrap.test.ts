import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../services/api/sessionIngress.js", () => ({
  appendSessionLog: vi.fn(async () => true),
  getSessionLogs: vi.fn(async () => []),
  getSessionLogsViaOAuth: vi.fn(async () => []),
  getTeleportEvents: vi.fn(async () => ({ data: [] })),
  clearSession: vi.fn(),
  clearAllSessions: vi.fn(),
}));

import {
  bootstrapLocalRuntimeSession,
  readStartupCliFlags,
  resolveStartupSelection,
} from "./bootstrap.js";
import { defaultConfig, mergeConfigs } from "../config/index.js";
import type { Tool } from "../tools/types.js";
import { Session } from "../session/session.js";
import { getProjectDir } from "../session/session-store.js";
import { getCurrentRuntimeSession } from "../utils/currentRuntimeSession.js";
import { flushSessionStorage } from "../utils/sessionStorage.js";
import {
  getContextCollapseCommits,
  getContextCollapseSnapshot,
  resetContextCollapse,
  restoreContextCollapseState,
} from "../session/_deps/context-collapse.js";

describe("resolveStartupSelection", () => {
  it("applies CLI provider/model/profile ahead of env and config", () => {
    const config = mergeConfigs(defaultConfig(), {
      model: "grok-3",
      model_provider: "grok",
      profiles: {
        strict: {
          model: "claude-opus-4-7",
          model_provider: "anthropic",
          approval_policy: "never",
        },
        fast: {
          model: "gpt-5",
          model_provider: "openai",
          sandbox_mode: "read-only",
        },
      },
    });

    const resolved = resolveStartupSelection({
      config,
      env: {
        AGENC_PROVIDER: "anthropic",
        AGENC_MODEL: "claude-opus-4-7",
        AGENC_PROFILE: "strict",
        OPENAI_API_KEY: "openai-env-key",
      },
      argv: [
        "node",
        "agenc",
        "--provider",
        "openai",
        "--model",
        "gpt-5",
        "--profile",
        "fast",
      ],
    });

    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("gpt-5");
    expect(resolved.profileName).toBe("fast");
    expect(resolved.config.approval_policy).toBe("on-request");
    expect(resolved.config.sandbox_mode).toBe("read-only");
    expect(resolved.apiKey).toBe("openai-env-key");
  });

  it("applies env profile/provider/model ahead of base config", () => {
    const config = mergeConfigs(defaultConfig(), {
      model: "grok-3",
      model_provider: "grok",
      profiles: {
        remote: {
          model: "gpt-5",
          model_provider: "openai",
        },
      },
    });

    const resolved = resolveStartupSelection({
      config,
      env: {
        AGENC_PROFILE: "remote",
        OPENAI_API_KEY: "openai-env-key",
      },
      argv: ["node", "agenc"],
    });

    expect(resolved.profileName).toBe("remote");
    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("gpt-5");
    expect(resolved.apiKey).toBe("openai-env-key");
  });

  it("uses provider defaults when only a provider is selected", () => {
    const resolved = resolveStartupSelection({
      config: defaultConfig(),
      env: {
        AGENC_PROVIDER: "openai",
        OPENAI_API_KEY: "openai-env-key",
      },
      argv: ["node", "agenc"],
    });

    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("gpt-5");
  });
});

describe("readStartupCliFlags", () => {
  it("parses permission startup flags, including the yolo aliases", () => {
    expect(
      readStartupCliFlags([
        "node",
        "agenc",
        "--permission-mode",
        "plan",
        "--yolo",
      ]),
    ).toMatchObject({
      permissionMode: "plan",
      allowDangerouslySkipPermissions: true,
    });

    expect(
      readStartupCliFlags([
        "node",
        "agenc",
        "--dangerously-bypass-approvals-and-sandbox",
      ]),
    ).toMatchObject({
      allowDangerouslySkipPermissions: true,
    });

    expect(
      readStartupCliFlags([
        "node",
        "agenc",
        "--allow-dangerously-skip-permissions",
      ]),
    ).toMatchObject({
      allowDangerouslySkipPermissions: true,
    });
  });
});

describe("bootstrapLocalRuntimeSession", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetContextCollapse();
  });

  it("builds the shared local bootstrap contract and forwards registry customizations", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const extraTool: Tool = {
      name: "system.test.extra",
      description: "test helper",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ content: "ok" }),
    };

    const providerMod = await import("../llm/provider.js");
    const createProviderSpy = vi
      .spyOn(providerMod, "createProvider")
      .mockImplementation(
        () =>
          ({
            name: "stub",
            chat: async () => ({
              content: "ok",
              toolCalls: [],
              usage: {
                promptTokens: 1,
                completionTokens: 1,
                totalTokens: 2,
              },
            }),
          }) as never,
      );
    const startMcpSpy = vi
      .spyOn(Session.prototype, "startMcpManager")
      .mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
        cwd: "/ignored-by-env",
        toolRegistryOptions: {
          extraTools: [extraTool],
        },
      });
      shutdown = boot.shutdown;

      expect(boot.agencHome).toBe(home);
      expect(boot.workspaceRoot).toBe(workspace);
      expect(boot.resolvedProvider).toBe("grok");
      expect(boot.model).toBe("grok-4-fast");
      expect(boot.registry.tools.some((tool) => tool.name === extraTool.name)).toBe(
        true,
      );
      expect(createProviderSpy).toHaveBeenCalledWith(
        "grok",
        expect.objectContaining({
          apiKey: "test-key",
          model: "grok-4-fast",
          tools: expect.any(Array),
        }),
      );
      expect(boot.initialState.sessionConfiguration.cwd).toBe(workspace);
      expect(boot.initialState.sessionConfiguration.sessionSource).toBe(
        "cli_main",
      );
      expect(startMcpSpy).toHaveBeenCalledWith(boot.mcpManager);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("falls back to the explicit cwd when no workspace override is configured", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "agenc-bootstrap-cwd-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          }),
        }) as never,
    );
    const startMcpSpy = vi
      .spyOn(Session.prototype, "startMcpManager")
      .mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          HOME: home,
        },
        cwd,
      });
      shutdown = boot.shutdown;
      expect(boot.workspaceRoot).toBe(cwd);
      expect(startMcpSpy).toHaveBeenCalledWith(boot.mcpManager);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("resolves provider-specific startup auth from the selected provider instead of forcing xAI", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    const createProviderSpy = vi
      .spyOn(providerMod, "createProvider")
      .mockImplementation(
        () =>
          ({
            name: "stub",
            chat: async () => ({
              content: "ok",
              toolCalls: [],
              usage: {
                promptTokens: 1,
                completionTokens: 1,
                totalTokens: 2,
              },
            }),
          }) as never,
      );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          AGENC_PROVIDER: "openai",
          OPENAI_API_KEY: "openai-test-key",
          HOME: home,
        },
        argv: ["node", "agenc", "--provider", "openai"],
      });
      shutdown = boot.shutdown;

      expect(boot.resolvedProvider).toBe("openai");
      expect(boot.model).toBe("gpt-5");
      expect(createProviderSpy).toHaveBeenCalledWith(
        "openai",
        expect.objectContaining({
          apiKey: "openai-test-key",
          model: "gpt-5",
          tools: expect.any(Array),
        }),
      );
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("hydrates the session permission registry from disk settings", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    await mkdir(join(home, ".agenc"), { recursive: true });
    await writeFile(
      join(home, ".agenc", "settings.json"),
      JSON.stringify(
        {
          permissions: {
            defaultMode: "acceptEdits",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          }),
        }) as never,
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      expect(boot.session.permissionModeRegistry.current().mode).toBe(
        "acceptEdits",
      );
      expect(
        boot.session.sessionConfiguration.permissionContext?.mode,
      ).toBe("acceptEdits");
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reuses an explicit conversationId when resume bootstraps an existing session", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          }),
        }) as never,
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId: "conv-resume-123",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      expect(boot.conversationId).toBe("conv-resume-123");
      expect(boot.session.conversationId).toBe("conv-resume-123");
      expect(boot.rolloutStore.rolloutPath).toContain("conv-resume-123");
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("hydrates reconstructed history and seeded transcript events when resuming", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          }),
        }) as never,
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let firstShutdown: (() => Promise<void>) | null = null;
    let secondShutdown: (() => Promise<void>) | null = null;
    try {
      const first = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId: "conv-resume-hydrated",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      firstShutdown = first.shutdown;

      first.rolloutStore.appendRollout({
        type: "response_item",
        payload: { role: "user", content: "hello" },
      });
      first.rolloutStore.appendRollout({
        type: "response_item",
        payload: { role: "assistant", content: "hi" },
      });
      first.rolloutStore.appendRollout({
        type: "turn_context",
        payload: {
          turnId: "turn-resume",
          cwd: workspace,
          approvalPolicy: "never",
          sandboxPolicy: "read_only",
          model: "grok-4-fast",
          realtimeActive: true,
        },
      });
      first.session.emit({
        id: first.session.nextInternalSubId(),
        msg: { type: "user_message", payload: { message: "hello" } },
      });
      first.session.emit({
        id: first.session.nextInternalSubId(),
        msg: { type: "agent_message", payload: { message: "hi" } },
      });
      await flushSessionStorage();
      first.rolloutStore.flushDurable();
      await first.shutdown();
      firstShutdown = null;

      const transcriptPath = join(
        getProjectDir(workspace),
        "conv-resume-hydrated.jsonl",
      );
      await mkdir(getProjectDir(workspace), { recursive: true });
      await appendFile(
        transcriptPath,
        [
          JSON.stringify({
            type: "marble-origami-commit",
            sessionId: "conv-resume-hydrated",
            collapseId: "0000000000000007",
            summaryUuid: "resume-summary-uuid",
            summaryContent:
              '<collapsed id="0000000000000007">Earlier conversation collapsed.</collapsed>',
            summary: "Earlier conversation collapsed.",
            firstArchivedUuid: "resume-first-archived",
            lastArchivedUuid: "resume-last-archived",
          }),
          JSON.stringify({
            type: "marble-origami-snapshot",
            sessionId: "conv-resume-hydrated",
            staged: [],
            armed: true,
            lastSpawnTokens: 42,
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      restoreContextCollapseState(
        [
          {
            type: "marble-origami-commit",
            sessionId: "stale-session" as never,
            collapseId: "0000000000009999",
            summaryUuid: "stale-summary-uuid",
            summaryContent:
              '<collapsed id="0000000000009999">stale in-memory state</collapsed>',
            summary: "stale in-memory state",
            firstArchivedUuid: "stale-first",
            lastArchivedUuid: "stale-last",
          },
        ],
        {
          type: "marble-origami-snapshot",
          sessionId: "stale-session" as never,
          staged: [],
          armed: false,
          lastSpawnTokens: 7,
        },
      );

      const resumed = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId: "conv-resume-hydrated",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      secondShutdown = resumed.shutdown;

      expect(resumed.initialState.history).toEqual([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]);
      expect(resumed.initialState.previousTurnSettings).toEqual({
        model: "grok-4-fast",
        realtimeActive: true,
      });
      expect(resumed.initialState.referenceContextItem).toEqual(
        expect.objectContaining({
          turnId: "turn-resume",
          model: "grok-4-fast",
          realtimeActive: true,
        }),
      );
      expect(
        (resumed.session as unknown as {
          getInitialTranscriptEvents(): Array<{ type: string; payload: unknown }>;
        }).getInitialTranscriptEvents(),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "user_message",
            payload: expect.objectContaining({ message: "hello" }),
          }),
          expect.objectContaining({
            type: "agent_message",
            payload: expect.objectContaining({ message: "hi" }),
          }),
        ]),
      );
      resumed.rolloutStore.flushDurable();
      expect(
        resumed.rolloutStore.readAll().some(
          (item) =>
            item.type === "event_msg" &&
            item.payload.msg.type === "session_configured" &&
            item.payload.msg.payload.initialMessages.length >= 2,
        ),
      ).toBe(true);
      expect(getContextCollapseCommits()).toEqual([
        expect.objectContaining({
          collapseId: "0000000000000007",
          summaryUuid: "resume-summary-uuid",
          firstArchivedUuid: "resume-first-archived",
          lastArchivedUuid: "resume-last-archived",
        }),
      ]);
      expect(getContextCollapseSnapshot()).toEqual(
        expect.objectContaining({
          armed: true,
          lastSpawnTokens: 42,
        }),
      );
    } finally {
      await secondShutdown?.().catch(() => {
        /* best effort */
      });
      await firstShutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("clears stale context-collapse state on fresh bootstrap without resume", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          }),
        }) as never,
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    restoreContextCollapseState(
      [
        {
          type: "marble-origami-commit",
          sessionId: "stale-session" as never,
          collapseId: "0000000000009999",
          summaryUuid: "stale-summary-uuid",
          summaryContent:
            '<collapsed id="0000000000009999">stale in-memory state</collapsed>',
          summary: "stale in-memory state",
          firstArchivedUuid: "stale-first",
          lastArchivedUuid: "stale-last",
        },
      ],
      {
        type: "marble-origami-snapshot",
        sessionId: "stale-session" as never,
        staged: [],
        armed: true,
        lastSpawnTokens: 11,
      },
    );

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      expect(getContextCollapseCommits()).toEqual([]);
      expect(getContextCollapseSnapshot()).toBeUndefined();
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("hydrates the live MCP manager from AGENC_MCP_SERVERS before session startup", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          }),
        }) as never,
    );
    const startMcpSpy = vi
      .spyOn(Session.prototype, "startMcpManager")
      .mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          AGENC_MCP_SERVERS: JSON.stringify([
            { name: "github", command: "github-mcp" },
          ]),
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      expect(boot.mcpManager.getConfiguredServers()).toEqual([
        expect.objectContaining({ name: "github", command: "github-mcp" }),
      ]);
      expect(startMcpSpy).toHaveBeenCalledWith(boot.mcpManager);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("wires the session-facing MCP service to the live manager readiness surface", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          }),
        }) as never,
    );

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      const mcpService = (
        boot.session as unknown as { services: { mcpManager: { isConnected?: unknown } } }
      ).services.mcpManager;

      expect(typeof mcpService.isConnected).toBe("function");
      expect(mcpService.isConnected?.("missing-server")).toBe(false);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("owns live session bring-up and teardown for rollout, sidecars, and current-session state", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          }),
        }) as never,
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      expect(getCurrentRuntimeSession()).toBe(boot.session);
      expect(boot.sidecarManager.getSidecarNames()).toEqual(
        expect.arrayContaining([
          "file-history",
          "error-log",
          "cost",
          "memory-auto-save",
        ]),
      );
      expect(boot.rolloutStore.rolloutPath).toContain(boot.conversationId);
      expect(boot.ctx.turnMetadataState.conversationId).toBe(
        boot.conversationId,
      );
      boot.rolloutStore.flushDurable();
      expect(
        boot.rolloutStore.readAll().some(
          (item) =>
            item.type === "event_msg" &&
            item.payload.msg.type === "session_configured",
        ),
      ).toBe(true);

      await boot.shutdown();
      await boot.shutdown();

      expect(getCurrentRuntimeSession()).toBeNull();
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("bootstraps the real agent control plane, registers /root, and tears it down through lifecycle shutdown", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          }),
        }) as never,
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      const { ensureAgentControl } = await import("./delegate-tool.js");
      const { control } = ensureAgentControl(boot.session);
      const shutdownAllSpy = vi
        .spyOn(control, "shutdownAll")
        .mockResolvedValue(undefined);

      const child = await control.spawn({ parentPath: "/root" });
      expect(
        boot.rolloutStore
          .listThreadSpawnChildrenWithStatus(boot.conversationId, "open")
          .map((edge) => edge.childThreadId),
      ).toContain(child.agentId);

      await boot.shutdown();
      shutdown = null;

      expect(shutdownAllSpy).toHaveBeenCalledWith("session_shutdown");
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("boots in bypassPermissions when started with --yolo", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          }),
        }) as never,
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
        argv: ["node", "agenc", "--yolo"],
      });
      shutdown = boot.shutdown;

      expect(boot.session.permissionModeRegistry.current().mode).toBe(
        "bypassPermissions",
      );
      expect(
        boot.session.permissionModeRegistry.current()
          .isBypassPermissionsModeAvailable,
      ).toBe(true);
      expect(boot.initialState.sessionConfiguration.approvalPolicy.value).toBe(
        "never",
      );
      expect(boot.initialState.sessionConfiguration.sandboxPolicy.value).toBe(
        "danger_full_access",
      );
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("boots in the requested mode when started with --permission-mode", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => ({
            content: "ok",
            toolCalls: [],
            usage: {
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          }),
        }) as never,
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
        argv: ["node", "agenc", "--permission-mode", "plan"],
      });
      shutdown = boot.shutdown;

      expect(boot.session.permissionModeRegistry.current().mode).toBe("plan");
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
