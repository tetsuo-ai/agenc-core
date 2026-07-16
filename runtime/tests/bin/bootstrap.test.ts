import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapLocalRuntimeSession } from "./bootstrap.js";
import {
  readStartupCliFlags,
  resolveStartupSelection,
} from "../bin/startup-selection.js";
import {
  AmbiguousModelError,
  defaultConfig,
  mergeConfigs,
  UnknownModelError,
} from "../config/schema.js";
import { parseToml } from "../config/loader.js";
import { trustProjectSync } from "../permissions/trust/project-trust.js";
import type { AuthBackend } from "../auth/backend.js";
import { LocalAuthBackend } from "../auth/backends/local.js";
import type { Tool } from "../tools/types.js";
import type { RolloutItem } from "../session/rollout-item.js";
import { RolloutStore } from "../session/rollout-store.js";
import { FileThreadStore } from "../thread-store/store.js";
import { Session } from "../session/session.js";
import { buildAgenCToolUseContext } from "../session/agenc-tool-use-context.js";
import {
  _resetAgentRolesForTesting,
  createAgentRoleWorkspace,
  registerAgentRole,
} from "../agents/role.js";
import { findAgentDefinitionByType } from "../tools/AgentTool/loadAgentsDir.js";
import { SidecarManager } from "../session/sidecar.js";
import { getCurrentRuntimeSession } from "./_deps/current-session.js";
import { PERSONALITY_MIGRATION_FILENAME } from "../personality/migration.js";
import {
  isSandboxExecutionBrokerDisposed,
  registerSandboxExecutionLifecycleParticipant,
} from "../sandbox/execution-lifecycle.js";
import {
  adaptTranscriptEvents,
  appendSessionTranscriptEventForTesting,
  createSessionTranscriptStateForTesting,
} from "../tui/session-transcript.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function offlineFetchFixture(): typeof fetch {
  return vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error("offline bootstrap fixture"));
}

function clearProcessEnv(keys: readonly string[]): () => void {
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

function trustWorkspaceForTest(agencHome: string, workspace: string): void {
  trustProjectSync({
    agencHome,
    cwd: workspace,
    env: { HOME: agencHome },
  });
}

function withAgencHomeForThreadStore<T>(agencHome: string, fn: () => T): T {
  const previous = process.env.AGENC_HOME;
  process.env.AGENC_HOME = agencHome;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.AGENC_HOME;
    } else {
      process.env.AGENC_HOME = previous;
    }
  }
}

function writeRecordedThreadForBootstrap(params: {
  readonly agencHome: string;
  readonly workspace: string;
  readonly threadId: string;
  readonly provider: string;
}): void {
  withAgencHomeForThreadStore(params.agencHome, () => {
    const rolloutStore = new RolloutStore({
      cwd: params.workspace,
      sessionId: params.threadId,
      agencVersion: "0.2.0",
      autoStartScheduler: false,
    });
    rolloutStore.open({
      sessionId: params.threadId,
      timestamp: new Date().toISOString(),
      cwd: params.workspace,
      originator: "bootstrap-personality-migration-test",
      agencVersion: "0.2.0",
      model: "grok-4.3",
      modelProvider: params.provider,
    });
    const threadStore = new FileThreadStore({
      cwd: params.workspace,
      agencHome: params.agencHome,
      defaultModelProviderId: params.provider,
    });
    try {
      threadStore.createThread({
        threadId: params.threadId,
        rolloutStore,
        cwd: params.workspace,
        model: "grok-4.3",
        modelProvider: params.provider,
      });
      threadStore.appendItems({
        threadId: params.threadId,
        items: [
          {
            type: "response_item",
            payload: { role: "user", content: "previous session" },
          },
        ],
      });
      threadStore.shutdownThread(params.threadId);
    } finally {
      threadStore.close();
      rolloutStore.close();
    }
  });
}

function rolloutEvent(
  id: string,
  type: string,
  payload: unknown,
  seq: number,
): RolloutItem {
  return {
    type: "event_msg",
    payload: {
      id,
      seq,
      msg: { type, payload },
    },
  } as unknown as RolloutItem;
}

describe("resolveStartupSelection", () => {
  // Regression for the shared-selection hard-exit bug. `resolveStartupSelection`
  // is reached from the daemon/TUI context (app-server-client), not just the
  // CLI, so an ambiguous/unknown CONFIGURED model must surface as a CATCHABLE
  // thrown error — it must NOT call process.exit(1) from inside shared code,
  // which would bypass every caller's try/catch. We spy on process.exit so a
  // revert to the old exit-based behavior is caught even if it somehow also
  // "threw".
  it("THROWS (catchable) on an ambiguous bare CONFIGURED model — never process.exit", () => {
    const config = mergeConfigs(defaultConfig(), {
      // model_provider intentionally unset → falls through to the bare-model
      // disambiguation path (the buggy branch).
      model_provider: "",
      model: "shared-cfg-model",
      providers: {
        grok: { default_model: "shared-cfg-model" },
        openai: { default_model: "shared-cfg-model" },
      },
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      let captured: unknown;
      try {
        resolveStartupSelection({
          config,
          env: {},
          argv: ["node", "agenc"],
        });
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(AmbiguousModelError);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("THROWS (catchable) on an unknown bare CONFIGURED model — never process.exit", () => {
    const config = mergeConfigs(defaultConfig(), {
      model_provider: "",
      model: "definitely-not-a-real-model-xyz",
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      let captured: unknown;
      try {
        resolveStartupSelection({
          config,
          env: {},
          argv: ["node", "agenc"],
        });
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(UnknownModelError);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("applies CLI provider/model/profile ahead of env and config", () => {
    const config = mergeConfigs(defaultConfig(), {
      model: "grok-3",
      model_provider: "grok",
      profiles: {
        strict: {
          model: "agenc-opus-4-7",
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
        AGENC_MODEL: "agenc-opus-4-7",
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

  it("selects the hosted AgenC provider when requested", () => {
    const resolved = resolveStartupSelection({
      config: defaultConfig(),
      env: {
        AGENC_PROVIDER: "agenc",
      },
      argv: ["node", "agenc"],
    });

    expect(resolved.provider).toBe("agenc");
    expect(resolved.model).toBe("agenc");
  });

  it('routes model = "agenc" through the hosted AgenC provider', () => {
    const resolved = resolveStartupSelection({
      config: mergeConfigs(defaultConfig(), { model: "agenc" }),
      env: {},
      argv: ["node", "agenc"],
    });

    expect(resolved.provider).toBe("agenc");
    expect(resolved.model).toBe("agenc");
  });

  it("routes --model agenc through the hosted AgenC provider", () => {
    const resolved = resolveStartupSelection({
      config: defaultConfig(),
      env: {},
      argv: ["node", "agenc", "--model", "agenc"],
    });

    expect(resolved.provider).toBe("agenc");
    expect(resolved.model).toBe("agenc");
  });

  // branding-scan: allow real provider identifier in test title
  it("uses compatible-provider model env ahead of generic OpenAI env", () => {
    const resolved = resolveStartupSelection({
      config: defaultConfig(),
      env: {
        AGENC_PROVIDER: "openai-compatible",
        OPENAI_COMPATIBLE_MODEL: "self-hosted-coder",
        OPENAI_MODEL: "generic-openai-model",
      },
      argv: ["node", "agenc"],
    });

    expect(resolved.provider).toBe("openai-compatible");
    expect(resolved.model).toBe("self-hosted-coder");
  });

  // branding-scan: allow real provider identifier in test title
  it("uses generic OpenAI model env as compatible-provider fallback", () => {
    const resolved = resolveStartupSelection({
      config: defaultConfig(),
      env: {
        AGENC_PROVIDER: "openai-compatible",
        OPENAI_MODEL: "generic-openai-model",
      },
      argv: ["node", "agenc"],
    });

    expect(resolved.provider).toBe("openai-compatible");
    expect(resolved.model).toBe("generic-openai-model");
  });

  it("uses compatible-provider model env when selected by config", () => {
    const config = mergeConfigs(defaultConfig(), {
      model_provider: "openai-compatible",
    });

    const resolved = resolveStartupSelection({
      config,
      env: {
        OPENAI_COMPATIBLE_MODEL: "config-selected-coder",
      },
      argv: ["node", "agenc"],
    });

    expect(resolved.provider).toBe("openai-compatible");
    expect(resolved.model).toBe("config-selected-coder");
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
        "--autonomous",
      ]),
    ).toMatchObject({
      permissionMode: "plan",
      allowDangerouslySkipPermissions: true,
      autonomousMode: true,
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

  it("ignores unattended as a startup permission mode", () => {
    expect(
      readStartupCliFlags([
        "node",
        "agenc",
        "--permission-mode",
        "unattended",
      ]).permissionMode,
    ).toBeUndefined();
  });
});

describe("bootstrapLocalRuntimeSession", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _resetAgentRolesForTesting();
  });

  it("keeps a workspace programmatic role in bootstrap and model-facing catalogs", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-role-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-role-ws-"));
    const roleWorkspace = createAgentRoleWorkspace(workspace);
    registerAgentRole(roleWorkspace, {
      name: "programmatic-auditor",
      config: {
        description: "Strict registered auditor",
        systemPrompt: "Audit without editing.",
        model: "grok-4.5",
        allowlist: ["FileRead"],
        disallowlist: ["Write"],
        reasoningEffort: "high",
      },
    });

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
        cwd: workspace,
        env: {
          ...process.env,
          AGENC_HOME: home,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      const bootDefinition = findAgentDefinitionByType(
        boot.session.agentDefinitions.activeAgents as never[],
        "programmatic-auditor",
      );
      expect(bootDefinition).toMatchObject({
        source: "flagSettings",
        baseDir: "programmatic",
        model: "grok-4.5",
        tools: ["FileRead"],
        disallowedTools: ["Write"],
        effort: "high",
      });
      expect(bootDefinition?.getSystemPrompt()).toBe("Audit without editing.");

      const toolContext = buildAgenCToolUseContext(boot.session, boot.ctx);
      expect(
        findAgentDefinitionByType(
          toolContext.options.agentDefinitions.activeAgents,
          "programmatic-auditor",
        ),
      ).toMatchObject({ agentRoleFingerprint: expect.any(String) });
    } finally {
      await shutdown?.().catch(() => {});
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("runs personality migration before constructing the first turn context", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    writeRecordedThreadForBootstrap({
      agencHome: home,
      workspace,
      threadId: "personality-prior-thread",
      provider: "grok",
    });

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

      expect(boot.config.personality).toBe("pragmatic");
      expect(boot.ctx.config.personality).toBe("pragmatic");
      await expect(
        readFile(join(home, PERSONALITY_MIGRATION_FILENAME), "utf8"),
      ).resolves.toBe("v1\n");
      const persisted = parseToml(
        await readFile(join(home, "config.toml"), "utf8"),
      ) as Record<string, unknown>;
      expect(persisted.personality).toBe("pragmatic");
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
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
      // The explicit per-session cwd must beat AGENC_WORKSPACE: in the
      // daemon, env is frozen at daemon start and a stale AGENC_WORKSPACE
      // pinned every session to the first launch folder
      // (bug-audit-2026-07-11.md #2).
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: "/stale-daemon-workspace-ignored",
          HOME: home,
        },
        cwd: workspace,
        toolRegistryOptions: {
          extraTools: [extraTool],
        },
      });
      shutdown = boot.shutdown;

      expect(boot.agencHome).toBe(home);
      expect(boot.workspaceRoot).toBe(workspace);
      expect(boot.resolvedProvider).toBe("grok");
      expect(boot.model).toBe("grok-4.5");
      expect(boot.registry.tools.some((tool) => tool.name === extraTool.name)).toBe(
        true,
      );
      expect(boot.registry.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "FileRead",
          "Write",
          "system.bash",
          extraTool.name,
        ]),
      );
      const providerTools = createProviderSpy.mock.calls[0]?.[1].tools as
        | Array<{ readonly function?: { readonly name?: string } }>
        | undefined;
      const providerToolNames =
        providerTools?.map((tool) => tool.function?.name).filter(Boolean) ?? [];
      expect(providerToolNames).toEqual(
        expect.arrayContaining([
          "exec_command",
          "write_stdin",
          "TodoWrite",
          "EnterPlanMode",
          "ExitPlanMode",
          "system.searchTools",
          extraTool.name,
        ]),
      );
      expect(providerToolNames).toContain("FileRead");
      expect(providerToolNames).toContain("Write");
      expect(providerToolNames).not.toContain("system.bash");
      expect(createProviderSpy).toHaveBeenCalledWith(
        "grok",
        expect.objectContaining({
          apiKey: "test-key",
          model: "grok-4.5",
          tools: expect.any(Array),
        }),
      );
      expect(boot.initialState.sessionConfiguration.cwd).toBe(workspace);
      expect(boot.initialState.sessionConfiguration.sessionSource).toBe(
        "cli_main",
      );
      expect(boot.config.agentRoles.length).toBeGreaterThan(0);
      expect(
        boot.session.agentDefinitions.activeAgents.map((definition) =>
          (definition as { agentType: string }).agentType,
        ),
      ).toEqual(boot.config.agentRoles.map((role) => role.name));
      expect(
        boot.session.agentDefinitions.activeAgents,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            agentType: "explorer",
            source: "built-in",
            agentRoleFingerprint: expect.any(String),
            disallowedTools: expect.arrayContaining(["Write"]),
          }),
        ]),
      );
      expect(startMcpSpy).toHaveBeenCalledWith(boot.mcpManager, {
        signal: boot.session.services.mcpStartupCancellationToken.signal,
      });
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("exposes conversation manager snapshots for fresh startup and resume replay", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const conversationId = "conv-conversation-manager";

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
    let resumedShutdown: (() => Promise<void>) | null = null;
    try {
      const first = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId,
        resumeConversation: false,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      firstShutdown = first.shutdown;

      const firstManager = first.session.services.conversationThreadManager;
      expect(firstManager).toBeDefined();
      expect(first.session.services.threadManager).toBe(firstManager);
      expect(firstManager!.snapshot(conversationId)).toMatchObject({
        prewarm: "ready",
        historyLength: 0,
      });

      first.rolloutStore.appendRollout({
        type: "response_item",
        payload: { role: "user", content: "persisted ask" },
      } as RolloutItem);
      for (const event of [
        rolloutEvent("turn", "turn_started", { turnId: "turn-1" }, 1),
        rolloutEvent(
          "thinking-start",
          "assistant_thinking_block_start",
          { index: 0, redacted: false, kind: "thinking" },
          2,
        ),
        rolloutEvent(
          "thinking-delta",
          "assistant_thinking_delta",
          { index: 0, delta: "visible reasoning", kind: "thinking" },
          3,
        ),
        rolloutEvent(
          "thinking-stop",
          "assistant_thinking_block_stop",
          { index: 0, kind: "thinking" },
          4,
        ),
        rolloutEvent(
          "thinking-final",
          "agent_thinking",
          { text: "visible reasoning", redacted: false, kind: "thinking" },
          5,
        ),
        rolloutEvent(
          "complete",
          "turn_complete",
          { turnId: "turn-1", lastAgentMessage: "done" },
          6,
        ),
      ]) {
        first.rolloutStore.appendRollout(event);
      }
      first.rolloutStore.flushDurable();
      await first.shutdown();
      firstShutdown = null;

      const resumed = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      resumedShutdown = resumed.shutdown;

      const resumedManager = resumed.session.services.conversationThreadManager;
      expect(resumedManager).toBeDefined();
      expect(resumed.session.services.threadManager).toBe(resumedManager);
      expect(resumed.initialState.history).toEqual([
        { role: "user", content: "persisted ask" },
      ]);
      const initialTranscriptEvents = resumed.session.getInitialTranscriptEvents();
      expect(
        initialTranscriptEvents.map((event) =>
          typeof event === "object" && event !== null
            ? (event as { readonly type?: unknown }).type
            : undefined,
        ),
      ).toEqual(
        expect.arrayContaining([
          "turn_started",
          "assistant_thinking_block_start",
          "assistant_thinking_delta",
          "assistant_thinking_block_stop",
          "agent_thinking",
          "turn_complete",
        ]),
      );
      const transcript = adaptTranscriptEvents(
        initialTranscriptEvents as Parameters<typeof adaptTranscriptEvents>[0],
      );
      expect(
        transcript.messages.some(
          (message) =>
            message.type === "assistant" &&
            Array.isArray(message.message?.content) &&
            message.message.content.some(
              (part: {
                readonly type?: unknown;
                readonly thinking?: unknown;
              }) =>
                part.type === "thinking" &&
                part.thinking === "visible reasoning",
            ),
        ),
      ).toBe(true);
      const resumedSnapshot = resumedManager!.snapshot(conversationId);
      expect(resumedSnapshot).toMatchObject({
        prewarm: "ready",
        historyLength: 1,
      });
      expect(resumedSnapshot.rolloutItemCount).toBeGreaterThanOrEqual(1);

      const maxInitialSeq = Math.max(
        0,
        ...initialTranscriptEvents.map((event) =>
          typeof event === "object" &&
          event !== null &&
          "seq" in event &&
          typeof (event as { readonly seq?: unknown }).seq === "number"
            ? (event as { readonly seq: number }).seq
            : 0,
        ),
      );
      const liveEvents: Parameters<
        typeof appendSessionTranscriptEventForTesting
      >[1][] = [];
      const unsubscribe = resumed.session.eventLog.subscribe((event) => {
        liveEvents.push(
          event as Parameters<typeof appendSessionTranscriptEventForTesting>[1],
        );
      });
      resumed.session.emit({
        id: "live-after-resume",
        msg: {
          type: "agent_message",
          payload: { message: "after resume" },
        },
      });
      unsubscribe();
      const liveEvent = liveEvents.find((event) => event.id === "live-after-resume");
      expect(liveEvent?.seq).toBeGreaterThan(maxInitialSeq);

      let transcriptState = createSessionTranscriptStateForTesting(
        initialTranscriptEvents as Parameters<
          typeof createSessionTranscriptStateForTesting
        >[0],
      );
      transcriptState = appendSessionTranscriptEventForTesting(
        transcriptState,
        liveEvent!,
      );
      const transcriptAfterLive = adaptTranscriptEvents(transcriptState.events);
      expect(
        transcriptAfterLive.messages.some(
          (message) =>
            message.type === "assistant" &&
            Array.isArray(message.message?.content) &&
            message.message.content.some(
              (part: { readonly type?: unknown; readonly text?: unknown }) =>
                part.type === "text" && part.text === "after resume",
            ),
        ),
      ).toBe(true);
    } finally {
      await resumedShutdown?.().catch(() => {
        /* best effort */
      });
      await firstShutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("replays streamed tool input events into resumed transcript state", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const conversationId = "conv-streamed-tool-input";

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
    let resumedShutdown: (() => Promise<void>) | null = null;
    try {
      const first = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId,
        resumeConversation: false,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      firstShutdown = first.shutdown;

      first.rolloutStore.appendRollout(
        rolloutEvent(
          "tool-input-delta",
          "tool_input_delta",
          { index: 0, partialJson: '{"path":"src/partial' },
          1,
        ),
      );
      first.rolloutStore.appendRollout(
        rolloutEvent(
          "tool-input-start",
          "tool_input_block_start",
          {
            callId: "tool-call-1",
            index: 0,
            toolName: "FileRead",
            contentBlock: {
              type: "tool_use",
              id: "tool-call-1",
              name: "FileRead",
              input: {},
            },
          },
          2,
        ),
      );
      first.rolloutStore.flushDurable();
      await first.shutdown();
      firstShutdown = null;

      const resumed = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      resumedShutdown = resumed.shutdown;

      const initialTranscriptEvents = resumed.session.getInitialTranscriptEvents();
      expect(
        initialTranscriptEvents.map((event) =>
          typeof event === "object" && event !== null
            ? (event as { readonly type?: unknown }).type
            : undefined,
        ),
      ).toEqual(
        expect.arrayContaining([
          "tool_input_delta",
          "tool_input_block_start",
        ]),
      );

      const transcript = adaptTranscriptEvents(
        initialTranscriptEvents as Parameters<typeof adaptTranscriptEvents>[0],
      );
      expect(transcript.streamingToolUses).toHaveLength(1);
      expect(transcript.streamingToolUses[0]).toMatchObject({
        index: 0,
        contentBlock: {
          id: "tool-call-1",
          name: "FileRead",
        },
        unparsedToolInput: '{"path":"src/partial',
      });
    } finally {
      await resumedShutdown?.().catch(() => {
        /* best effort */
      });
      await firstShutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("replays MCP tool call events into resumed transcript state", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const conversationId = "conv-mcp-tool-call-replay";

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
    let resumedShutdown: (() => Promise<void>) | null = null;
    try {
      const first = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId,
        resumeConversation: false,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      firstShutdown = first.shutdown;

      first.rolloutStore.appendRollout(
        rolloutEvent(
          "mcp-begin",
          "mcp_tool_call_begin",
          {
            callId: "mcp-call-1",
            server: "test-server",
            toolName: "lookup",
            args: JSON.stringify({ query: "runtime" }),
          },
          1,
        ),
      );
      first.rolloutStore.appendRollout(
        rolloutEvent(
          "mcp-end",
          "mcp_tool_call_end",
          {
            callId: "mcp-call-1",
            isError: false,
            result: "lookup result",
            durationMs: 12,
          },
          2,
        ),
      );
      first.rolloutStore.flushDurable();
      await first.shutdown();
      firstShutdown = null;

      const resumed = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      resumedShutdown = resumed.shutdown;

      const initialTranscriptEvents = resumed.session.getInitialTranscriptEvents();
      expect(
        initialTranscriptEvents.map((event) =>
          typeof event === "object" && event !== null
            ? (event as { readonly type?: unknown }).type
            : undefined,
        ),
      ).toEqual(
        expect.arrayContaining([
          "mcp_tool_call_begin",
          "mcp_tool_call_end",
        ]),
      );

      const transcript = adaptTranscriptEvents(
        initialTranscriptEvents as Parameters<typeof adaptTranscriptEvents>[0],
      );
      expect(transcript.messages.map((message) => message.type)).toEqual([
        "assistant",
        "user",
      ]);
      const toolUse = transcript.messages[0]?.message.content as Array<{
        readonly id?: string;
        readonly name?: string;
      }>;
      const toolResult = transcript.messages[1]?.message.content as Array<{
        readonly tool_use_id?: string;
        readonly content?: unknown;
      }>;
      expect(toolUse?.[0]).toMatchObject({
        id: "mcp-call-1",
        name: "lookup",
      });
      expect(toolResult?.[0]?.tool_use_id).toBe("mcp-call-1");
      expect(JSON.stringify(toolResult?.[0]?.content ?? "")).toContain(
        "lookup result",
      );
    } finally {
      await resumedShutdown?.().catch(() => {
        /* best effort */
      });
      await firstShutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("replays token ledger events into resumed transcript state", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const conversationId = "conv-token-ledger-replay";

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
    let resumedShutdown: (() => Promise<void>) | null = null;
    try {
      const first = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId,
        resumeConversation: false,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      firstShutdown = first.shutdown;

      first.rolloutStore.appendRollout(
        rolloutEvent(
          "usage",
          "token_count",
          {
            promptTokens: 1200,
            completionTokens: 450,
            totalTokens: 1650,
            cachedInputTokens: 300,
            cacheCreationInputTokens: 50,
            reasoningOutputTokens: 25,
            webSearchRequests: 1,
            model: "gpt-5.4",
            provider: "openai",
          },
          1,
        ),
      );
      first.rolloutStore.flushDurable();
      await first.shutdown();
      firstShutdown = null;

      const resumed = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      resumedShutdown = resumed.shutdown;

      const initialTranscriptEvents = resumed.session.getInitialTranscriptEvents();
      expect(
        initialTranscriptEvents.map((event) =>
          typeof event === "object" && event !== null
            ? (event as { readonly type?: unknown }).type
            : undefined,
        ),
      ).toEqual(expect.arrayContaining(["token_count"]));

      const transcript = adaptTranscriptEvents(
        initialTranscriptEvents as Parameters<typeof adaptTranscriptEvents>[0],
      );
      expect(
        transcript.messages.some(
          (message) =>
            message.type === "system" &&
            typeof message.content === "string" &&
            message.content.startsWith("Token ledger update:"),
        ),
      ).toBe(true);
    } finally {
      await resumedShutdown?.().catch(() => {
        /* best effort */
      });
      await firstShutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("routes conversation manager submit through a bootstrapped turn driver", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const conversationId = "conv-conversation-submit";

    const providerResponse = {
      content: "driver reply",
      toolCalls: [],
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
      model: "test-model",
      finishReason: "stop",
    };
    const directChatStream = vi.fn(async () => ({
      ...providerResponse,
      content: "direct reply",
    }));
    const prewarmedChatStream = vi.fn(async () => providerResponse);
    const disposePrewarm = vi.fn(async () => {});
    const prewarmStartup = vi.fn(async () => ({
      chatStream: prewarmedChatStream,
      dispose: disposePrewarm,
    }));
    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => providerResponse,
          chatStream: directChatStream,
          prewarmStartup,
          healthCheck: async () => true,
        }) as never,
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    let bootSession: Session | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId,
        resumeConversation: false,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;
      bootSession = boot.session;

      const phaseEvents: Array<{ readonly type: string }> = [];
      boot.session.installTurnDriverHooks({
        submit: async (message) => {
          for await (const event of boot.session.runTurn(message, {
            ctx: boot.session.newDefaultTurn(),
            systemPrompt: "",
          })) {
            phaseEvents.push(event);
            boot.session.emitPhaseEvent(event);
          }
        },
      });

      const manager = boot.session.services.conversationThreadManager;
      expect(manager).toBeDefined();
      await manager!.submitTurn(conversationId, {
        type: "user_input",
        input: "driver prompt",
      });

      expect(prewarmStartup).toHaveBeenCalledWith({
        conversationId,
        threadId: conversationId,
      });
      expect(prewarmedChatStream).toHaveBeenCalled();
      expect(directChatStream).not.toHaveBeenCalled();
      expect(disposePrewarm).toHaveBeenCalledTimes(1);
      expect(phaseEvents.some((event) => event.type === "turn_complete")).toBe(
        true,
      );
      const state = boot.session.state.unsafePeek();
      // User history entries carry the file-history join key since 07ae54e6
      // ("make conversation rewind restore files on disk").
      expect(state.history).toEqual([
        {
          role: "user",
          content: "driver prompt",
          runtimeOnly: { userMessageId: expect.stringMatching(/^user-msg-/) },
        },
        { role: "assistant", content: "driver reply" },
      ]);
      expect(manager!.snapshot(conversationId).historyLength).toBe(2);
      expect(
        boot.rolloutStore
          .readAll()
          .some(
            (item) =>
              item.type === "response_item" &&
              item.payload.role === "assistant" &&
              item.payload.content === "driver reply",
          ),
      ).toBe(true);
    } finally {
      bootSession?.installTurnDriverHooks(null);
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("disposes an unused provider startup prewarm handle during shutdown", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const disposePrewarm = vi.fn(async () => {});
    const providerResponse = {
      content: "ok",
      toolCalls: [],
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
      model: "test-model",
      finishReason: "stop",
    };

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => providerResponse,
          chatStream: async () => providerResponse,
          prewarmStartup: async () => ({
            chatStream: async () => providerResponse,
            dispose: disposePrewarm,
          }),
          healthCheck: async () => true,
        }) as never,
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId: "conv-unused-prewarm",
        resumeConversation: false,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      await boot.shutdown();
      shutdown = null;

      expect(disposePrewarm).toHaveBeenCalledTimes(1);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not consume a provider startup prewarm handle that resolves after the first turn", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const providerResponse = {
      content: "direct reply",
      toolCalls: [],
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
      model: "test-model",
      finishReason: "stop",
    };
    const directChatStream = vi.fn(async () => providerResponse);
    const lateChatStream = vi.fn(async () => ({
      ...providerResponse,
      content: "late reply",
    }));
    const disposeLate = vi.fn(async () => {});
    let resolvePrewarm!: (handle: {
      chatStream: typeof lateChatStream;
      dispose: typeof disposeLate;
    }) => void;
    const prewarmStartup = vi.fn(
      () =>
        new Promise<{
          chatStream: typeof lateChatStream;
          dispose: typeof disposeLate;
        }>((resolve) => {
          resolvePrewarm = resolve;
        }),
    );

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => providerResponse,
          chatStream: directChatStream,
          prewarmStartup,
          healthCheck: async () => true,
        }) as never,
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    let bootSession: Session | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId: "conv-late-prewarm",
        resumeConversation: false,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;
      bootSession = boot.session;
      boot.session.installTurnDriverHooks({
        submit: async (message) => {
          for await (const event of boot.session.runTurn(message, {
            ctx: boot.session.newDefaultTurn(),
            systemPrompt: "",
          })) {
            boot.session.emitPhaseEvent(event);
          }
        },
      });

      const manager = boot.session.services.conversationThreadManager!;
      await manager.submitTurn("conv-late-prewarm", {
        type: "user_input",
        input: "first",
      });
      expect(directChatStream).toHaveBeenCalledTimes(1);

      resolvePrewarm({
        chatStream: lateChatStream,
        dispose: disposeLate,
      });
      await Promise.resolve();
      await Promise.resolve();

      await manager.submitTurn("conv-late-prewarm", {
        type: "user_input",
        input: "second",
      });

      expect(directChatStream).toHaveBeenCalledTimes(2);
      expect(lateChatStream).not.toHaveBeenCalled();
      expect(disposeLate).toHaveBeenCalledTimes(1);
    } finally {
      bootSession?.installTurnDriverHooks(null);
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps a provider startup prewarm handle useful when it resolves before the first turn", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const providerResponse = {
      content: "prewarmed reply",
      toolCalls: [],
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
      model: "test-model",
      finishReason: "stop",
    };
    const directChatStream = vi.fn(async () => ({
      ...providerResponse,
      content: "direct reply",
    }));
    const prewarmedChatStream = vi.fn(async () => providerResponse);
    const disposePrewarm = vi.fn(async () => {});
    let resolvePrewarm!: (handle: {
      chatStream: typeof prewarmedChatStream;
      dispose: typeof disposePrewarm;
    }) => void;
    const prewarmStartup = vi.fn(
      () =>
        new Promise<{
          chatStream: typeof prewarmedChatStream;
          dispose: typeof disposePrewarm;
        }>((resolve) => {
          resolvePrewarm = resolve;
        }),
    );

    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(
      () =>
        ({
          name: "stub",
          chat: async () => providerResponse,
          chatStream: directChatStream,
          prewarmStartup,
          healthCheck: async () => true,
        }) as never,
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    let bootSession: Session | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId: "conv-ready-before-turn",
        resumeConversation: false,
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
        },
      });
      shutdown = boot.shutdown;
      bootSession = boot.session;
      expect(prewarmStartup).toHaveBeenCalledTimes(1);

      resolvePrewarm({
        chatStream: prewarmedChatStream,
        dispose: disposePrewarm,
      });
      await Promise.resolve();
      await Promise.resolve();

      boot.session.installTurnDriverHooks({
        submit: async (message) => {
          for await (const event of boot.session.runTurn(message, {
            ctx: boot.session.newDefaultTurn(),
            systemPrompt: "",
          })) {
            boot.session.emitPhaseEvent(event);
          }
        },
      });

      const manager = boot.session.services.conversationThreadManager!;
      await manager.submitTurn("conv-ready-before-turn", {
        type: "user_input",
        input: "first",
      });

      expect(prewarmedChatStream).toHaveBeenCalledTimes(1);
      expect(directChatStream).not.toHaveBeenCalled();
      expect(disposePrewarm).toHaveBeenCalledTimes(1);
    } finally {
      bootSession?.installTurnDriverHooks(null);
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("wires live bootstrap services instead of inert structural stubs", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const traceRoot = await mkdtemp(join(tmpdir(), "agenc-bootstrap-trace-"));
    const previousTraceRoot = process.env.AGENC_ROLLOUT_TRACE_ROOT;
    process.env.AGENC_ROLLOUT_TRACE_ROOT = traceRoot;

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
      trustWorkspaceForTest(home, workspace);
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "test-key",
        conversationId: "conv-services",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          HOME: home,
          SHELL: "/bin/sh",
        },
      });
      shutdown = boot.shutdown;

      const services = boot.session.services as typeof boot.session.services & {
        readonly modelClient: {
          setWindowGeneration(n: number): void;
          currentWindowGeneration(): number;
        };
        readonly rolloutTrace: {
          readonly enabled: boolean;
          readonly bundleDir?: string;
        };
      };

      expect(services.rollout).toBeDefined();
      expect(services.rollout?.rolloutPath()).toBe(boot.rolloutStore.rolloutPath);
      await services.rollout?.record({
        type: "session_state",
        payload: { bootstrapServiceProbe: true },
      });
      expect(
        boot.rolloutStore
          .readAll()
          .some(
            (item) =>
              item.type === "session_state" &&
              item.payload.bootstrapServiceProbe === true,
          ),
      ).toBe(true);

      await services.threadStore.setThreadName("conv-services", "Service Probe");
      await expect(services.threadStore.threadName("conv-services")).resolves.toBe(
        "Service Probe",
      );

      expect(services.rolloutTrace.enabled).toBe(true);
      expect(services.rolloutTrace.bundleDir).toBeDefined();
      const traceLog = await readFile(
        join(services.rolloutTrace.bundleDir!, "trace.jsonl"),
        "utf8",
      );
      expect(traceLog).toContain("\"type\":\"thread_started\"");

      const shellSnapshot = services.shellSnapshotTx.value as {
        readonly cwd?: string;
        readonly shell?: string;
      };
      expect(shellSnapshot.cwd).toBe(workspace);
      expect(shellSnapshot.shell).toBe("/bin/sh");

      services.modelClient.setWindowGeneration(7);
      expect(services.modelClient.currentWindowGeneration()).toBe(7);

      expect(services.execPolicy.current()).toMatchObject({
        cwd: workspace,
        approvalPolicy: "on_request",
        sandboxPolicy: "workspace_write",
      });
      expect(services.authManager).toEqual({ mode: "bearer_key" });
      expect(services.codeModeService.enabled()).toBe(false);
      await expect(
        services.hooks.executePreCompact({
          trigger: "manual",
          customInstructions: null,
        }),
      ).resolves.toEqual({});
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      if (previousTraceRoot === undefined) {
        delete process.env.AGENC_ROLLOUT_TRACE_ROOT;
      } else {
        process.env.AGENC_ROLLOUT_TRACE_ROOT = previousTraceRoot;
      }
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
      await rm(traceRoot, { recursive: true, force: true });
    }
  });

  it("builds runtime ManagedFeatures from config feature tables", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    await writeFile(
      join(home, "config.toml"),
      [
        "[features]",
        "apps = false",
        "use_legacy_landlock = true",
        "",
      ].join("\n"),
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

      expect(boot.config.features.enabled?.("apps")).toBe(false);
      expect(boot.config.features.appsEnabledForAuth(true)).toBe(false);
      expect(boot.config.features.enabled?.("use_legacy_landlock")).toBe(true);
      expect(boot.config.features.useLegacyLandlock()).toBe(true);
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
      expect(startMcpSpy).toHaveBeenCalledWith(boot.mcpManager, {
        signal: boot.session.services.mcpStartupCancellationToken.signal,
      });
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
        fetchImpl: offlineFetchFixture(),
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
      // Note: when `AGENC_PROVIDER` overrides `model_provider` while the
      // base config still carries the default `model: "grok-4.5"`,
      // `configuredModelForProvider` keeps that explicit model rather
      // than falling back to the openai default. The test focuses on
      // provider + api-key resolution, not model defaulting.
      expect(createProviderSpy).toHaveBeenCalledWith(
        "openai",
        expect.objectContaining({
          apiKey: "openai-test-key",
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

  // branding-scan: allow real provider identifier in test title
  it("classifies no-key generic OpenAI-compatible startup as local no-auth", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const restoreEnv = clearProcessEnv([
      "OPENAI_API_KEY",
      "OPENAI_API_BASE",
      "OPENAI_BASE_URL",
      "OPENAI_MODEL",
      "OPENAI_COMPATIBLE_API_KEY",
      "OPENAI_COMPATIBLE_BASE_URL",
      "OPENAI_COMPATIBLE_MODEL",
    ]);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: "local-model",
            max_model_len: 65_536,
            max_output_tokens: 8_192,
          },
        ],
      }),
    );
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        env: {
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          AGENC_PROVIDER: "openai-compatible",
          OPENAI_COMPATIBLE_MODEL: "local-model",
          HOME: home,
          SHELL: "/bin/sh",
        },
        argv: ["node", "agenc"],
      });
      shutdown = boot.shutdown;

      expect(boot.resolvedProvider).toBe("openai-compatible");
      expect(boot.model).toBe("local-model");
      expect(boot.session.services.authManager).toEqual({
        mode: "local_no_auth",
      });
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      restoreEnv();
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses AuthBackend-managed keys and subscription tier in provider startup", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const calls: string[] = [];
    const authBackend: AuthBackend = {
      login: () => ({ authenticated: true, provider: "local" }),
      logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "local" }),
      vendKey: (provider, sessionId) => {
        calls.push(`vendKey:${provider}:${sessionId}`);
        return {
          provider,
          sessionId,
          apiKey: "managed-key",
          baseUrl: "https://llm.agenc.tech",
        };
      },
      inferAgencModel: () => {
        calls.push("inferAgencModel");
        throw new Error("not expected");
      },
      getSubscriptionTier: ({ sessionId } = {}) => {
        calls.push(`getSubscriptionTier:${sessionId ?? ""}`);
        return "pro";
      },
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        authBackend,
        fetchImpl: offlineFetchFixture(),
        conversationId: "conv-auth",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_AUTH_MANAGED_KEYS_ENABLED: "true",
          // Managed subscription vending is live for OpenRouter only
          // (e4a54ec1 "route managed bootstrap through OpenRouter").
          AGENC_MODEL: "x-ai/grok-4.3",
          AGENC_PROVIDER: "openrouter",
          AGENC_WORKSPACE: workspace,
          AGENC_XAI_API_KEY: "",
          HOME: home,
          GROK_API_KEY: "",
          OPENROUTER_API_KEY: "",
          XAI_API_KEY: "",
        },
      });
      shutdown = boot.shutdown;

      expect(boot.authSubscriptionTier).toBe("pro");
      expect(createProviderSpy).toHaveBeenCalledWith(
        "openrouter",
        expect.objectContaining({
          apiKey: "managed-key",
          baseURL: "https://llm.agenc.tech",
          model: "openrouter/x-ai/grok-4.3",
        }),
      );
      expect(calls).toEqual([
        "getSubscriptionTier:conv-auth",
        "vendKey:openrouter:conv-auth",
      ]);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not vend managed keys during provider startup unless enabled", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const calls: string[] = [];
    const authBackend: AuthBackend = {
      login: () => ({ authenticated: true, provider: "local" }),
      logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "local" }),
      vendKey: (provider, sessionId) => {
        calls.push(`vendKey:${provider}:${sessionId}`);
        return { provider, sessionId, apiKey: "managed-key" };
      },
      inferAgencModel: () => {
        calls.push("inferAgencModel");
        throw new Error("not expected");
      },
      getSubscriptionTier: ({ sessionId } = {}) => {
        calls.push(`getSubscriptionTier:${sessionId ?? ""}`);
        return "pro";
      },
    };

    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    try {
      await expect(
        bootstrapLocalRuntimeSession({
          authBackend,
          conversationId: "conv-auth-disabled",
          env: {
            ...process.env,
            AGENC_HOME: home,
            AGENC_WORKSPACE: workspace,
            AGENC_XAI_API_KEY: "",
            AGENC_AUTH_MANAGED_KEYS_ENABLED: "false",
            // OpenRouter is the only provider with a live managed route, so
            // it is the only one that can surface the managed-keys-disabled
            // hint (other providers report "OpenRouter only" instead).
            AGENC_PROVIDER: "openrouter",
            HOME: home,
            GROK_API_KEY: "",
            OPENROUTER_API_KEY: "",
            XAI_API_KEY: "",
          },
        }),
      ).rejects.toThrow(/auth\.managedKeys\.enabled/);

      expect(calls).toEqual(["getSubscriptionTier:conv-auth-disabled"]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses locally saved BYOK keys before managed key vending", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const authBackend = new LocalAuthBackend({ agencHome: home });
    await authBackend.saveByokKey({
      provider: "grok",
      apiKey: "saved-xai-key",
    });

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
    const vendSpy = vi.spyOn(authBackend, "vendKey");

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        authBackend,
        conversationId: "conv-local-byok",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_AUTH_MANAGED_KEYS_ENABLED: "true",
          AGENC_WORKSPACE: workspace,
          AGENC_XAI_API_KEY: "",
          HOME: home,
          GROK_API_KEY: "",
          XAI_API_KEY: "",
        },
      });
      shutdown = boot.shutdown;

      expect(boot.resolvedProvider).toBe("grok");
      expect(createProviderSpy).toHaveBeenCalledWith(
        "grok",
        expect.objectContaining({
          apiKey: "saved-xai-key",
          model: "grok-4.5",
        }),
      );
      expect(vendSpy).not.toHaveBeenCalled();
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("does not vend managed keys when an explicit API key is provided", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const calls: string[] = [];
    const authBackend: AuthBackend = {
      login: () => ({ authenticated: true, provider: "local" }),
      logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "local" }),
      vendKey: (provider, sessionId) => {
        calls.push(`vendKey:${provider}:${sessionId}`);
        throw new Error("vendKey should not run");
      },
      inferAgencModel: () => {
        throw new Error("inferAgencModel should not run");
      },
      getSubscriptionTier: ({ sessionId } = {}) => {
        calls.push(`getSubscriptionTier:${sessionId ?? ""}`);
        return "pro";
      },
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        apiKey: "explicit-xai-key",
        authBackend,
        conversationId: "conv-explicit-byok",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_AUTH_MANAGED_KEYS_ENABLED: "true",
          AGENC_WORKSPACE: workspace,
          AGENC_XAI_API_KEY: "",
          HOME: home,
          GROK_API_KEY: "",
          XAI_API_KEY: "",
        },
      });
      shutdown = boot.shutdown;

      expect(createProviderSpy).toHaveBeenCalledWith(
        "grok",
        expect.objectContaining({
          apiKey: "explicit-xai-key",
        }),
      );
      expect(calls).toEqual(["getSubscriptionTier:conv-explicit-byok"]);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses locally saved BYOK keys without an injected auth backend", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    await new LocalAuthBackend({ agencHome: home }).saveByokKey({
      provider: "grok",
      apiKey: "saved-default-xai-key",
    });

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
        conversationId: "conv-default-local-byok",
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          AGENC_XAI_API_KEY: "",
          HOME: home,
          GROK_API_KEY: "",
          XAI_API_KEY: "",
        },
      });
      shutdown = boot.shutdown;

      expect(boot.resolvedProvider).toBe("grok");
      expect(createProviderSpy).toHaveBeenCalledWith(
        "grok",
        expect.objectContaining({
          apiKey: "saved-default-xai-key",
          model: "grok-4.5",
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

  it("asks AuthBackend to infer hosted AgenC model aliases before provider creation", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const calls: string[] = [];
    const authBackend: AuthBackend = {
      login: () => ({ authenticated: true, provider: "local" }),
      logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "local" }),
      vendKey: (provider, sessionId) => {
        calls.push(`vendKey:${provider}:${sessionId}`);
        return { provider, sessionId, apiKey: "managed-key" };
      },
      inferAgencModel: ({ provider, requestedModel, subscriptionTier } = {}) => {
        calls.push(
          `inferAgencModel:${provider ?? ""}:${requestedModel ?? ""}:${subscriptionTier ?? ""}`,
        );
        // Managed subscription vending is OpenRouter-only (e4a54ec1), so the
        // hosted alias resolves to the OpenRouter route.
        return {
          provider: "openrouter",
          model: "x-ai/grok-4.3",
          subscriptionTier,
        };
      },
      getSubscriptionTier: ({ sessionId } = {}) => {
        calls.push(`getSubscriptionTier:${sessionId ?? ""}`);
        return "team";
      },
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        authBackend,
        fetchImpl: offlineFetchFixture(),
        conversationId: "conv-hosted",
        argv: ["node", "agenc", "--provider", "grok", "--model", "agenc"],
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_AUTH_MANAGED_KEYS_ENABLED: "true",
          AGENC_WORKSPACE: workspace,
          AGENC_XAI_API_KEY: "",
          HOME: home,
          GROK_API_KEY: "",
          OPENROUTER_API_KEY: "",
          XAI_API_KEY: "",
        },
      });
      shutdown = boot.shutdown;

      expect(boot.authSubscriptionTier).toBe("team");
      expect(boot.resolvedProvider).toBe("openrouter");
      expect(boot.model).toBe("x-ai/grok-4.3");
      expect(createProviderSpy).toHaveBeenCalledWith(
        "openrouter",
        expect.objectContaining({
          apiKey: "managed-key",
          model: "x-ai/grok-4.3",
        }),
      );
      expect(calls).toEqual([
        "getSubscriptionTier:conv-hosted",
        "inferAgencModel:grok:agenc:team",
        "vendKey:openrouter:conv-hosted",
      ]);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("constructs the hosted AgenC provider as the normal routing boundary", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    await writeFile(
      join(home, "config.toml"),
      [
        "[providers.grok]",
        'base_url = "http://127.0.0.1:8000/v1"',
        "",
      ].join("\n"),
      "utf8",
    );
    const calls: string[] = [];
    const authBackend: AuthBackend = {
      login: () => ({ authenticated: true, provider: "local" }),
      logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "local" }),
      vendKey: (provider, sessionId) => {
        calls.push(`vendKey:${provider}:${sessionId}`);
        return { provider, sessionId, apiKey: "managed-key" };
      },
      inferAgencModel: ({ provider, requestedModel, subscriptionTier } = {}) => {
        calls.push(
          `inferAgencModel:${provider ?? ""}:${requestedModel ?? ""}:${subscriptionTier ?? ""}`,
        );
        return {
          provider: "grok",
          model: "grok-4.3",
          subscriptionTier,
        };
      },
      getSubscriptionTier: ({ sessionId } = {}) => {
        calls.push(`getSubscriptionTier:${sessionId ?? ""}`);
        return "team";
      },
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
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    let shutdown: (() => Promise<void>) | null = null;
    try {
      const boot = await bootstrapLocalRuntimeSession({
        authBackend,
        fetchImpl: offlineFetchFixture(),
        conversationId: "conv-agenc-provider",
        argv: ["node", "agenc", "--provider", "agenc"],
        env: {
          ...process.env,
          AGENC_HOME: home,
          AGENC_WORKSPACE: workspace,
          AGENC_XAI_API_KEY: "",
          HOME: home,
          GROK_API_KEY: "",
          XAI_API_KEY: "",
        },
      });
      shutdown = boot.shutdown;

      expect(boot.resolvedProvider).toBe("agenc");
      expect(boot.config.model).toBeTruthy();
      expect(boot.modelInfo.slug).toBeTruthy();
      expect(boot.ctx.modelInfo.slug).toBeTruthy();
      expect(boot.initialState.sessionConfiguration.provider).toEqual({
        slug: "agenc",
      });
      expect(
        boot.initialState.sessionConfiguration.collaborationMode.model,
      ).toBeTruthy();
      expect(createProviderSpy).toHaveBeenCalledWith(
        "agenc",
        expect.objectContaining({
          baseURL: "http://127.0.0.1:8000/v1",
          model: "agenc",
          extra: expect.objectContaining({
            authBackend,
            sessionId: "conv-agenc-provider",
            subscriptionTier: "team",
          }),
        }),
      );
      expect(calls).toEqual([
        "getSubscriptionTier:conv-agenc-provider",
        "inferAgencModel:agenc:agenc:team",
      ]);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects hosted AgenC model inference responses with empty models", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    const authBackend: AuthBackend = {
      login: () => ({ authenticated: true, provider: "local" }),
      logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "local" }),
      vendKey: () => {
        throw new Error("vendKey should not run");
      },
      inferAgencModel: () => ({
        provider: "grok",
        model: "   ",
      }),
      getSubscriptionTier: () => "team",
    };

    try {
      await expect(
        bootstrapLocalRuntimeSession({
          authBackend,
          conversationId: "conv-empty-model",
          argv: ["node", "agenc", "--provider", "agenc"],
          env: {
            ...process.env,
            AGENC_HOME: home,
            AGENC_WORKSPACE: workspace,
            AGENC_XAI_API_KEY: "",
            HOME: home,
            GROK_API_KEY: "",
            XAI_API_KEY: "",
          },
        }),
      ).rejects.toThrow(/empty model/);
    } finally {
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
      expect(startMcpSpy).toHaveBeenCalledWith(boot.mcpManager, {
        signal: boot.session.services.mcpStartupCancellationToken.signal,
      });
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("hydrates the live MCP manager from config.toml mcp_servers when no env override is set", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    await writeFile(
      join(home, "config.toml"),
      `
[mcp_servers.github]
command = "github-mcp"
args = ["--stdio"]
timeout = 5000
required = true
      `,
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
          AGENC_MCP_SERVERS: "",
          HOME: home,
        },
      });
      shutdown = boot.shutdown;

      expect(boot.mcpManager.getConfiguredServers()).toEqual([
        expect.objectContaining({
          name: "github",
          command: "github-mcp",
          args: ["--stdio"],
          timeout: 5_000,
          required: true,
        }),
      ]);
      expect(startMcpSpy).toHaveBeenCalledWith(boot.mcpManager, {
        signal: boot.session.services.mcpStartupCancellationToken.signal,
      });
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

  it("strictly disposes root sandbox owners and retries retained failures", async () => {
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
      const broker = boot.session.services.sandboxExecutionBroker;
      if (broker === undefined) {
        throw new Error("bootstrap did not install its root sandbox broker");
      }

      const dispose = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("root process survived cleanup"))
        .mockResolvedValue(undefined);
      registerSandboxExecutionLifecycleParticipant(broker, {
        name: "test-root-process-owner",
        quiesce: async () => {},
        resume: async () => {},
        dispose,
      });

      const first = await Promise.allSettled([boot.shutdown(), boot.shutdown()]);
      expect(first).toEqual([
        expect.objectContaining({ status: "rejected" }),
        expect.objectContaining({ status: "rejected" }),
      ]);
      const firstError = first[0]?.status === "rejected"
        ? first[0].reason
        : undefined;
      expect(firstError).toBeInstanceOf(AggregateError);
      expect((firstError as AggregateError).errors).toEqual([
        expect.objectContaining({
          message: expect.stringContaining("test-root-process-owner"),
        }),
      ]);
      expect(dispose).toHaveBeenCalledOnce();
      expect(isSandboxExecutionBrokerDisposed(broker)).toBe(true);

      await expect(boot.shutdown()).resolves.toBeUndefined();
      await expect(boot.shutdown()).resolves.toBeUndefined();
      expect(dispose).toHaveBeenCalledTimes(2);
      shutdown = null;
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

  it("keeps untrusted project settings from relaxing bootstrap permissions", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    // Pin this temporary directory as the project root. Test runners and local
    // developer machines may legitimately have a root marker (for example a
    // package.json) higher in the system temp directory.
    await writeFile(join(workspace, "package.json"), "{}\n", "utf8");
    await writeFile(
      join(home, "config.toml"),
      'approval_policy = "never"\n',
      "utf8",
    );
    await mkdir(join(workspace, ".agenc"), { recursive: true });
    await writeFile(
      join(workspace, ".agenc", "settings.json"),
      JSON.stringify(
        {
          permissions: {
            defaultMode: "bypassPermissions",
            allow: ["Bash(*)"],
            ask: ["Read"],
            deny: ["Write"],
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
      const permissions = boot.session.permissionModeRegistry.current();

      expect(boot.initialState.sessionConfiguration.approvalPolicy.value).toBe(
        "untrusted",
      );
      expect(permissions.mode).toBe("default");
      expect(permissions.alwaysAllowRules.projectSettings ?? []).toEqual([]);
      expect(permissions.alwaysAskRules.projectSettings).toEqual(["Read"]);
      expect(permissions.alwaysDenyRules.projectSettings).toEqual(["Write"]);
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

  it("enforces the runtime bootstrap step ordering invariant", async () => {
    // Asserts the concrete step order the bin bootstrap is required to
    // follow, mirroring upstream agenc runtime
    // `core/src/session/session.rs:814-908, 931-942`:
    //
    //   1. Session construction (Session instance exists).
    //   2. Rollout store mounted on the session.
    //   3. History reconstruction: for a fresh session (no prior
    //      rollout items) this is observably complete when the rollout
    //      store's `readAll()` returns empty — i.e. the reconstruction
    //      phase finished without reading any items. This ordering
    //      marker runs right after the mount regardless of whether
    //      there is history to reconstruct.
    //   4. Sidecar manager constructed and sidecars registered.
    //   5. SessionConfigured event emitted.
    //   6. Sidecars started.
    //   7. MCP connection manager started.
    //   8. Startup prewarm runs (observable via
    //      `session.newDefaultTurn()` increment during
    //      `runStartupPrewarm`).
    //
    // Steps 5 (SessionConfigured) and 6/7 (sidecar start + MCP start)
    // specifically follow the upstream rule "Dispatch the
    // SessionConfiguredEvent first and then report any errors"
    // (session.rs:814) — the emit must precede the real MCP manager
    // wiring.
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

    const ordering: string[] = [];
    // Capture the originals before spying so the spies can delegate
    // back to the real implementation without triggering themselves.
    const originalMount = Session.prototype.mountRolloutStore;
    const originalEmit = Session.prototype.emit;
    const originalSidecarStart = SidecarManager.prototype.start;
    const originalNewDefaultTurn = Session.prototype.newDefaultTurn;

    const mountSpy = vi
      .spyOn(Session.prototype, "mountRolloutStore")
      .mockImplementation(function (
        this: Session,
        store: Parameters<Session["mountRolloutStore"]>[0],
      ) {
        ordering.push("rollout_store_mounted");
        return originalMount.call(this, store);
      });

    const emitSpy = vi
      .spyOn(Session.prototype, "emit")
      .mockImplementation(function (
        this: Session,
        event: Parameters<Session["emit"]>[0],
      ) {
        if (event.msg.type === "session_configured") {
          ordering.push("session_configured_emitted");
        }
        return originalEmit.call(this, event);
      });

    const sidecarStartSpy = vi
      .spyOn(SidecarManager.prototype, "start")
      .mockImplementation(async function (
        this: SidecarManager,
        log: Parameters<SidecarManager["start"]>[0],
      ) {
        ordering.push("sidecars_started");
        return originalSidecarStart.call(this, log);
      });

    const mcpStartSpy = vi
      .spyOn(Session.prototype, "startMcpManager")
      .mockImplementation(async function () {
        ordering.push("mcp_manager_started");
        // Don't actually start MCP — it's not relevant to the ordering
        // assertion and keeps the test hermetic.
      });

    const prewarmSpy = vi
      .spyOn(Session.prototype, "newDefaultTurn")
      .mockImplementation(function (
        this: Session,
        ...args: Parameters<Session["newDefaultTurn"]>
      ) {
        ordering.push("prewarm_ran");
        return originalNewDefaultTurn.apply(this, args);
      });

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

      // All the instrumented steps must have fired at least once.
      expect(mountSpy).toHaveBeenCalled();
      expect(emitSpy).toHaveBeenCalled();
      expect(sidecarStartSpy).toHaveBeenCalled();
      expect(mcpStartSpy).toHaveBeenCalled();
      expect(prewarmSpy).toHaveBeenCalled();

      const idx = (label: string): number => ordering.indexOf(label);

      // The recorded step order must match the upstream agenc runtime
      // contract: each step happens strictly before the next. Every
      // label must have been recorded (index >= 0).
      const mountIdx = idx("rollout_store_mounted");
      const configuredIdx = idx("session_configured_emitted");
      const sidecarIdx = idx("sidecars_started");
      const mcpIdx = idx("mcp_manager_started");
      const prewarmIdx = idx("prewarm_ran");

      expect(mountIdx).toBeGreaterThanOrEqual(0);
      expect(configuredIdx).toBeGreaterThan(mountIdx);
      expect(sidecarIdx).toBeGreaterThan(configuredIdx);
      expect(mcpIdx).toBeGreaterThan(sidecarIdx);
      expect(prewarmIdx).toBeGreaterThan(mcpIdx);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves explicit approval config after project trust is accepted", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-bootstrap-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "agenc-bootstrap-ws-"));
    await writeFile(
      join(home, "config.toml"),
      'approval_policy = "never"\n',
      "utf8",
    );
    trustWorkspaceForTest(home, workspace);

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

      expect(boot.initialState.sessionConfiguration.approvalPolicy.value).toBe(
        "never",
      );
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
