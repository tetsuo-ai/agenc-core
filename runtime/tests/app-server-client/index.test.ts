import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

import {
  dispatchSlashCommand,
  parseSlashCommand,
} from "../commands/dispatcher.js";
import { readConfigMenuSnapshot } from "../commands/config-menu.js";
import { buildDefaultRegistry } from "../commands/registry.js";
import type { SlashCommandContext } from "../commands/types.js";
import type { ConfigStore } from "../config/store.js";
import {
  applyDaemonTuiRuntimeSettingsAuthority,
  createAgenCDaemonOnlyTuiContext,
  findAgenCDaemonAgentBySessionId,
  listAgenCDaemonAgents,
} from "./index.js";
import { resolveAgentRuntimeOptions } from "../session/runtime-options.js";
import {
  registerSandboxExecutionLifecycleParticipant,
} from "../sandbox/execution-lifecycle.js";

function createListClient(
  pages: Array<{
    readonly agents: readonly {
      readonly agentId: string;
      readonly status: "idle" | "running" | "stopping" | "stopped" | "error";
      readonly createdAt: string;
      readonly activeSessionIds?: readonly string[];
      readonly metadata?: Record<string, unknown>;
    }[];
    readonly nextCursor?: string;
  }>,
) {
  let index = 0;
  return {
    request: vi.fn(async () => pages[Math.min(index++, pages.length - 1)]),
    subscribeToSessionEvents: vi.fn(() => () => undefined),
    getConnectionState: vi.fn(() => ({ status: "connected" })),
    subscribeToConnectionState: vi.fn(() => () => undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("app-server-client daemon helpers", () => {
  it("collects daemon agent pages until the cursor ends", async () => {
    const client = createListClient([
      {
        agents: [
          {
            agentId: "agent_1",
            status: "running",
            createdAt: "2026-05-06T00:00:00.000Z",
          },
        ],
        nextCursor: "page_2",
      },
      {
        agents: [
          {
            agentId: "agent_2",
            status: "idle",
            createdAt: "2026-05-06T00:00:01.000Z",
          },
        ],
      },
    ]);

    await expect(listAgenCDaemonAgents(client as never)).resolves.toEqual([
      expect.objectContaining({ agentId: "agent_1" }),
      expect.objectContaining({ agentId: "agent_2" }),
    ]);
    expect(client.request).toHaveBeenNthCalledWith(1, "agent.list", {
      limit: 100,
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "agent.list", {
      limit: 100,
      cursor: "page_2",
    });
  });

  it("rejects repeated cursors instead of looping forever", async () => {
    const client = createListClient([
      { agents: [], nextCursor: "same" },
      { agents: [], nextCursor: "same" },
    ]);

    await expect(listAgenCDaemonAgents(client as never)).rejects.toThrow(
      "repeated agent list cursor",
    );
  });

  it("caps daemon agent pagination", async () => {
    const client = createListClient([
      { agents: [], nextCursor: "page_2" },
      { agents: [], nextCursor: "page_3" },
    ]);

    await expect(
      listAgenCDaemonAgents(client as never, { maxPages: 1 }),
    ).rejects.toThrow("exceeded pagination limit");
  });

  it("rejects ambiguous daemon session matches", async () => {
    const client = createListClient([
      {
        agents: [
          {
            agentId: "agent_1",
            status: "running",
            createdAt: "2026-05-06T00:00:00.000Z",
            activeSessionIds: ["session_shared"],
          },
          {
            agentId: "agent_2",
            status: "running",
            createdAt: "2026-05-06T00:00:01.000Z",
            activeSessionIds: ["session_shared"],
          },
        ],
      },
    ]);

    await expect(
      findAgenCDaemonAgentBySessionId(client as never, "session_shared"),
    ).rejects.toThrow("matches multiple agents");
  });

  it("prefers the exact canonical agent id over a session alias", async () => {
    const client = createListClient([
      {
        agents: [
          {
            agentId: "agent_alias_owner",
            status: "running",
            createdAt: "2026-05-06T00:00:00.000Z",
            activeSessionIds: ["conv-canonical1"],
          },
          {
            agentId: "conv-canonical1",
            status: "running",
            createdAt: "2026-05-06T00:00:01.000Z",
            activeSessionIds: ["session_runtime"],
          },
        ],
      },
    ]);

    await expect(
      findAgenCDaemonAgentBySessionId(client as never, "conv-canonical1"),
    ).resolves.toMatchObject({ agentId: "conv-canonical1" });
  });

  it("rolls back the skills watcher when daemon-only setup fails", async () => {
    vi.resetModules();
    const watcherStart = vi.fn().mockResolvedValue(undefined);
    const watcherStop = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../skills/local-loader.js", async (importActual) => {
      const actual =
        await importActual<typeof import("../skills/local-loader.js")>();
      return {
        ...actual,
        createLocalSkillsServices: vi.fn(() => ({
          skillsManager: {},
          pluginsManager: {},
          skillsWatcher: { start: watcherStart, stop: watcherStop },
        })),
      };
    });
    vi.doMock("../tools/AgentTool/loadAgentsDir.js", async (importActual) => {
      const actual =
        await importActual<
          typeof import("../tools/AgentTool/loadAgentsDir.js")
        >();
      return {
        ...actual,
        loadFreshAgentDefinitions: vi
          .fn()
          .mockRejectedValue(new Error("agent definition setup failed")),
      };
    });
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-setup-fail-home-"));
    const workspace = mkdtempSync(
      join(tmpdir(), "agenc-setup-fail-workspace-"),
    );
    try {
      const module = await import("./index.js");
      await expect(
        module.createAgenCDaemonOnlyTuiContext({
          env: { AGENC_HOME: agencHome, HOME: agencHome },
          cwd: workspace,
          conversationId: "agenc-tui-setup-failure",
        }),
      ).rejects.toThrow("agent definition setup failed");

      expect(watcherStart).toHaveBeenCalledOnce();
      expect(watcherStop).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("../skills/local-loader.js");
      vi.doUnmock("../tools/AgentTool/loadAgentsDir.js");
      vi.resetModules();
      rmSync(agencHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("finds a live canonical conversation id and ignores persisted-only rows", async () => {
    const live = createListClient([
      {
        agents: [
          {
            agentId: "conv-livecanonical1",
            status: "running",
            createdAt: "2026-08-19T00:00:00.000Z",
            activeSessionIds: ["session_runtime_envelope"],
          },
        ],
      },
    ]);
    await expect(
      findAgenCDaemonAgentBySessionId(live as never, "conv-livecanonical1"),
    ).resolves.toMatchObject({ agentId: "conv-livecanonical1" });

    const persisted = createListClient([
      {
        agents: [
          {
            agentId: "conv-coldcanonical1",
            status: "idle",
            createdAt: "2026-08-19T00:00:00.000Z",
            activeSessionIds: ["conv-coldcanonical1"],
            metadata: { recovered: true },
          },
        ],
      },
    ]);
    await expect(
      findAgenCDaemonAgentBySessionId(
        persisted as never,
        "conv-coldcanonical1",
      ),
    ).resolves.toBeNull();

    const recoveredLive = createListClient([
      {
        agents: [
          {
            agentId: "conv-recoveredlive1",
            status: "running",
            createdAt: "2026-08-19T00:00:00.000Z",
            metadata: {
              recovered: true,
              recovery: { runtimeRestore: "available" },
            },
          },
        ],
      },
    ]);
    await expect(
      findAgenCDaemonAgentBySessionId(
        recoveredLive as never,
        "conv-recoveredlive1",
      ),
    ).resolves.toMatchObject({ agentId: "conv-recoveredlive1" });

    const stopped = createListClient([
      {
        agents: [
          {
            agentId: "conv-stoppedcold1",
            status: "stopped",
            createdAt: "2026-08-19T00:00:00.000Z",
            activeSessionIds: ["conv-stoppedcold1"],
          },
        ],
      },
    ]);
    await expect(
      findAgenCDaemonAgentBySessionId(stopped as never, "conv-stoppedcold1"),
    ).resolves.toBeNull();
  });

  it("sends an explicit canonical resume through agent.create", async () => {
    vi.resetModules();
    const createAgent = vi.fn(async (params: unknown) => ({
      agentId: "conv-retained1",
      objective: "conv-retained1",
      status: "running" as const,
      createdAt: "2026-08-19T00:00:00.000Z",
      sessionId: "session_resumed",
      params,
    }));
    vi.doMock("../app-server/agent-cli.js", async (importActual) => {
      const actual =
        await importActual<typeof import("../app-server/agent-cli.js")>();
      return {
        ...actual,
        defaultEnsureDaemonReady: vi.fn(() => vi.fn(async () => {})),
        createAgenCJsonLineDaemonClient: vi.fn(() => ({ createAgent })),
      };
    });

    try {
      const { resumeAgenCDaemonPromptAgent } = await import("./index.js");
      await resumeAgenCDaemonPromptAgent({
        sessionId: "conv-retained1",
        rolloutPath:
          "/agenc-home/projects/workspace/sessions/conv-retained1/rollout-2026-conv-retained1.jsonl",
        cwd: "/workspace",
        model: "grok-4.3",
        provider: "grok",
        permissionMode: "acceptEdits",
        env: { AGENC_ALLOW_UNTRUSTED_HOOKS: "true" },
      });
      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeSessionId: "conv-retained1",
          resumeRolloutPath:
            "/agenc-home/projects/workspace/sessions/conv-retained1/rollout-2026-conv-retained1.jsonl",
          cwd: "/workspace",
          model: "grok-4.3",
          provider: "grok",
          permissionMode: "acceptEdits",
          runtimeOptions: expect.objectContaining({
            simpleMode: false,
            allowUntrustedHooks: true,
          }),
        }),
      );
      expect(createAgent.mock.calls[0]?.[0]).not.toHaveProperty("objective");
      expect(createAgent.mock.calls[0]?.[0]).not.toHaveProperty("metadata");
      expect(createAgent.mock.calls[0]?.[0]).not.toHaveProperty(
        "initialContent",
      );
    } finally {
      vi.doUnmock("../app-server/agent-cli.js");
      vi.resetModules();
    }
  });

  it("passes startup multimodal content through agent.create", async () => {
    vi.resetModules();
    const createAgent = vi.fn(async (params: unknown) => ({
      agentId: "agent_image",
      objective: "describe this",
      status: "running" as const,
      createdAt: "2026-05-06T00:00:00.000Z",
      sessionId: "session_image",
      params,
    }));
    const request = vi.fn();
    const close = vi.fn();
    vi.doMock("../app-server/agent-cli.js", async (importActual) => {
      const actual =
        await importActual<typeof import("../app-server/agent-cli.js")>();
      return {
        ...actual,
        defaultEnsureDaemonReady: vi.fn(() => vi.fn(async () => {})),
        createAgenCJsonLineDaemonClient: vi.fn(() => ({ createAgent })),
        createConnectedAgenCJsonLineDaemonTuiClient: vi.fn(async () => ({
          request,
          close,
        })),
      };
    });

    try {
      const { startAgenCDaemonPromptAgent } = await import("./index.js");
      await startAgenCDaemonPromptAgent({
        prompt: "describe this",
        cwd: "/workspace",
        env: { AGENC_ALLOW_UNTRUSTED_HOOKS: "true" },
        provider: "grok",
        model: "grok-4.3",
        profile: "fast",
        configPath: "operator.toml",
        initialContent: [
          { type: "text", text: "describe this" },
          {
            type: "image_url",
            image_url: { url: "file:///tmp/cat.png" },
          },
        ],
        initialDisplayUserMessage: "Explain the selected code",
        initialEditorInteraction: {
          interactionId: "interaction-client-explain",
          kind: "explain",
          policy: "read_only",
          editorInstanceId: "editor-client",
          bufferHandle: 7,
          changedtick: 12,
          contentSha256: "c".repeat(64),
          path: "/workspace/src/main.ts",
          range: {
            start: { line: 2, column: 3 },
            end: { line: 4, column: 0 },
          },
          selectionMode: "character",
        },
      });

      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          objective: "describe this",
          instructions: "describe this",
          cwd: "/workspace",
          runtimeOptions: expect.objectContaining({
            allowUntrustedHooks: true,
          }),
          provider: "grok",
          model: "grok-4.3",
          profile: "fast",
          configPath: "/workspace/operator.toml",
          initialContent: [
            { type: "text", text: "describe this" },
            {
              type: "image_url",
              image_url: { url: "file:///tmp/cat.png" },
            },
          ],
          initialDisplayUserMessage: "Explain the selected code",
          initialEditorInteraction: {
            interactionId: "interaction-client-explain",
            kind: "explain",
            policy: "read_only",
            editorInstanceId: "editor-client",
            bufferHandle: 7,
            changedtick: 12,
            contentSha256: "c".repeat(64),
            path: "/workspace/src/main.ts",
            range: {
              start: { line: 2, column: 3 },
              end: { line: 4, column: 0 },
            },
            selectionMode: "character",
          },
        }),
      );
      await startAgenCDaemonPromptAgent({
        prompt: "AgenC Editor workspace",
        cwd: "/workspace",
        deferInitialTurn: true,
        runtimeOptions: resolveAgentRuntimeOptions(
          {},
          { allowUntrustedHooks: true },
        ),
      });
      expect(createAgent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          objective: "AgenC Editor workspace",
          instructions: "AgenC Editor workspace",
          cwd: "/workspace",
          deferInitialTurn: true,
          runtimeOptions: expect.objectContaining({
            allowUntrustedHooks: true,
          }),
        }),
      );
      expect(createAgent.mock.calls[1]?.[0]).not.toHaveProperty(
        "initialContent",
      );
      expect(request).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../app-server/agent-cli.js");
      vi.resetModules();
    }
  });

  it("rejects the removed daemon prompt MCP environment channel", async () => {
    vi.resetModules();
    const createAgent = vi.fn(async (params: unknown) => ({
      agentId: "agent_mcp_env",
      objective: "use MCP",
      status: "running" as const,
      createdAt: "2026-05-06T00:00:00.000Z",
      sessionId: "session_mcp_env",
      params,
    }));
    vi.doMock("../app-server/agent-cli.js", async (importActual) => {
      const actual =
        await importActual<typeof import("../app-server/agent-cli.js")>();
      return {
        ...actual,
        defaultEnsureDaemonReady: vi.fn(() => vi.fn(async () => {})),
        createAgenCJsonLineDaemonClient: vi.fn(() => ({ createAgent })),
      };
    });

    try {
      const { startAgenCDaemonPromptAgent } = await import("./index.js");
      await expect(
        startAgenCDaemonPromptAgent({
          prompt: "use MCP",
          cwd: "/workspace",
          env: {
            AGENC_MCP_SERVERS: "[]",
          },
          runtimeOptions: resolveAgentRuntimeOptions({}, { simpleMode: true }),
        }),
      ).rejects.toThrow(/obsolete.*AGENC_MCP_SERVERS/u);
      expect(createAgent).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../app-server/agent-cli.js");
      vi.resetModules();
    }
  });

  it("seeds ordinary bypass without widening the configured sandbox", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-bypass-tui-context-"));
    const workspace = mkdtempSync(join(tmpdir(), "agenc-bypass-tui-workspace-"));
    let context: Awaited<
      ReturnType<typeof createAgenCDaemonOnlyTuiContext>
    > | null = null;
    try {
      context = await createAgenCDaemonOnlyTuiContext({
        env: { ...process.env, AGENC_HOME: agencHome, HOME: agencHome },
        cwd: workspace,
        conversationId: "agenc-tui-idle-test",
        runtimeOptions: resolveAgentRuntimeOptions({}, { simpleMode: true }),
        permissionMode: "bypassPermissions",
      });

      expect(context.baseSession.services.runtimeOptions?.simpleMode).toBe(true);
      const permissionContext =
        context.baseSession.services.permissionModeRegistry.current();
      expect(permissionContext.mode).toBe("bypassPermissions");
      expect(permissionContext.isBypassPermissionsModeAvailable).toBe(true);
      expect(context.baseSession.services.sandboxExecutionBroker?.mode).toBe(
        "workspace_write",
      );
    } finally {
      await context?.close();
      rmSync(agencHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("hydrates config-default bypass authority from the live attach snapshot", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-live-bypass-home-"));
    const workspace = mkdtempSync(join(tmpdir(), "agenc-live-bypass-workspace-"));
    writeFileSync(
      join(agencHome, "config.toml"),
      [
        "config_version = 2",
        'model_provider = "openai"',
        'model = "stale-model"',
        '[profiles.live]',
        'model_provider = "grok"',
        'model = "profile-model"',
        'approval_policy = "never"',
        "",
      ].join("\n"),
      "utf8",
    );
    let context: Awaited<
      ReturnType<typeof createAgenCDaemonOnlyTuiContext>
    > | null = null;
    try {
      context = await createAgenCDaemonOnlyTuiContext({
        env: {
          ...process.env,
          AGENC_HOME: agencHome,
          HOME: agencHome,
          AGENC_PROFILE: "stale-profile",
        },
        cwd: workspace,
        conversationId: "agenc-live-bypass-attach",
        provider: "openai",
        model: "client-only-model",
        profile: "stale-profile",
        runtimeSettings: {
          permissionMode: "bypassPermissions",
          prePlanMode: null,
          autoModeActive: false,
          autoModeAvailable: true,
          bypassPermissionsModeAvailable: true,
          bypassPermissionsWorkspace: workspace,
          bypassPermissionsConsentWorkspace: workspace,
          provider: "grok",
          model: "grok-live-model",
          profile: "live",
          reasoningEffort: "high",
          modelVerbosity: "low",
          serviceTier: "flex",
          hooksDisabled: false,
        },
      });

      const permissionContext =
        context.baseSession.services.permissionModeRegistry.current();
      expect(permissionContext).toMatchObject({
        mode: "bypassPermissions",
        autoModeActive: false,
        isBypassPermissionsModeAvailable: true,
        bypassPermissionsAcceptedIn: [workspace],
      });
      expect(context.model).toBe("grok-live-model");
      expect(context.baseSession.sessionConfiguration).toMatchObject({
        provider: { slug: "grok" },
        collaborationMode: {
          model: "grok-live-model",
          reasoningEffort: "high",
        },
        modelVerbosity: "low",
        serviceTier: "flex",
        sandboxPolicy: { value: "workspace_write" },
      });
      expect(context.baseSession.services.sandboxExecutionBroker?.mode).toBe(
        "workspace_write",
      );
    } finally {
      await context?.close();
      rmSync(agencHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("hydrates inactive daemon permission capabilities without consulting client config", async () => {
    const agencHome = mkdtempSync(
      join(tmpdir(), "agenc-inactive-capability-home-"),
    );
    const workspace = mkdtempSync(
      join(tmpdir(), "agenc-inactive-capability-workspace-"),
    );
    writeFileSync(
      join(agencHome, "config.toml"),
      [
        "config_version = 2",
        'disableAutoMode = "disable"',
        "[permissions]",
        'bypassPermissionsMode = "disable"',
        "",
      ].join("\n"),
      "utf8",
    );
    let context: Awaited<
      ReturnType<typeof createAgenCDaemonOnlyTuiContext>
    > | null = null;
    try {
      context = await createAgenCDaemonOnlyTuiContext({
        env: { ...process.env, AGENC_HOME: agencHome, HOME: agencHome },
        cwd: workspace,
        conversationId: "agenc-inactive-capability-attach",
        runtimeSettings: {
          permissionMode: "default",
          prePlanMode: null,
          autoModeActive: false,
          autoModeAvailable: true,
          bypassPermissionsModeAvailable: true,
          bypassPermissionsWorkspace: null,
          bypassPermissionsConsentWorkspace: workspace,
          provider: "grok",
          model: "grok-live-model",
          profile: null,
          reasoningEffort: null,
          modelVerbosity: null,
          serviceTier: null,
          hooksDisabled: false,
        } as never,
      });

      expect(
        context.baseSession.services.permissionModeRegistry.current(),
      ).toMatchObject({
        mode: "default",
        autoModeActive: false,
        isAutoModeAvailable: true,
        isBypassPermissionsModeAvailable: true,
        bypassPermissionsAcceptedIn: [workspace],
      });
    } finally {
      await context?.close();
      rmSync(agencHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("hydrates plan pre-mode and auto state without activating the bypass sandbox", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-live-plan-home-"));
    const workspace = mkdtempSync(join(tmpdir(), "agenc-live-plan-workspace-"));
    let context: Awaited<
      ReturnType<typeof createAgenCDaemonOnlyTuiContext>
    > | null = null;
    try {
      context = await createAgenCDaemonOnlyTuiContext({
        env: { ...process.env, AGENC_HOME: agencHome, HOME: agencHome },
        cwd: workspace,
        conversationId: "agenc-live-plan-attach",
        runtimeSettings: {
          permissionMode: "plan",
          prePlanMode: "bypassPermissions",
          autoModeActive: true,
          autoModeAvailable: true,
          bypassPermissionsModeAvailable: true,
          bypassPermissionsWorkspace: workspace,
          bypassPermissionsConsentWorkspace: workspace,
          provider: "grok",
          model: "grok-plan-model",
          profile: null,
          reasoningEffort: null,
          modelVerbosity: null,
          serviceTier: null,
          hooksDisabled: false,
        },
      });

      expect(
        context.baseSession.services.permissionModeRegistry.current(),
      ).toMatchObject({
        mode: "plan",
        prePlanMode: "bypassPermissions",
        autoModeActive: true,
        bypassPermissionsAcceptedIn: [workspace],
      });
      expect(context.baseSession.services.sandboxExecutionBroker?.mode).toBe(
        "workspace_write",
      );
    } finally {
      await context?.close();
      rmSync(agencHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps immutable dangerous sandbox authority across live permission changes", async () => {
    const agencHome = mkdtempSync(
      join(tmpdir(), "agenc-live-bypass-exit-home-"),
    );
    const workspace = mkdtempSync(
      join(tmpdir(), "agenc-live-bypass-exit-workspace-"),
    );
    writeFileSync(
      join(agencHome, "config.toml"),
      ["config_version = 2", 'sandbox_mode = "read-only"', ""].join("\n"),
      "utf8",
    );
    let context: Awaited<
      ReturnType<typeof createAgenCDaemonOnlyTuiContext>
    > | null = null;
    let unregisterParticipant: (() => void) | undefined;
    try {
      context = await createAgenCDaemonOnlyTuiContext({
        env: { ...process.env, AGENC_HOME: agencHome, HOME: agencHome },
        cwd: workspace,
        conversationId: "agenc-live-bypass-exit",
        runtimeOptions: resolveAgentRuntimeOptions({}, {
          dangerouslyBypassApprovalsAndSandbox: true,
        }),
        runtimeSettings: {
          permissionMode: "bypassPermissions",
          prePlanMode: null,
          autoModeActive: false,
          autoModeAvailable: true,
          bypassPermissionsModeAvailable: true,
          bypassPermissionsWorkspace: workspace,
          bypassPermissionsConsentWorkspace: workspace,
          provider: "grok",
          model: "grok-live-model",
          profile: null,
          reasoningEffort: null,
          modelVerbosity: null,
          serviceTier: null,
          hooksDisabled: false,
        },
      });
      const broker = context.baseSession.services.sandboxExecutionBroker;
      expect(broker?.mode).toBe("danger_full_access");
      expect(context.baseSession.sessionConfiguration.sandboxPolicy.value).toBe(
        "danger_full_access",
      );
      let hooksDisabled = false;
      Object.assign(context.baseSession.services, {
        hooksRuntime: {
          setDisabled: (disabled: boolean) => {
            hooksDisabled = disabled;
          },
        },
      });
      const lifecycle: string[] = [];
      const resumedAuthorities: Array<{
        readonly brokerMode: string | undefined;
        readonly permissionMode: string;
        readonly sandboxPolicy: string;
        readonly hooksDisabled: boolean;
      }> = [];
      unregisterParticipant = registerSandboxExecutionLifecycleParticipant(
        broker!,
        {
          name: "live-client-process",
          quiesce: async () => {
            lifecycle.push(`quiesce:${broker?.mode}`);
          },
          resume: async () => {
            lifecycle.push(`resume:${broker?.mode}`);
            resumedAuthorities.push({
              brokerMode: broker?.mode,
              permissionMode:
                context!.baseSession.services.permissionModeRegistry.current()
                  .mode,
              sandboxPolicy:
                context!.baseSession.sessionConfiguration.sandboxPolicy.value,
              hooksDisabled,
            });
          },
        },
      );

      await applyDaemonTuiRuntimeSettingsAuthority(
        context.baseSession,
        workspace,
        {
          permissionMode: "default",
          prePlanMode: null,
          autoModeActive: false,
          autoModeAvailable: true,
          bypassPermissionsModeAvailable: true,
          bypassPermissionsWorkspace: null,
          bypassPermissionsConsentWorkspace: workspace,
          provider: "grok",
          model: "grok-live-model",
          profile: null,
          reasoningEffort: null,
          modelVerbosity: null,
          serviceTier: null,
          hooksDisabled: false,
        },
      );

      expect(context.baseSession.services.sandboxExecutionBroker).toBe(broker);
      expect(broker?.mode).toBe("danger_full_access");
      expect(context.baseSession.sessionConfiguration.sandboxPolicy.value).toBe(
        "danger_full_access",
      );
      expect(lifecycle).toEqual([
        "quiesce:danger_full_access",
        "resume:danger_full_access",
      ]);
      expect(resumedAuthorities).toEqual([
        {
          brokerMode: "danger_full_access",
          permissionMode: "default",
          sandboxPolicy: "danger_full_access",
          hooksDisabled: false,
        },
      ]);

      await applyDaemonTuiRuntimeSettingsAuthority(
        context.baseSession,
        workspace,
        {
          permissionMode: "acceptEdits",
          prePlanMode: null,
          autoModeActive: false,
          autoModeAvailable: true,
          bypassPermissionsModeAvailable: true,
          bypassPermissionsWorkspace: null,
          bypassPermissionsConsentWorkspace: workspace,
          provider: "grok",
          model: "grok-live-model",
          profile: null,
          reasoningEffort: null,
          modelVerbosity: null,
          serviceTier: null,
          hooksDisabled: true,
        },
      );

      expect(lifecycle).toEqual([
        "quiesce:danger_full_access",
        "resume:danger_full_access",
        "quiesce:danger_full_access",
        "resume:danger_full_access",
      ]);
      expect(resumedAuthorities.at(-1)).toEqual({
        brokerMode: "danger_full_access",
        permissionMode: "acceptEdits",
        sandboxPolicy: "danger_full_access",
        hooksDisabled: true,
      });

      await applyDaemonTuiRuntimeSettingsAuthority(
        context.baseSession,
        workspace,
        {
          permissionMode: "bypassPermissions",
          prePlanMode: null,
          autoModeActive: false,
          autoModeAvailable: true,
          bypassPermissionsModeAvailable: true,
          bypassPermissionsWorkspace: workspace,
          bypassPermissionsConsentWorkspace: workspace,
          provider: "grok",
          model: "grok-live-model",
          profile: null,
          reasoningEffort: null,
          modelVerbosity: null,
          serviceTier: null,
          hooksDisabled: false,
        },
      );

      expect(lifecycle).toEqual([
        "quiesce:danger_full_access",
        "resume:danger_full_access",
        "quiesce:danger_full_access",
        "resume:danger_full_access",
        "quiesce:danger_full_access",
        "resume:danger_full_access",
      ]);
      expect(resumedAuthorities.at(-1)).toEqual({
        brokerMode: "danger_full_access",
        permissionMode: "bypassPermissions",
        sandboxPolicy: "danger_full_access",
        hooksDisabled: false,
      });
    } finally {
      unregisterParticipant?.();
      await context?.close();
      rmSync(agencHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not create a second MCP owner when daemon-only cleanup fails", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-close-fail-home-"));
    const workspace = mkdtempSync(
      join(tmpdir(), "agenc-close-fail-workspace-"),
    );
    let context: Awaited<
      ReturnType<typeof createAgenCDaemonOnlyTuiContext>
    > | null = null;
    try {
      context = await createAgenCDaemonOnlyTuiContext({
        env: { ...process.env, AGENC_HOME: agencHome, HOME: agencHome },
        cwd: workspace,
        conversationId: "agenc-tui-close-failure",
      });
      const watcher = context.baseSession.services.skillsWatcher;
      const originalWatcherStop = watcher.stop?.bind(watcher);
      const watcherStop = vi
        .spyOn(watcher, "stop")
        .mockImplementation(async () => {
          await originalWatcherStop?.();
          throw new Error("watcher stop failed");
        });
      expect(context.baseSession.services.mcpManager).toBeUndefined();
      expect(context.baseSession.listMcpClients).toBeUndefined();
      expect(context.baseSession.listMcpTools).toBeUndefined();

      await expect(context.close()).rejects.toThrow(
        "daemon-only TUI context cleanup failed",
      );
      expect(watcherStop).toHaveBeenCalledOnce();
      context = null;
    } finally {
      await context?.close().catch(() => undefined);
      rmSync(agencHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps daemon attach execution cwd separate from role authority", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-attach-home-"));
    const authority = mkdtempSync(join(tmpdir(), "agenc-attach-authority-"));
    const worktree = mkdtempSync(join(tmpdir(), "agenc-attach-worktree-"));
    let context: Awaited<
      ReturnType<typeof createAgenCDaemonOnlyTuiContext>
    > | null = null;
    try {
      context = await createAgenCDaemonOnlyTuiContext({
        env: { ...process.env, AGENC_HOME: agencHome, HOME: agencHome },
        cwd: worktree,
        roleWorkspace: { id: authority, cwd: authority },
        conversationId: "agenc-tui-worktree-child",
      });

      expect(context.baseSession.roleWorkspace).toMatchObject({
        id: authority,
        cwd: authority,
      });
      expect(context.baseSession.sessionConfiguration?.cwd).toBe(worktree);
      expect(context.workspaceRoot).toBe(worktree);
      expect(context.baseSession.services.sandboxExecutionBroker?.mode).toBe(
        "workspace_write",
      );
      expect(context.baseSession.services.sandboxExecutionBroker?.cwd).toBe(
        worktree,
      );
    } finally {
      await context?.close();
      rmSync(agencHome, { recursive: true, force: true });
      rmSync(authority, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("applies daemon-only TUI provider and model startup overrides", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-model-tui-context-"));
    const workspace = mkdtempSync(join(tmpdir(), "agenc-model-tui-workspace-"));
    let context: Awaited<
      ReturnType<typeof createAgenCDaemonOnlyTuiContext>
    > | null = null;
    try {
      context = await createAgenCDaemonOnlyTuiContext({
        env: {
          ...process.env,
          AGENC_HOME: agencHome,
          HOME: agencHome,
          XAI_API_KEY: "test-key",
        },
        cwd: workspace,
        conversationId: "agenc-tui-model-test",
        provider: "grok",
        model: "grok-4.3",
      });

      expect(context.model).toBe("grok-4.3");
      expect(context.baseSession.services.configStore.current()).toMatchObject({
        model_provider: "grok",
        model: "grok-4.3",
      });
      expect(context.baseSession.sessionConfiguration).toMatchObject({
        provider: { slug: "grok" },
        collaborationMode: { model: "grok-4.3" },
      });
    } finally {
      await context?.close();
      rmSync(agencHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps explicit config, profile, and CLI authority identical across the daemon TUI surfaces after reload", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-config-tui-context-"));
    const workspace = mkdtempSync(join(tmpdir(), "agenc-config-tui-workspace-"));
    const explicitConfig = join(workspace, "operator.toml");
    writeFileSync(
      explicitConfig,
      [
        "config_version = 2",
        'model_provider = "grok"',
        'model = "grok-4.3"',
        'approval_policy = "on-request"',
        'sandbox_mode = "workspace-write"',
        "[profiles.operator]",
        'model = "grok-4.5"',
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        "[profiles.operator.tools_config]",
        'enabled_tools = ["FileRead"]',
        'disabled_tools = ["Write"]',
        "",
      ].join("\n"),
      "utf8",
    );
    let context: Awaited<
      ReturnType<typeof createAgenCDaemonOnlyTuiContext>
    > | null = null;
    try {
      context = await createAgenCDaemonOnlyTuiContext({
        env: {
          ...process.env,
          AGENC_HOME: agencHome,
          HOME: agencHome,
          AGENC_MODEL: "grok-4.4",
          XAI_API_KEY: "test-key",
        },
        cwd: workspace,
        conversationId: "agenc-tui-canonical-config-test",
        configPath: "operator.toml",
        profile: "operator",
        provider: "grok",
        model: "grok-4.6",
      });
      const store = context.baseSession.services.configStore as ConfigStore;
      const expectedConfig = {
        model_provider: "grok",
        model: "grok-4.6",
        approval_policy: "never",
        sandbox_mode: "read-only",
        tools_config: {
          enabled_tools: ["FileRead"],
          disabled_tools: ["Write"],
        },
      };
      const observed: unknown[] = [];
      const unsubscribe = store.subscribe((config) => observed.push(config));
      const commandContext = {
        session: context.baseSession,
        configStore: store,
        cwd: workspace,
        home: agencHome,
        agencHome,
      } as SlashCommandContext;

      const assertCanonicalSurfaces = (): void => {
        const current = store.current();
        expect(current).toMatchObject(expectedConfig);
        expect(context!.baseSession.services.configStore).toBe(store);
        expect(context!.baseSession.config).toEqual(current);
        expect(context!.baseSession.sessionConfiguration).toMatchObject({
          provider: { slug: "grok" },
          collaborationMode: { model: "grok-4.6" },
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: "read_only" },
        });
        const menu = readConfigMenuSnapshot(commandContext);
        expect(menu.rows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              key: "session model",
              value: "grok-4.6",
              status: "active",
            }),
            expect.objectContaining({ key: "approval", value: "never" }),
            expect.objectContaining({ key: "sandbox", value: "read-only" }),
            expect.objectContaining({
              key: "tools",
              detail: expect.stringContaining("1 enabled tools; 1 disabled tools"),
            }),
          ]),
        );
      };

      assertCanonicalSurfaces();
      await store.reload();
      assertCanonicalSurfaces();
      expect(observed).toEqual([expect.objectContaining(expectedConfig)]);
      expect(store.provenance("model")?.scope).toBe("cli");
      expect(store.provenance("sandbox_mode")?.scope).toBe("profile");
      expect(store.sources("flag")).toEqual([
        expect.objectContaining({ path: explicitConfig }),
      ]);
      unsubscribe();
    } finally {
      await context?.close();
      rmSync(agencHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("dispatches daemon-only TUI slash commands without local session services", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-daemon-slash-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "agenc-daemon-slash-cwd-"));
    mkdirSync(join(cwd, ".agenc/skills/python-game"), { recursive: true });
    writeFileSync(
      join(cwd, ".agenc/skills/python-game/SKILL.md"),
      "---\nname: python-game\ndescription: Help with the Python game.\n---\n",
      "utf8",
    );
    let context: Awaited<
      ReturnType<typeof createAgenCDaemonOnlyTuiContext>
    > | null = null;
    try {
      const contextEnvironment = {
        ...process.env,
        AGENC_HOME: agencHome,
        HOME: agencHome,
      };
      const contextPromise = createAgenCDaemonOnlyTuiContext({
        env: contextEnvironment,
        cwd,
        conversationId: "agenc-tui-daemon-slash-test",
        permissionMode: "bypassPermissions",
      });
      context = await contextPromise;
      expect(context.baseSession.services.mcpManager).toBeUndefined();
      const registry = buildDefaultRegistry();
      const run = async (input: string) => {
        const parsed = parseSlashCommand(input);
        expect(parsed).not.toBeNull();
        return dispatchSlashCommand(
          parsed!,
          {
            session: context.baseSession as SlashCommandContext["session"],
            argsRaw: parsed!.argsRaw,
            cwd,
            home: agencHome,
            agencHome,
            configStore:
              context.baseSession.services.configStore as SlashCommandContext["configStore"],
            commandRegistry: registry,
            appState: {
              getAppState: () => ({ mcp: { commands: [] } }),
            },
          },
          registry,
        );
      };

      await expect(run("/config")).resolves.toMatchObject({
        result: { kind: "text" },
      });
      await expect(run("/settings")).resolves.toMatchObject({
        result: {
          kind: "error",
          message: "Unknown command: /settings",
        },
      });
      await expect(run("/provider grok")).resolves.toMatchObject({
        result: {
          kind: "text",
          text: "Provider unchanged: grok/grok-4.6.",
        },
      });
      await expect(run("/skills")).resolves.toMatchObject({
        result: {
          kind: "text",
          text: expect.stringContaining("python-game"),
        },
      });
    } finally {
      await context?.close();
      rmSync(agencHome, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("refreshes project skills created during the same daemon-only TUI session", async () => {
    const agencHome = mkdtempSync(join(tmpdir(), "agenc-daemon-skills-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "agenc-daemon-skills-cwd-"));
    let context: Awaited<
      ReturnType<typeof createAgenCDaemonOnlyTuiContext>
    > | null = null;
    try {
      context = await createAgenCDaemonOnlyTuiContext({
        env: { ...process.env, AGENC_HOME: agencHome, HOME: agencHome },
        cwd,
        conversationId: "agenc-tui-live-skills-test",
        permissionMode: "bypassPermissions",
      });
      const registry = buildDefaultRegistry();
      const runSkills = async () => {
        const parsed = parseSlashCommand("/skills");
        expect(parsed).not.toBeNull();
        return dispatchSlashCommand(
          parsed!,
          {
            session: context!.baseSession as SlashCommandContext["session"],
            argsRaw: parsed!.argsRaw,
            cwd,
            home: agencHome,
            agencHome,
            configStore: context!.baseSession.services
              .configStore as SlashCommandContext["configStore"],
            commandRegistry: registry,
            appState: {
              getAppState: () => ({ mcp: { commands: [] } }),
            },
          },
          registry,
        );
      };

      await expect(runSkills()).resolves.toMatchObject({
        result: {
          kind: "text",
          text: expect.not.stringContaining("late-python-game"),
        },
      });

      mkdirSync(join(cwd, ".agenc/skills/late-python-game"), {
        recursive: true,
      });
      writeFileSync(
        join(cwd, ".agenc/skills/late-python-game/SKILL.md"),
        "---\nname: late-python-game\ndescription: Late skill.\n---\n",
        "utf8",
      );

      await expect(runSkills()).resolves.toMatchObject({
        result: {
          kind: "text",
          text: expect.stringContaining("late-python-game"),
        },
      });
    } finally {
      await context?.close();
      rmSync(agencHome, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("dispatches daemon-only TUI plan and agents commands", async () => {
    const agencHome = mkdtempSync(
      join(tmpdir(), "agenc-daemon-plan-agents-home-"),
    );
    const cwd = mkdtempSync(join(tmpdir(), "agenc-daemon-plan-agents-cwd-"));
    let context: Awaited<
      ReturnType<typeof createAgenCDaemonOnlyTuiContext>
    > | null = null;
    try {
      context = await createAgenCDaemonOnlyTuiContext({
        env: { ...process.env, AGENC_HOME: agencHome, HOME: agencHome },
        cwd,
        conversationId: "agenc-tui-plan-agents-test",
        permissionMode: "default",
      });
      const registry = buildDefaultRegistry();
      let toolJSX: unknown = null;
      const run = async (input: string) => {
        const parsed = parseSlashCommand(input);
        expect(parsed).not.toBeNull();
        return dispatchSlashCommand(
          parsed!,
          {
            session: context.baseSession as SlashCommandContext["session"],
            argsRaw: parsed!.argsRaw,
            cwd,
            home: agencHome,
            agencHome,
            configStore:
              context.baseSession.services.configStore as SlashCommandContext["configStore"],
            commandRegistry: registry,
            appState: {
              getAppState: () => ({
                toolPermissionContext:
                  context.baseSession.services.permissionModeRegistry.current(),
                mcp: { commands: [] },
              }),
              setToolJSX: (next) => {
                toolJSX = next;
              },
              tools: [],
            },
          },
          registry,
        );
      };

      await expect(run("/plan")).resolves.toMatchObject({
        result: { kind: "skip" },
      });
      expect(
        context.baseSession.services.permissionModeRegistry.current().mode,
      ).toBe("plan");
      expect(toolJSX).toMatchObject({
        isLocalJSXCommand: true,
        shouldHidePromptInput: true,
        jsx: expect.anything(),
      });
      (
        toolJSX as { jsx: { props: { onDone: () => void } } }
      ).jsx.props.onDone();
      expect(toolJSX).toMatchObject({
        clearLocalJSX: true,
        jsx: null,
      });

      await expect(run("/agents")).resolves.toMatchObject({
        result: { kind: "skip" },
      });
      expect(toolJSX).toMatchObject({
        isLocalJSXCommand: true,
        shouldHidePromptInput: true,
        jsx: expect.anything(),
      });
      (
        toolJSX as { jsx: { props: { onDone: () => void } } }
      ).jsx.props.onDone();
      expect(toolJSX).toMatchObject({
        clearLocalJSX: true,
        jsx: null,
      });
    } finally {
      await context?.close();
      rmSync(agencHome, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
