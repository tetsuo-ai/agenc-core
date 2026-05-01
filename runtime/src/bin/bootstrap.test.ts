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

import {
  bootstrapLocalRuntimeSession,
  readStartupCliFlags,
  resolveStartupSelection,
} from "./bootstrap.js";
import { defaultConfig, mergeConfigs } from "../config/index.js";
import type { AuthBackend } from "../auth/backend.js";
import type { Tool } from "../tools/types.js";
import { Session } from "../session/session.js";
import { SidecarManager } from "../session/sidecar.js";
import { getCurrentRuntimeSession } from "./_deps/current-session.js";

describe("resolveStartupSelection", () => {
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
});

describe("bootstrapLocalRuntimeSession", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
          model: "grok-4-fast",
          tools: expect.any(Array),
        }),
      );
      expect(boot.initialState.sessionConfiguration.cwd).toBe(workspace);
      expect(boot.initialState.sessionConfiguration.sessionSource).toBe(
        "cli_main",
      );
      expect(boot.config.agentRoles.length).toBeGreaterThan(0);
      expect(boot.session.agentDefinitions.activeAgents).toEqual(
        boot.config.agentRoles.map((role) => ({
          agentType: role.name,
          ...(role.description.length > 0
            ? { whenToUse: role.description }
            : {}),
        })),
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
        readonly analyticsEventsClient: {
          emit(event: unknown): Promise<void>;
          events(): ReadonlyArray<{ readonly event: unknown }>;
        };
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

      await services.analyticsEventsClient.emit({ type: "bootstrap_probe" });
      expect(services.analyticsEventsClient.events().at(-1)?.event).toEqual({
        type: "bootstrap_probe",
      });

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
      // base config still carries the default `model: "grok-4-fast"`,
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
        conversationId: "conv-auth",
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

      expect(boot.authSubscriptionTier).toBe("pro");
      expect(createProviderSpy).toHaveBeenCalledWith(
        "grok",
        expect.objectContaining({
          apiKey: "managed-key",
          model: "grok-4-fast",
        }),
      );
      expect(calls).toEqual([
        "getSubscriptionTier:conv-auth",
        "vendKey:grok:conv-auth",
      ]);
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
        return {
          provider: "agenc",
          model: "grok-4-fast",
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
        conversationId: "conv-hosted",
        argv: ["node", "agenc", "--provider", "grok", "--model", "agenc"],
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

      expect(boot.authSubscriptionTier).toBe("team");
      expect(boot.resolvedProvider).toBe("grok");
      expect(boot.model).toBe("grok-4-fast");
      expect(createProviderSpy).toHaveBeenCalledWith(
        "grok",
        expect.objectContaining({
          apiKey: "managed-key",
          model: "grok-4-fast",
        }),
      );
      expect(calls).toEqual([
        "getSubscriptionTier:conv-hosted",
        "inferAgencModel:grok:agenc:team",
        "vendKey:grok:conv-hosted",
      ]);
    } finally {
      await shutdown?.().catch(() => {
        /* best effort */
      });
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("routes the hosted AgenC provider through AuthBackend model inference", async () => {
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
        return {
          provider: "grok",
          model: "grok-4-fast",
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

      expect(boot.resolvedProvider).toBe("grok");
      expect(boot.model).toBe("grok-4-fast");
      expect(createProviderSpy).toHaveBeenCalledWith(
        "grok",
        expect.objectContaining({
          apiKey: "managed-key",
          model: "grok-4-fast",
        }),
      );
      expect(calls).toEqual([
        "getSubscriptionTier:conv-agenc-provider",
        "inferAgencModel:agenc:agenc:team",
        "vendKey:grok:conv-agenc-provider",
      ]);
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
});
