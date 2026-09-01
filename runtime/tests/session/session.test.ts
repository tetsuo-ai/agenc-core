/**
 * T11 Wave 3-A integration tests for `Session` and the turn-context
 * plumbing that consumes the per-session permission-mode registry.
 *
 * Covers:
 *   - `SessionServices.permissionModeRegistry` default bootstrap when the
 *     caller omits it (tests used to loose-cast through `unknown`).
 *   - `Session.setPendingProviderSwitch(...)` typed mutator honours the
 *     null-clear path.
 *   - `TurnContext.permissionMode` is the I-30 snapshot of the registry
 *     at `buildTurnContext` time.
 *   - Mutating the registry AFTER the TurnContext is built does NOT
 *     mutate the pinned per-turn snapshot (I-30 invariant).
 *   - `isPlanMode` returns true when `permissionContext.mode === "plan"`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRealtimeSessionConfig,
  type RealtimeEvent,
  type RealtimeTransportConnection,
  type RealtimeWriter,
} from "../conversation/realtime/conversation.js";
import { AsyncQueue } from "../utils/async-queue.js";
import {
  DEFAULT_LEGACY_EVENT_QUEUE_DEPTH,
  Session,
  type Event,
  type PendingProviderSwitch,
  type SessionOpts,
  type SessionServices,
} from "./session.js";
import type { PendingWorktreeState } from "./pending-worktree.js";
import {
  buildTurnContext,
  newDefaultTurnWithSubId,
  type Config,
  type ManagedFeatures,
  type ModelInfo,
  type NetworkProxy,
  type SessionConfiguration,
  type SessionForTurn,
} from "./turn-context.js";
import { isPlanMode } from "./plan-mode.js";
import type { TurnContext } from "./turn-context.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import {
  _resetAttachmentTrackingStateForTest,
  getAttachmentTrackingState,
} from "./attachment-state.js";
import {
  createEmptyToolPermissionContext,
  type PermissionMode,
  type ToolPermissionContext,
} from "../permissions/types.js";
import type { LLMContentPart, LLMMessage, LLMProvider } from "../llm/types.js";
import { ProviderHttpClient } from "../llm/client.js";
import {
  createProvider,
  isFactoryProvider,
  readProviderFactoryOptions,
  readProviderIdentity,
} from "../llm/provider.js";
import { createGeminiEndpointPlan } from "../llm/providers/gemini/endpoint-plan.js";
import type { AuthBackend } from "../auth/backend.js";
import { clearSession } from "../commands/clear.js";
import {
  createCsvAgentInvocationEnvelope,
  materializeAgentInvocationMessages,
} from "../contracts/agent-invocation-envelope.js";
import {
  createCompactionTransactionHarness,
  createProvider as createCompactionProvider,
} from "../helpers/compaction-transaction-harness.js";
import { CompactionReconstructionRequiredError } from "../services/compact/transaction-types.js";
import {
  getSessionTempNamespaceName,
  resolveAgentRuntimeOptions,
  runWithAgentRuntimeOptions,
} from "./runtime-options.js";
import { runWithCurrentRuntimeSession } from "./current-session.js";
import {
  clearSessionReadState,
  recordSessionRead,
} from "../tools/system/filesystem.js";
import { extractBundledSkillFiles } from "../skills/bundled-extraction-registry.js";
import { getCurrentBundledSkillExtractionRoot } from "../skills/bundled-root-authority.js";
import { ConfigStore } from "../config/store.js";
import { runWithCanonicalSettingsAuthority } from "../utils/settings/canonicalAuthority.js";
import { SessionProviderService } from "./provider-service.js";
import { resolveProviderRuntimeRequest } from "../llm/provider-request.js";
import { isFreeSubscriptionManagedModel } from "../commands/subscription-managed-models.js";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "../prompts/system-prompt-boundary.js";

(globalThis as Record<string, unknown>).MACRO ??= {
  VERSION: "test-version",
  DISPLAY_VERSION: "test-version",
  BUILD_TIME: "test-build-time",
  ISSUES_EXPLAINER: "open an issue",
  PACKAGE_URL: "@tetsuo-ai/agenc",
  NATIVE_PACKAGE_URL: undefined,
  FEEDBACK_CHANNEL: "support",
};

// ─────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────

function mkFeatures(): ManagedFeatures {
  return {};
}

function mkConfig(model = "test-model"): Config {
  return {
    model,
    cwd: "/tmp",
    features: mkFeatures(),
    multiAgentV2: {
      usageHintEnabled: false,
      usageHintText: "",
      hideSpawnAgentMetadata: false,
    },
    permissions: {
      allowLoginShell: false,
      shellEnvironmentPolicy: {
        allowedEnvVars: [],
        blockedEnvVars: [],
      },
      windowsSandboxPrivateDesktop: false,
    },
    ghostSnapshot: { enabled: false },
    agentRoles: [],
  };
}

function mkModelInfo(model = "test-model"): ModelInfo {
  return {
    slug: model,
    effectiveContextWindowPercent: 100,
    contextWindow: 131_072,
    supportedReasoningLevels: [],
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
  };
}

function mkSessionConfiguration(model = "test-model"): SessionConfiguration {
  return {
    cwd: "/tmp",
    approvalPolicy: { value: "never" },
    sandboxPolicy: { value: "read_only" },
    fileSystemSandboxPolicy: {
      allowWrite: [],
      denyWrite: [],
      allowRead: [],
      denyRead: [],
    },
    networkSandboxPolicy: {
      allowlist: [],
      denylist: [],
      allowManagedDomainsOnly: false,
    },
    windowsSandboxLevel: "none",
    collaborationMode: { model },
    dynamicTools: [],
    sessionSource: "cli_main",
  };
}

function mkProvider(): LLMProvider {
  return {
    name: "openai-compatible",
    chat: async () => ({
      content: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "test-model",
      finishReason: "stop",
    }),
    chatStream: async () => ({
      content: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "test-model",
      finishReason: "stop",
    }),
  } as unknown as LLMProvider;
}

function verboseHistoryText(prefix: string): string {
  return Array.from({ length: 300 }, (_, index) => `${prefix}-${index}`).join(
    " ",
  );
}

function mkNetworkProxy(): NetworkProxy {
  return {
    httpsProxy: "http://127.0.0.1:9050",
    policyDecider: {
      decide: () => ({ decision: "allow" }),
    },
    blockedRequestObserver: {
      onBlockedRequest: () => undefined,
    },
  };
}

function mkProviderWithClient(client: ProviderHttpClient): LLMProvider {
  return {
    ...mkProvider(),
    client,
  } as unknown as LLMProvider;
}

/**
 * Minimal `Session` builder for the W3 integration tests. Mirrors the
 * loose-cast approach in `idle-input.test.ts` while supplying the canonical
 * permission registry required by every live session.
 */
function buildSession(
  overrides: {
    services?: Partial<SessionServices>;
    eventQueue?: AsyncQueue<Event> | null;
    sessionConfiguration?: SessionConfiguration;
    config?: Config;
    modelInfo?: ModelInfo;
    mcpManagerOwnership?: SessionOpts["mcpManagerOwnership"];
    readSavedApiKey?: (provider: string) => Promise<string | undefined>;
  } = {},
): Session {
  const initialProvider = overrides.services?.provider ?? mkProvider();
  const initialProviderModel =
    readProviderFactoryOptions(initialProvider).model ?? "test-model";
  const config = overrides.config ?? mkConfig(initialProviderModel);
  const suppliedConfigStore = overrides.services?.configStore;
  const configStore =
    suppliedConfigStore instanceof ConfigStore
      ? suppliedConfigStore
      : new ConfigStore({
          home: join(tmpdir(), "agenc-session-test-home"),
          cwd: config.cwd,
          env: {},
          ...(suppliedConfigStore === undefined
            ? {}
            : { base: suppliedConfigStore.current() }),
        });
  const services = {
    admissionRequired: false,
    mcpConnectionManager: {
      setApprovalPolicy: () => {},
      setSandboxPolicy: () => {},
      requiredStartupFailures: async () => [],
    },
    mcpStartupCancellationToken: {
      cancel: () => {},
      isCancelled: () => false,
    },
    agentControl: {
      shutdownAgentTree: vi.fn(),
    },
    configStore,
    runtimeOptions: resolveAgentRuntimeOptions(
      {},
      {
        pluginStorageRoot: join(tmpdir(), "agenc-session-test-plugins"),
      },
    ),
    permissionModeRegistry: new PermissionModeRegistry(
      ctxWithPermissionMode("default"),
    ),
    provider: initialProvider,
    providerEnvironment: {
      OPENAI_API_KEY: "test-key",
      XAI_API_KEY: "test-key",
    },
    registry: {
      tools: [],
      toLLMTools: () => [],
      dispatch: async () => ({ content: "", isError: false }),
    },
    ...(overrides.services ?? {}),
    configStore,
  } as unknown as SessionServices;
  const initialSessionConfiguration =
    overrides.sessionConfiguration ??
    mkSessionConfiguration(initialProviderModel);
  const providerEnvironment = services.providerEnvironment ?? {};
  const providerService =
    services.providerService ??
    new SessionProviderService({
      initialProvider: services.provider,
      ...(initialSessionConfiguration.provider?.slug !== undefined
        ? { initialProviderName: initialSessionConfiguration.provider.slug }
        : {}),
      ...(initialSessionConfiguration.collaborationMode.model !== undefined
        ? { initialModel: initialSessionConfiguration.collaborationMode.model }
        : {}),
      environment: providerEnvironment,
      ...(overrides.readSavedApiKey !== undefined
        ? { readSavedApiKey: overrides.readSavedApiKey }
        : {}),
      ...(services.authBackend !== undefined
        ? { authBackend: services.authBackend }
        : {}),
      sessionId: "conv-test",
      ...(services.authSubscriptionTier !== undefined
        ? { subscriptionTier: services.authSubscriptionTier }
        : {}),
      resolvePreparationRequest: (selection) => {
        const currentConfig = configStore.current();
        const runtimeRequest = resolveProviderRuntimeRequest({
          provider: selection.provider,
          model: selection.model,
          config: currentConfig,
          environment: providerEnvironment,
          ...(configStore instanceof ConfigStore
            ? { credentialHome: configStore.homeContext }
            : {}),
          executionAdmissionRequired: services.admissionRequired !== false,
        });
        return {
          requested: runtimeRequest.requested,
          runtime: {
            managedKeysEnabled:
              currentConfig.auth?.managedKeys?.enabled === true,
            freeManagedCredential:
              services.authSubscriptionTier === "free" &&
              isFreeSubscriptionManagedModel(
                selection.provider,
                selection.model,
              ),
            applyManagedDefaultOutputCap:
              selection.provider === "openrouter" &&
              runtimeRequest.settings?.maxOutputTokens === undefined,
          },
        };
      },
    });
  const servicesWithProviderAuthority = {
    ...services,
    providerService,
  };
  const opts: SessionOpts = {
    conversationId: "conv-test",
    initialState: {
      sessionConfiguration: initialSessionConfiguration,
      history: [],
    },
    features: mkFeatures(),
    services: servicesWithProviderAuthority,
    ...(overrides.mcpManagerOwnership !== undefined
      ? { mcpManagerOwnership: overrides.mcpManagerOwnership }
      : {}),
    jsRepl: { id: "repl-test" },
    config,
    modelInfo: overrides.modelInfo ?? mkModelInfo(initialProviderModel),
    ...(overrides.eventQueue === null
      ? {}
      : { eventQueue: overrides.eventQueue ?? new AsyncQueue<Event>() }),
  };
  return new Session(opts);
}

function consumePendingProviderSwitch(session: Session) {
  return runWithCurrentRuntimeSession(session, () =>
    runWithCanonicalSettingsAuthority(session.services.configStore, () =>
      session.consumePendingProviderSwitch(),
    ),
  );
}

function consumePendingProviderSwitchTransaction(session: Session) {
  return runWithCurrentRuntimeSession(session, () =>
    runWithCanonicalSettingsAuthority(session.services.configStore, () =>
      session.consumePendingProviderSwitchTransaction(),
    ),
  );
}

function prepareProviderSwitch(
  session: Session,
  pending: PendingProviderSwitch,
) {
  return runWithCurrentRuntimeSession(session, () =>
    runWithCanonicalSettingsAuthority(session.services.configStore, () =>
      session.prepareProviderSwitch(pending),
    ),
  );
}

function providerHttpClient(binding: { readonly instance: LLMProvider }) {
  const candidate = (binding.instance as { readonly client?: unknown }).client;
  return candidate instanceof ProviderHttpClient ? candidate : undefined;
}

function buildProviderSwitchTestSession(): Session {
  return buildSession({
    services: {
      provider: createProvider("grok", {
        apiKey: "test-key",
        model: "grok-4",
      }),
    },
  });
}

async function stageProviderSwitchForTest(
  session: Session,
  model = "grok-4.3",
) {
  const pending = Object.freeze({ provider: "grok", model });
  const prepared = await prepareProviderSwitch(session, pending);
  session.stagePreparedProviderSwitch(prepared, null);
  return { pending, prepared };
}

function ctxWithPermissionMode(mode: PermissionMode): ToolPermissionContext {
  return {
    ...createEmptyToolPermissionContext(),
    mode,
  };
}

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => Promise<T> | T,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// SessionServices.permissionModeRegistry authority
// ─────────────────────────────────────────────────────────────────────

describe("SessionServices.permissionModeRegistry authority", () => {
  it("rejects construction when services.permissionModeRegistry is omitted", () => {
    expect(() =>
      buildSession({
        services: {
          permissionModeRegistry:
            undefined as unknown as PermissionModeRegistry,
        },
      }),
    ).toThrow("Session requires services.permissionModeRegistry");
  });

  it("populates the default querySource when omitted", () => {
    const session = buildSession();

    expect(session.services.querySource).toBe("repl_main_thread");
  });

  it("bounds the default legacy event queue when no caller supplies one", () => {
    const session = buildSession({ eventQueue: null });

    for (
      let index = 0;
      index < DEFAULT_LEGACY_EVENT_QUEUE_DEPTH + 2;
      index += 1
    ) {
      session.emit({
        id: `evt-${index}`,
        msg: {
          type: "warning",
          payload: {
            cause: "test",
            message: `event ${index}`,
          },
        },
      });
    }

    expect(session.txEvent.size).toBe(DEFAULT_LEGACY_EVENT_QUEUE_DEPTH);
  });

  it("preserves a caller-supplied registry instead of replacing it", () => {
    const supplied = new PermissionModeRegistry(
      ctxWithPermissionMode("acceptEdits"),
    );
    const session = buildSession({
      services: { permissionModeRegistry: supplied },
    });
    expect(session.services.permissionModeRegistry).toBe(supplied);
    expect(session.services.permissionModeRegistry.current().mode).toBe(
      "acceptEdits",
    );
  });

  it("hydrates active agent definitions from the session role catalog", () => {
    const session = buildSession({
      config: {
        ...mkConfig(),
        agentRoles: [
          { name: "runner", description: "Implementation work" },
          { name: "scanner", description: "" },
        ],
      },
    });

    expect(session.agentDefinitions.activeAgents).toEqual([
      expect.objectContaining({
        agentType: "runner",
        whenToUse: "Implementation work",
        agentRoleFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
      expect.objectContaining({
        agentType: "scanner",
        agentRoleFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Session.setPendingProviderSwitch
// ─────────────────────────────────────────────────────────────────────

describe("Session.setPendingProviderSwitch", () => {
  it("assigns a well-typed pending switch record", () => {
    const session = buildSession();
    const pending: PendingProviderSwitch = {
      provider: "grok",
      model: "grok-4.3",
    };
    session.setPendingProviderSwitch(pending);
    expect(session.pendingProviderSwitch).toEqual(pending);
  });

  it("clears the slot when passed null", () => {
    const session = buildSession();
    session.setPendingProviderSwitch({
      provider: "grok",
      model: "grok-4.3",
    });
    expect(session.pendingProviderSwitch).not.toBeNull();
    session.setPendingProviderSwitch(null);
    expect(session.pendingProviderSwitch).toBeNull();
  });

  it("round-trips the optional profile slot (T11 W2 extension)", () => {
    const session = buildSession();
    session.setPendingProviderSwitch({
      provider: "grok",
      model: "grok-4.3",
      profile: "coding",
    });
    expect(session.pendingProviderSwitch?.profile).toBe("coding");
  });
});

describe("Session provider continuity hooks", () => {
  it("binds the session conversation id onto ProviderHttpClient-backed providers at construction", () => {
    const client = new ProviderHttpClient({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      fetchImpl: vi.fn<typeof fetch>(),
    });
    const bindSpy = vi.spyOn(client, "bindConversationId");

    buildSession({
      services: {
        provider: mkProviderWithClient(client),
      },
    });

    expect(bindSpy).toHaveBeenCalledWith("conv-test");
  });

  it("clears shared previous_response_id state synchronously on compaction events", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "resp_1",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "hi" }],
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "resp_2", output: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const client = new ProviderHttpClient({
      providerName: "openai",
      baseURL: "https://example.test/v1",
      wireApi: "responses",
      fetchImpl,
    });
    const session = buildSession({
      services: {
        provider: mkProviderWithClient(client),
      },
    });

    await client.createTurnSession().requestJson({
      body: {
        model: "gpt-5",
        input: [{ type: "message", role: "user", content: [] }],
        stream: false,
      },
    });
    session.emit({
      id: "sub-compact",
      msg: {
        type: "compacted",
        payload: { message: "compacted" },
      } as never,
    });
    await client.createTurnSession().requestJson({
      body: {
        model: "gpt-5",
        input: [
          { type: "message", role: "user", content: [] },
          { type: "message", role: "assistant", content: [] },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "after compact" }],
          },
        ],
        stream: false,
      },
    });

    const secondBody = JSON.parse(
      String((fetchImpl.mock.calls[1]?.[1] as RequestInit | undefined)?.body),
    ) as Record<string, unknown>;
    expect(secondBody.previous_response_id).toBeUndefined();
  });
});

describe("Session.setPendingWorktreeState", () => {
  it("stores and clears the active worktree binding", () => {
    const session = buildSession();
    expect(session.roleWorkspace.id).toBe("/tmp");
    const pending: PendingWorktreeState = {
      handle: {
        path: "/repo/.agenc-worktrees/feat",
        branch: "worktree-feat",
        gitRoot: "/repo",
        created: true,
      },
      baseCommit: "abc123",
      originalCwd: "/repo",
    };

    session.setPendingWorktreeState(pending);
    expect(session.pendingWorktreeState).toEqual(pending);
    expect(session.sessionConfiguration.cwd).toBe(
      "/repo/.agenc-worktrees/feat",
    );
    expect(session.roleWorkspace.id).toBe("/tmp");

    session.setPendingWorktreeState(null);
    expect(session.pendingWorktreeState).toBeNull();
    expect(session.sessionConfiguration.cwd).toBe("/repo");
    expect(session.roleWorkspace.id).toBe("/tmp");
  });
});

describe("Session attachment exit-pulse wiring", () => {
  it("flips needsPlanModeExitAttachment on plan→non-plan transition", async () => {
    const registry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({ mode: "plan" }),
    );
    const session = buildSession({
      services: { permissionModeRegistry: registry },
    });

    // Fresh tracking state — no pending pulse before transition.
    const before = getAttachmentTrackingState(session);
    expect(before.needsPlanModeExitAttachment).toBe(false);

    await registry.update(
      createEmptyToolPermissionContext({ mode: "default" }),
    );

    expect(
      getAttachmentTrackingState(session).needsPlanModeExitAttachment,
    ).toBe(true);

    _resetAttachmentTrackingStateForTest(session);
  });

  it("flips needsAutoModeExitAttachment on auto→non-auto transition", async () => {
    const registry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({ mode: "auto" }),
    );
    const session = buildSession({
      services: { permissionModeRegistry: registry },
    });

    expect(
      getAttachmentTrackingState(session).needsAutoModeExitAttachment,
    ).toBe(false);

    await registry.update(
      createEmptyToolPermissionContext({ mode: "default" }),
    );

    expect(
      getAttachmentTrackingState(session).needsAutoModeExitAttachment,
    ).toBe(true);

    _resetAttachmentTrackingStateForTest(session);
  });

  it("does not raise the plan-exit flag for plan→plan no-op transitions", async () => {
    const registry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({ mode: "plan" }),
    );
    const session = buildSession({
      services: { permissionModeRegistry: registry },
    });

    await registry.update(createEmptyToolPermissionContext({ mode: "plan" }));

    expect(
      getAttachmentTrackingState(session).needsPlanModeExitAttachment,
    ).toBe(false);

    _resetAttachmentTrackingStateForTest(session);
  });

  it("does not raise the plan-exit flag when entering plan mode", async () => {
    const registry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({ mode: "default" }),
    );
    const session = buildSession({
      services: { permissionModeRegistry: registry },
    });

    await registry.update(createEmptyToolPermissionContext({ mode: "plan" }));

    expect(
      getAttachmentTrackingState(session).needsPlanModeExitAttachment,
    ).toBe(false);

    _resetAttachmentTrackingStateForTest(session);
  });
});

describe("Session.abortTerminal", () => {
  it("emits turn_aborted with the real active turn id", async () => {
    const session = buildSession();
    await session.activeTurn.swap({
      turnId: "turn-live",
      startedAtMs: 123,
      abortController: new AbortController(),
    });

    session.abortTerminal("stdin_lost");

    const emitted = session.txEvent.tryRecv();
    expect(emitted).toMatchObject({
      msg: {
        type: "turn_aborted",
        payload: {
          turnId: "turn-live",
          reason: "stdin_lost",
        },
      },
    });
  });

  it("omits turnId when no turn is active", () => {
    const session = buildSession();

    session.abortTerminal("signal_received");

    const emitted = session.txEvent.tryRecv();
    expect(emitted).toMatchObject({
      msg: {
        type: "turn_aborted",
        payload: {
          turnId: undefined,
          reason: "signal_received",
        },
      },
    });
  });
});

describe("Session rollout persistence suspension", () => {
  it("keeps fork-only events ephemeral without consuming canonical coordinates", async () => {
    const session = buildSession();
    const append = vi.fn(() => true);
    session.rolloutStore = {
      append,
    } as unknown as Session["rolloutStore"];
    const published: Event[] = [];
    session.eventLog.subscribe((event) => published.push(event));

    const before = session.emit({
      id: "root-before",
      msg: { type: "user_message", payload: { message: "before" } },
    });
    let forkEvent: Event | undefined;
    await session.withRolloutPersistenceSuspended(async () => {
      forkEvent = session.emit({
        eventId: "fork-event-must-not-leak",
        id: "fork-correlation",
        seq: 99,
        msg: { type: "turn_started", payload: { turnId: "fork-turn" } },
      });
    });
    const after = session.emit({
      id: "root-after",
      msg: { type: "turn_complete", payload: { turnId: "root-turn" } },
    });

    expect(before).toMatchObject({ eventId: "event:1", seq: 1 });
    expect(forkEvent).toEqual({
      id: "fork-correlation",
      msg: { type: "turn_started", payload: { turnId: "fork-turn" } },
    });
    expect(after).toMatchObject({ eventId: "event:2", seq: 2 });
    expect(append.mock.calls.map(([event]) => event)).toMatchObject([
      { eventId: "event:1", seq: 1 },
      { eventId: "event:2", seq: 2 },
    ]);
    expect(published.map((event) => [event.eventId, event.seq])).toEqual([
      ["event:1", 1],
      [undefined, undefined],
      ["event:2", 2],
    ]);
  });
});

describe("Session.consumePendingProviderSwitch", () => {
  it("clears a staged switch without publishing when provider commit rejects", async () => {
    const session = buildProviderSwitchTestSession();
    await stageProviderSwitchForTest(session);
    const before = {
      binding: session.providerBinding,
      sessionConfiguration: session.state.unsafePeek().sessionConfiguration,
      config: session.config,
      modelInfo: session.modelInfo,
    };
    vi.spyOn(session.providerService, "commit").mockImplementation(() => {
      throw new Error("failpoint before provider commit");
    });

    await expect(
      consumePendingProviderSwitchTransaction(session),
    ).resolves.toEqual({
      status: "clean-rejection",
      reason: "failpoint before provider commit",
    });
    expect(session.providerBinding).toBe(before.binding);
    expect(session.state.unsafePeek().sessionConfiguration).toBe(
      before.sessionConfiguration,
    );
    expect(session.config).toBe(before.config);
    expect(session.modelInfo).toBe(before.modelInfo);
    expect(session.pendingProviderSwitch).toBeNull();

    const freshTurn = session.newDefaultTurn();
    expect(freshTurn.providerBinding).toMatchObject({
      provider: "grok",
      model: "grok-4",
    });
  });

  it("restores the complete snapshot when commit throws after publication", async () => {
    const session = buildProviderSwitchTestSession();
    const { prepared } = await stageProviderSwitchForTest(session);
    const before = {
      binding: session.providerBinding,
      sessionConfiguration: session.state.unsafePeek().sessionConfiguration,
      config: session.config,
      modelInfo: session.modelInfo,
      previousContinuation: providerHttpClient(
        session.providerBinding,
      )?.snapshotResponsesContinuation(),
      nextContinuation: providerHttpClient(
        prepared.provider.binding,
      )?.snapshotResponsesContinuation(),
    };
    const commit = session.providerService.commit.bind(session.providerService);
    vi.spyOn(session.providerService, "commit").mockImplementation(
      (candidate) => {
        commit(candidate);
        throw new Error("failpoint immediately after provider commit");
      },
    );

    await expect(
      consumePendingProviderSwitchTransaction(session),
    ).resolves.toEqual({
      status: "clean-rejection",
      reason: "failpoint immediately after provider commit",
    });
    expect(session.providerBinding).toMatchObject({
      provider: before.binding.provider,
      model: before.binding.model,
      instance: before.binding.instance,
      factoryOptions: before.binding.factoryOptions,
      revision: prepared.provider.binding.revision + 1,
    });
    expect(session.state.unsafePeek().sessionConfiguration).toBe(
      before.sessionConfiguration,
    );
    expect(session.config).toBe(before.config);
    expect(session.modelInfo).toBe(before.modelInfo);
    expect(
      providerHttpClient(before.binding)?.snapshotResponsesContinuation(),
    ).toEqual(before.previousContinuation);
    expect(
      providerHttpClient(
        prepared.provider.binding,
      )?.snapshotResponsesContinuation(),
    ).toEqual(before.nextContinuation);
    expect(session.pendingProviderSwitch).toBeNull();
  });

  it("rolls back a completed state publication and preserves a concurrent switch", async () => {
    const session = buildProviderSwitchTestSession();
    const concurrentPending = Object.freeze({
      provider: "grok",
      model: "grok-4.6",
    });
    await stageProviderSwitchForTest(session);
    const before = {
      binding: session.providerBinding,
      sessionConfiguration: session.state.unsafePeek().sessionConfiguration,
      config: session.config,
      modelInfo: session.modelInfo,
    };
    const withState = session.state.with.bind(session.state);
    let failPublication = true;
    vi.spyOn(session.state, "with").mockImplementation(async (operation) => {
      const result = await withState(operation);
      if (failPublication) {
        failPublication = false;
        session.setPendingProviderSwitch(concurrentPending);
        throw new Error("failpoint after session state publication");
      }
      return result;
    });

    await expect(
      consumePendingProviderSwitchTransaction(session),
    ).resolves.toEqual({
      status: "clean-rejection",
      reason: "failpoint after session state publication",
    });
    expect(session.providerBinding).toMatchObject({
      provider: before.binding.provider,
      model: before.binding.model,
      instance: before.binding.instance,
    });
    expect(session.state.unsafePeek().sessionConfiguration).toBe(
      before.sessionConfiguration,
    );
    expect(session.config).toBe(before.config);
    expect(session.modelInfo).toBe(before.modelInfo);
    expect(session.pendingProviderSwitch).toBe(concurrentPending);
  });

  it("terminal-fences every turn path when provider rollback fails", async () => {
    const session = buildProviderSwitchTestSession();
    await stageProviderSwitchForTest(session);
    const commit = session.providerService.commit.bind(session.providerService);
    vi.spyOn(session.providerService, "commit").mockImplementation(
      (candidate) => {
        commit(candidate);
        throw new Error("failpoint after provider commit");
      },
    );
    vi.spyOn(
      session.providerService,
      "restoreAfterFailedCommit",
    ).mockImplementation(() => {
      throw new Error("failpoint during provider rollback");
    });

    const outcome = await consumePendingProviderSwitchTransaction(session);

    expect(outcome).toMatchObject({
      status: "terminal-failure",
      reason: expect.stringContaining("failpoint during provider rollback"),
    });
    expect(session.pendingProviderSwitch).toBeNull();
    expect(() => session.newDefaultTurn()).toThrow(
      "session is fenced after an incomplete provider switch transaction",
    );
    expect(() => session.newTurnWithSubId("fenced-turn")).toThrow(
      "session is fenced after an incomplete provider switch transaction",
    );
    await expect(session.runTurn("must not dispatch").next()).rejects.toThrow(
      "session is fenced after an incomplete provider switch transaction",
    );
  });

  it("does not commit a prepared switch after a newer selection supersedes it", async () => {
    const session = buildSession({
      services: {
        provider: createProvider("grok", {
          apiKey: "test-key",
          model: "grok-4",
        }),
      },
    });
    const originalPrepare = session.prepareProviderSwitch.bind(session);
    let releasePreparation!: () => void;
    const preparationBlocked = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let preparationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      preparationStarted = resolve;
    });
    vi.spyOn(session, "prepareProviderSwitch").mockImplementation(
      async (pending, configSnapshot) => {
        preparationStarted();
        await preparationBlocked;
        return originalPrepare(pending, configSnapshot);
      },
    );
    session.setPendingProviderSwitch({ provider: "grok", model: "grok-4.3" });

    const firstConsumption = consumePendingProviderSwitch(session);
    await started;
    session.setPendingProviderSwitch({ provider: "grok", model: "grok-4.6" });
    releasePreparation();

    await expect(firstConsumption).resolves.toEqual({
      applied: false,
      reason: "provider switch superseded",
    });
    expect(session.providerBinding).toMatchObject({
      provider: "grok",
      model: "grok-4",
    });
    expect(session.pendingProviderSwitch).toEqual({
      provider: "grok",
      model: "grok-4.6",
    });
  });

  it.each([
    {
      policyName: "deny-all",
      availableModels: [] as string[],
    },
    {
      policyName: "restricted",
      availableModels: ["grok-4.6"],
    },
  ])(
    "rejects a pending switch before provider preparation under the $policyName availableModels policy",
    async ({ availableModels }) => {
      const session = buildSession({
        services: {
          provider: createProvider("grok", {
            apiKey: "test-key",
            model: "grok-4",
          }),
          configStore: {
            current: () => ({ availableModels }),
          },
        },
      });
      const prepareSpy = vi.spyOn(session.providerService, "prepare");
      session.setPendingProviderSwitch({
        provider: "grok",
        model: "grok-4.3",
        profile: "coding",
      });

      await expect(consumePendingProviderSwitch(session)).resolves.toEqual({
        applied: false,
        reason:
          "model 'grok-4.3' is not allowed by managed availableModels policy",
      });

      expect(prepareSpy).not.toHaveBeenCalled();
      expect(session.providerBinding).toMatchObject({
        provider: "grok",
        model: "grok-4",
      });
      expect(session.pendingProviderSwitch).toBeNull();
      expect(session.txEvent.tryRecv()).toMatchObject({
        msg: {
          type: "warning",
          payload: {
            cause: "provider_switch_rejected",
            message:
              "provider switch rejected: model 'grok-4.3' is not allowed by managed availableModels policy",
          },
        },
      });
    },
  );

  it("resets ProviderHttpClient continuity state on provider/model switches and re-binds the session conversation id", async () => {
    const bindSpy = vi.spyOn(
      ProviderHttpClient.prototype,
      "bindConversationId",
    );
    const resetSpy = vi.spyOn(
      ProviderHttpClient.prototype,
      "resetResponsesContinuation",
    );
    const session = buildSession({
      services: {
        provider: createProvider("openai", {
          apiKey: "openai-test",
          baseURL: "https://openai.example/v1",
          model: "gpt-5",
        }),
      },
    });
    session.setPendingProviderSwitch({
      provider: "openai",
      model: "gpt-5-mini",
    });

    await consumePendingProviderSwitch(session);

    expect(resetSpy).toHaveBeenCalled();
    expect(bindSpy).toHaveBeenCalledWith("conv-test");
  });

  it("applies provider slug, live provider, config model, and modelInfo together", async () => {
    const session = buildSession({
      services: {
        provider: createProvider("grok", {
          apiKey: "test-key",
          model: "grok-4",
        }),
      },
    });
    session.setPendingProviderSwitch({
      provider: "grok",
      model: "grok-4.3",
    });

    const applied = await consumePendingProviderSwitch(session);
    const state = session.state.unsafePeek();

    expect(applied).toEqual({
      applied: true,
      provider: "grok",
      model: "grok-4.3",
    });
    expect(state.sessionConfiguration.provider).toEqual({ slug: "grok" });
    expect(state.sessionConfiguration.collaborationMode.model).toBe("grok-4.3");
    expect(state.sessionConfiguration.baseInstructions).toContain(
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    );
    expect(state.sessionConfiguration.baseInstructions).not.toContain(
      "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
    );
    expect(session.config.model).toBe("grok-4.3");
    expect(session.modelInfo.slug).toBe("grok-4.3");
    expect(isFactoryProvider(session.services.provider)).toBe(true);
    expect(session.pendingProviderSwitch).toBeNull();
    const emitted = session.txEvent.tryRecv();
    expect(emitted).toMatchObject({
      msg: {
        type: "warning",
        payload: {
          cause: "provider_switched",
        },
      },
    });
    if (emitted?.msg.type === "warning") {
      expect(emitted.msg.payload.message).toContain(
        "previous_response_id reset",
      );
    }
  });

  it("consumes the exact staged pair when its profile definition changes", async () => {
    const configStore = new ConfigStore({
      home: join(tmpdir(), "agenc-session-profile-change-test-home"),
      cwd: "/tmp",
      env: {},
    });
    vi.spyOn(configStore, "current").mockReturnValue({
      profiles: {
        coding: {
          model_provider: "grok",
          model: "grok-4",
        },
      },
    });
    const session = buildSession({
      services: {
        provider: createProvider("grok", {
          apiKey: "test-key",
          model: "grok-4",
        }),
        configStore,
      },
    });
    session.setPendingProviderSwitch({
      provider: "grok",
      model: "grok-4.3",
      profile: "coding",
    });

    await expect(consumePendingProviderSwitch(session)).resolves.toEqual({
      applied: true,
      provider: "grok",
      model: "grok-4.3",
    });
    expect(session.providerBinding).toMatchObject({
      provider: "grok",
      model: "grok-4.3",
    });
    expect(session.txEvent.tryRecv()).toMatchObject({
      msg: {
        type: "warning",
        payload: {
          cause: "provider_switched",
          message: expect.stringContaining("profile coding"),
        },
      },
    });
  });

  it("refuses impossible switches without mutating the live session", async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const startingProvider = createProvider("grok", {
        apiKey: "test-key",
        model: "grok-4",
      });
      const session = buildSession({
        services: {
          provider: startingProvider,
          providerEnvironment: {},
        },
      });
      session.setPendingProviderSwitch({
        provider: "openai",
        model: "gpt-5",
      });

      const applied = await consumePendingProviderSwitch(session);
      const state = session.state.unsafePeek();
      const emitted = session.txEvent.tryRecv();

      expect(applied.applied).toBe(false);
      expect(applied.reason).toMatch(/OPENAI_API_KEY|apiKey/i);
      expect(state.sessionConfiguration.provider).toBeUndefined();
      expect(state.sessionConfiguration.collaborationMode.model).toBe(
        "grok-4",
      );
      expect(session.config.model).toBe("grok-4");
      expect(session.modelInfo.slug).toBe("grok-4");
      expect(session.services.provider).toBe(startingProvider);
      expect(session.pendingProviderSwitch).toBeNull();
      expect(emitted).toMatchObject({
        msg: {
          type: "warning",
          payload: {
            cause: "provider_switch_rejected",
          },
        },
      });
    });
  });

  it("uses ConfigStore provider settings when switching across providers", async () => {
    await withEnv(
      {
        OPENAI_API_KEY: undefined,
      },
      async () => {
        const vendKey = vi.fn(() => {
          throw new Error("managed key vending should not run for BYOK");
        });
        const authBackend: AuthBackend = {
          kind: "remote",
          login: () => ({ authenticated: true, provider: "remote" }),
          logout: () => ({ authenticated: false }),
          whoami: () => ({ authenticated: true, provider: "remote" }),
          vendKey,
          inferAgencModel: () => ({
            provider: "openai",
            model: "gpt-5",
          }),
          getSubscriptionTier: () => "free",
        };
        const session = buildSession({
          services: {
            provider: createProvider("grok", {
              apiKey: "test-key",
              model: "grok-4",
            }),
            providerEnvironment: {
              OPENAI_API_KEY: "openai-target",
            },
            authBackend,
            authSubscriptionTier: "free",
            configStore: {
              current: () => ({
                providers: {
                  openai: {
                    base_url: "http://127.0.0.1:8000/v1",
                    fallback: {
                      targets: [{ provider: "grok", model: "grok-4.3" }],
                      max_failures: 2,
                    },
                  },
                },
              }),
            },
          },
        });
        session.setPendingProviderSwitch({
          provider: "openai",
          model: "gpt-5",
        });

        const applied = await consumePendingProviderSwitch(session);

        expect(applied).toEqual({
          applied: true,
          provider: "openai",
          model: "gpt-5",
        });
        expect(readProviderIdentity(session.services.provider)).toBe("openai");
        expect(
          readProviderFactoryOptions(session.services.provider),
        ).toMatchObject({
          apiKey: "openai-target",
          baseURL: "http://127.0.0.1:8000/v1",
          model: "gpt-5",
          extra: {
            providerFallback: {
              provider: "openai",
              model: "gpt-5",
              targets: [{ provider: "grok", model: "grok-4.3" }],
              maxFailures: 2,
            },
          },
        });
        expect(vendKey).not.toHaveBeenCalled();
      },
    );
  });

  it("retains a canonical saved Gemini plan across a switch away and back", async () => {
    const nativeBaseURL = "https://gateway.example/gemini-native";
    const session = buildSession({
      services: {
        provider: createProvider("gemini", {
          model: "gemini-2.5-pro",
          extra: {
            gemini: {
              credentialPlan: {
                kind: "api-key",
                credential: "saved-key",
                source: "saved-byok",
              },
              endpointPlan: createGeminiEndpointPlan({
                baseURL: nativeBaseURL,
              }),
            },
          },
        }),
        providerEnvironment: { GEMINI_BASE_URL: nativeBaseURL },
        configStore: { current: () => ({}) },
      },
      readSavedApiKey: async (provider) =>
        provider === "gemini" ? "saved-key" : undefined,
    });

    session.setPendingProviderSwitch({
      provider: "ollama",
      model: "llama3.2",
    });
    await expect(consumePendingProviderSwitch(session)).resolves.toMatchObject({
      applied: true,
      provider: "ollama",
    });

    session.setPendingProviderSwitch({
      provider: "gemini",
      model: "gemini-2.5-flash",
    });
    await expect(consumePendingProviderSwitch(session)).resolves.toEqual({
      applied: true,
      provider: "gemini",
      model: "gemini-2.5-flash",
    });
    expect(readProviderFactoryOptions(session.services.provider)).toMatchObject(
      {
        model: "gemini-2.5-flash",
        extra: {
          gemini: {
            credentialPlan: {
              kind: "api-key",
              credential: "saved-key",
              source: "saved-byok",
            },
            endpointPlan: {
              kind: "custom",
              nativeBaseURL,
            },
          },
        },
      },
    );
    expect(
      readProviderFactoryOptions(session.services.provider).apiKey,
    ).toBeUndefined();
    expect(
      readProviderFactoryOptions(session.services.provider).baseURL,
    ).toBeUndefined();
  });

  it("caps managed OpenRouter switches to the hosted output-token default", async () => {
    await withEnv(
      {
        OPENROUTER_API_KEY: undefined,
      },
      async () => {
        const calls: string[] = [];
        const authBackend: AuthBackend = {
          kind: "remote",
          login: () => ({ authenticated: true, provider: "remote" }),
          logout: () => ({ authenticated: false }),
          whoami: () => ({ authenticated: true, provider: "remote" }),
          vendKey: (provider, sessionId) => {
            calls.push(`vendKey:${provider}:${sessionId}`);
            return {
              kind: "api-key",
              provider,
              sessionId,
              apiKey: "managed-openrouter-key",
              baseUrl: "https://llm.agenc.tech",
            };
          },
          inferAgencModel: () => ({
            provider: "openrouter",
            model: "openai/gpt-5-nano",
          }),
          getSubscriptionTier: () => "team",
        };
        const session = buildSession({
          services: {
            provider: createProvider("openai", {
              apiKey: "test-key",
              model: "gpt-5",
            }),
            authBackend,
            authSubscriptionTier: "team",
            configStore: {
              current: () => ({
                auth: { managedKeys: { enabled: true } },
              }),
            },
            modelsManager: {
              getModelInfo: async (model: string) => ({
                ...mkModelInfo(),
                slug: model,
                contextWindow: 128_000,
                maxOutputTokens: 128_000,
                maxOutputTokensUpperLimit: 128_000,
              }),
            },
          },
        });
        session.setPendingProviderSwitch({
          provider: "openrouter",
          model: "openai/gpt-5-nano",
        });

        const applied = await consumePendingProviderSwitch(session);

        expect(applied).toEqual({
          applied: true,
          provider: "openrouter",
          model: "openai/gpt-5-nano",
        });
        expect(calls).toEqual([]);
        expect(
          readProviderFactoryOptions(session.services.provider),
        ).toMatchObject({
          model: "openai/gpt-5-nano",
          extra: {
            managedCredential: true,
            maxTokens: 2048,
          },
        });
        expect(
          readProviderFactoryOptions(session.services.provider),
        ).not.toHaveProperty("apiKey");
        expect(
          readProviderFactoryOptions(session.services.provider),
        ).not.toHaveProperty("baseURL");
        expect(session.modelInfo.maxOutputTokens).toBe(2048);
        expect(session.modelInfo.maxOutputTokensUpperLimit).toBe(2048);
        expect(session.modelInfo.maxOutputTokensCappedDefault).toBe(true);
      },
    );
  });

  it("caps direct managed OpenRouter key switches to the hosted output-token default", async () => {
    await withEnv(
      {
        OPENROUTER_API_KEY: undefined,
      },
      async () => {
        const calls: string[] = [];
        const authBackend: AuthBackend = {
          kind: "remote",
          login: () => ({ authenticated: true, provider: "remote" }),
          logout: () => ({ authenticated: false }),
          whoami: () => ({ authenticated: true, provider: "remote" }),
          vendKey: (provider, sessionId) => {
            calls.push(`vendKey:${provider}:${sessionId}`);
            return {
              kind: "api-key",
              provider,
              sessionId,
              apiKey: "managed-openrouter-key",
            };
          },
          inferAgencModel: () => ({
            provider: "openrouter",
            model: "openai/gpt-5-nano",
          }),
          getSubscriptionTier: () => "team",
        };
        const session = buildSession({
          services: {
            provider: createProvider("openai", {
              apiKey: "test-key",
              model: "gpt-5",
            }),
            authBackend,
            authSubscriptionTier: "team",
            configStore: {
              current: () => ({
                auth: { managedKeys: { enabled: true } },
              }),
            },
            modelsManager: {
              getModelInfo: async (model: string) => ({
                ...mkModelInfo(),
                slug: model,
                contextWindow: 128_000,
                maxOutputTokens: 128_000,
                maxOutputTokensUpperLimit: 128_000,
              }),
            },
          },
        });
        session.setPendingProviderSwitch({
          provider: "openrouter",
          model: "openai/gpt-5-nano",
        });

        const applied = await consumePendingProviderSwitch(session);

        expect(applied).toEqual({
          applied: true,
          provider: "openrouter",
          model: "openai/gpt-5-nano",
        });
        expect(calls).toEqual([]);
        expect(
          readProviderFactoryOptions(session.services.provider),
        ).toMatchObject({
          model: "openai/gpt-5-nano",
          extra: {
            managedCredential: true,
            maxTokens: 2048,
          },
        });
        expect(
          readProviderFactoryOptions(session.services.provider),
        ).not.toHaveProperty("apiKey");
        expect(session.modelInfo.maxOutputTokens).toBe(2048);
        expect(session.modelInfo.maxOutputTokensUpperLimit).toBe(2048);
        expect(session.modelInfo.maxOutputTokensCappedDefault).toBe(true);
      },
    );
  });

  it("does not vend managed keys for local LM Studio switches", async () => {
    await withEnv(
      {
        LMSTUDIO_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
      },
      async () => {
        const vendKey = vi.fn(() => {
          throw new Error("vendKey should not run for local providers");
        });
        const authBackend: AuthBackend = {
          kind: "remote",
          login: () => ({ authenticated: true, provider: "remote" }),
          logout: () => ({ authenticated: false }),
          whoami: () => ({ authenticated: true, provider: "remote" }),
          vendKey,
          inferAgencModel: () => ({
            provider: "grok",
            model: "grok-4.3",
          }),
          getSubscriptionTier: () => "team",
        };
        const session = buildSession({
          services: {
            provider: createProvider("grok", {
              apiKey: "test-key",
              model: "grok-4.3",
            }),
            authBackend,
            authSubscriptionTier: "team",
            configStore: {
              current: () => ({
                auth: { managedKeys: { enabled: true } },
              }),
            },
          },
        });
        session.setPendingProviderSwitch({
          provider: "lmstudio",
          model: "gpt-4o-mini",
        });

        const applied = await consumePendingProviderSwitch(session);

        expect(applied).toEqual({
          applied: true,
          provider: "lmstudio",
          model: "gpt-4o-mini",
        });
        expect(vendKey).not.toHaveBeenCalled();
        expect(
          readProviderFactoryOptions(session.services.provider),
        ).toMatchObject({
          model: "gpt-4o-mini",
        });
        expect(
          readProviderFactoryOptions(session.services.provider).apiKey,
        ).toBeUndefined();
      },
    );
  });

  it("rejects free remote managed-key switches before vending", async () => {
    await withEnv(
      {
        OPENROUTER_API_KEY: undefined,
      },
      async () => {
        const vendKey = vi.fn(() => ({
          kind: "api-key" as const,
          provider: "openrouter",
          sessionId: "conv-test",
          apiKey: "managed-openrouter-key",
        }));
        const authBackend: AuthBackend = {
          kind: "remote",
          login: () => ({ authenticated: true, provider: "remote" }),
          logout: () => ({ authenticated: false }),
          whoami: () => ({ authenticated: true, provider: "remote" }),
          vendKey,
          inferAgencModel: () => ({
            provider: "openrouter",
            model: "openai/gpt-5-nano",
          }),
          getSubscriptionTier: () => "free",
        };
        const startingProvider = createProvider("openai", {
          apiKey: "test-key",
          model: "gpt-5",
        });
        const session = buildSession({
          services: {
            provider: startingProvider,
            authBackend,
            authSubscriptionTier: "free",
            configStore: {
              current: () => ({
                auth: { managedKeys: { enabled: true } },
              }),
            },
          },
        });
        session.setPendingProviderSwitch({
          provider: "openrouter",
          model: "openai/gpt-5-nano",
        });

        const applied = await consumePendingProviderSwitch(session);

        expect(applied.applied).toBe(false);
        expect(applied.reason).toMatch(/Managed provider keys require/);
        expect(vendKey).not.toHaveBeenCalled();
        expect(session.services.provider).toBe(startingProvider);
        expect(session.pendingProviderSwitch).toBeNull();
      },
    );
  });

  it("rejects free remote hosted AgenC model routing during provider switches", async () => {
    const vendKey = vi.fn(() => ({
      kind: "api-key" as const,
      provider: "grok",
      sessionId: "conv-test",
      apiKey: "managed-grok-key",
    }));
    const authBackend: AuthBackend = {
      kind: "remote",
      login: () => ({ authenticated: true, provider: "remote" }),
      logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "remote" }),
      vendKey,
      inferAgencModel: () => ({
        provider: "grok",
        model: "grok-4.3",
      }),
      getSubscriptionTier: () => "free",
    };
    const startingProvider = createProvider("grok", {
      apiKey: "test-key",
      model: "grok-4",
    });
    const session = buildSession({
      services: {
        provider: startingProvider,
        authBackend,
        authSubscriptionTier: "free",
      },
    });
    session.setPendingProviderSwitch({
      provider: "agenc",
      model: "agenc",
    });

    const applied = await consumePendingProviderSwitch(session);

    expect(applied.applied).toBe(false);
    expect(applied.reason).toMatch(/Hosted AgenC model routing/);
    expect(vendKey).not.toHaveBeenCalled();
    expect(session.services.provider).toBe(startingProvider);
  });

  it("rebuilds the current provider from canonical config instead of live or process-global state", async () => {
    await withEnv(
      {
        OPENAI_API_KEY: undefined,
        OPENAI_BASE_URL: "https://wrong.openai.example/v1",
        OPENAI_MODEL: "wrong-openai-model",
      },
      async () => {
        const session = buildSession({
          services: {
            provider: createProvider("openrouter", {
              apiKey: "or-test",
              baseURL: "https://router.example/api/v1",
              model: "openai/gpt-5-mini",
            }),
            providerEnvironment: {
              OPENROUTER_API_KEY: "canonical-openrouter-key",
              OPENROUTER_BASE_URL: "https://canonical-router.example/v1",
            },
          },
        });
        session.setPendingProviderSwitch({
          provider: "openrouter",
          model: "openai/gpt-5",
        });

        const applied = await consumePendingProviderSwitch(session);

        expect(applied).toEqual({
          applied: true,
          provider: "openrouter",
          model: "openai/gpt-5",
        });
        expect(readProviderIdentity(session.services.provider)).toBe(
          "openrouter",
        );
        expect(
          readProviderFactoryOptions(session.services.provider),
        ).toMatchObject({
          apiKey: "canonical-openrouter-key",
          baseURL: "https://canonical-router.example/v1",
          model: "openai/gpt-5",
        });
      },
    );
  });
});

describe("Session MCP ownership seams", () => {
  it("startMcpManager delegates attach/start ordering through the session boundary", async () => {
    const session = buildSession();
    const setCallObserver = vi.fn();
    const start = vi.fn().mockResolvedValue(undefined);
    const manager = {
      setCallObserver,
      start,
    } as unknown as Parameters<Session["startMcpManager"]>[0];

    await session.startMcpManager(manager);

    expect(setCallObserver).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(setCallObserver.mock.invocationCallOrder[0]).toBeLessThan(
      start.mock.invocationCallOrder[0]!,
    );
  });

  it("hasPendingInput reflects queued mailbox traffic", () => {
    const session = buildSession();
    expect(session.hasPendingInput()).toBe(false);
    session.enqueueIdleInput({ role: "user", content: "queued" });
    expect(session.hasPendingInput()).toBe(true);
  });
});

describe("Session turn-driver hooks", () => {
  it("fans out phase events through subscribeToEvents", () => {
    const session = buildSession();
    const seen: Array<{ type: string }> = [];
    const unsubscribe = session.subscribeToEvents((event) => {
      seen.push(event as { type: string });
    });

    session.emitPhaseEvent({ type: "turn_start", turnIndex: 0 });
    expect(seen).toEqual([{ type: "turn_start", turnIndex: 0 }]);

    unsubscribe();
    session.emitPhaseEvent({
      type: "turn_complete",
      content: "",
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      stopReason: "completed",
    });
    expect(seen).toEqual([{ type: "turn_start", turnIndex: 0 }]);
  });

  it("serializes submit calls through the installed hook", async () => {
    const session = buildSession();
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    session.installTurnDriverHooks({
      submit: vi.fn(async (message: string) => {
        started.push(message);
        if (message === "first") {
          await firstGate;
        }
      }),
    });

    const first = session.submit("first");
    const second = session.submit("second");
    await Promise.resolve();
    expect(started).toEqual(["first"]);

    releaseFirst();
    await first;
    await second;
    expect(started).toEqual(["first", "second"]);
  });

  it("defers Agent startup work across Editor turns and flushes it before an ordinary submit", async () => {
    const session = buildSession();
    const sequence: string[] = [];
    session.appendDeferredOrdinarySubmitHook(async () => {
      sequence.push("agent-startup");
    });
    session.installTurnDriverHooks({
      submit: vi.fn(async (message: string) => {
        sequence.push(`turn:${message}`);
      }),
    });
    const editorInteraction = {
      interactionId: "interaction-deferred-startup-ask",
      kind: "ask" as const,
      policy: "read_only" as const,
      editorInstanceId: "editor-deferred-startup",
      bufferHandle: 12,
      changedtick: 5,
      contentSha256: "e".repeat(64),
      path: "/tmp/example.ts",
      range: {
        start: { line: 1, column: 0 },
        end: { line: 1, column: 1 },
      },
    };

    await session.submit("editor", { editorInteraction });
    expect(sequence).toEqual(["turn:editor"]);

    await session.submit("agent");
    expect(sequence).toEqual(["turn:editor", "agent-startup", "turn:agent"]);
  });

  it("discards never-started deferred work when shutdown wins", async () => {
    const cancel = vi.fn();
    const session = buildSession({
      services: {
        mcpStartupCancellationToken: {
          signal: new AbortController().signal,
          cancel,
          isCancelled: () => cancel.mock.calls.length > 0,
        },
      },
      mcpManagerOwnership: "owned",
    });
    const startup = vi.fn(async () => {});
    const submit = vi.fn(async () => {});
    session.appendDeferredOrdinarySubmitHook(startup);
    session.installTurnDriverHooks({ submit });

    await session.shutdown();

    expect(cancel).toHaveBeenCalledOnce();
    expect(startup).not.toHaveBeenCalled();
    await expect(session.submit("too late")).rejects.toThrow(
      "session is shutting down",
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("drains critical session state before waiting on MCP disposal", async () => {
    let releaseDispose!: () => void;
    const dispose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseDispose = resolve;
        }),
    );
    const session = buildSession({
      services: {
        mcpManager: { dispose },
      },
      mcpManagerOwnership: "owned",
    });

    const shutdown = session.shutdown();
    await vi.waitFor(() => expect(session.mailbox.isClosed).toBe(true));
    expect(dispose).toHaveBeenCalledOnce();

    releaseDispose();
    await shutdown;
  });

  it("retries rejected disposal for an owned MCP manager exactly once", async () => {
    const dispose = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("first strict clear failed"))
      .mockResolvedValueOnce(undefined);
    const session = buildSession({
      services: { mcpManager: { dispose } },
      mcpManagerOwnership: "owned",
    });

    await session.shutdown();

    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("does not cancel or dispose MCP authority borrowed by a child session", async () => {
    const cancel = vi.fn();
    const dispose = vi.fn().mockResolvedValue(undefined);
    const session = buildSession({
      services: {
        mcpManager: { dispose },
        mcpStartupCancellationToken: {
          signal: new AbortController().signal,
          cancel,
          isCancelled: () => false,
        },
      },
      mcpManagerOwnership: "borrowed",
    });

    await session.shutdown();

    expect(cancel).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("cancels and drains an in-flight startup activation before shutdown completes", async () => {
    const cancel = vi.fn();
    const session = buildSession({
      services: {
        mcpStartupCancellationToken: {
          signal: new AbortController().signal,
          cancel,
          isCancelled: () => cancel.mock.calls.length > 0,
        },
      },
      mcpManagerOwnership: "owned",
    });
    let releaseStartup!: () => void;
    const startupGate = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    let markStarted!: () => void;
    const startupStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const startup = vi.fn(async () => {
      markStarted();
      await startupGate;
    });
    const submitHook = vi.fn(async () => {});
    session.appendDeferredOrdinarySubmitHook(startup);
    session.installTurnDriverHooks({ submit: submitHook });

    const submit = session.submit("agent");
    await startupStarted;
    const shutdown = session.shutdown();
    expect(cancel).toHaveBeenCalledOnce();
    expect(startup).toHaveBeenCalledOnce();
    expect(submitHook).not.toHaveBeenCalled();

    releaseStartup();
    await shutdown;
    await expect(submit).rejects.toThrow("session is shutting down");
    expect(submitHook).not.toHaveBeenCalled();
  });

  it("retains a rejected startup activation without replaying side effects", async () => {
    const session = buildSession();
    const startup = vi.fn(async () => {
      throw new Error("startup failed");
    });
    const submit = vi.fn(async () => {});
    session.appendDeferredOrdinarySubmitHook(startup);
    session.installTurnDriverHooks({ submit });

    await expect(session.submit("first")).rejects.toThrow("startup failed");
    await expect(session.submit("second")).rejects.toThrow("startup failed");

    expect(startup).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it("flushEventLog falls back to the rollout store when no hook is installed", async () => {
    const session = buildSession();
    const flushDurable = vi.fn();
    session.rolloutStore = {
      flushDurable,
    } as unknown as Session["rolloutStore"];

    await session.flushEventLog();
    expect(flushDurable).toHaveBeenCalledTimes(1);
  });

  it("closes realtime conversation transport during shutdown", async () => {
    const session = buildSession();
    const events = new AsyncQueue<RealtimeEvent>();
    let closeCount = 0;
    const writer: RealtimeWriter = {
      sendAudioFrame: () => undefined,
      sendConversationItemCreate: () => undefined,
      sendConversationFunctionCallOutput: () => undefined,
      sendResponseCreate: () => undefined,
      sendPayload: () => undefined,
    };
    const connection: RealtimeTransportConnection = {
      writer,
      nextEvent: () => events.recv(),
      close: () => {
        closeCount += 1;
        events.close();
      },
    };

    await session.conversation.start({
      sessionConfig: buildRealtimeSessionConfig({
        conversationId: "conv-test",
        outputModality: "audio",
      }),
      connectTransport: () => connection,
    });

    await session.shutdown();

    expect(closeCount).toBe(1);
    await expect(session.conversation.runningState()).resolves.toBeUndefined();
  });

  it("drains durable continuations before finalizing and sealing the journal", async () => {
    const session = buildSession();
    const appended: Event[] = [];
    session.rolloutStore = {
      append: vi.fn((event: Event) => {
        appended.push(event);
        return true;
      }),
      flushDurable: vi.fn(),
      close: vi.fn(),
    } as unknown as Session["rolloutStore"];
    let releaseDecision!: () => void;
    const decisionGate = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    const decision = (async () => {
      await decisionGate;
      session.emit(
        {
          id: "permission-decision:shutdown",
          msg: {
            type: "permission_decision",
            payload: {
              runId: session.conversationId,
              callId: "call-shutdown",
              toolName: "Bash",
              turnId: "turn-shutdown",
              requestEventId: "request-shutdown",
              requestEventSeq: 1,
              decision: "abort",
              source: "aborted",
              recordedAt: "2026-07-18T00:00:00.000Z",
            },
          },
        },
        { durable: true },
      );
    })();
    session.trackDurableOperation(decision);
    session.onBeforeDurableClose(() => {
      session.emit(
        {
          eventId: "run-terminal:conv-test:1",
          id: "run-terminal:conv-test:1",
          msg: {
            type: "run_terminal",
            payload: {
              runId: "conv-test",
              epoch: 1,
              status: "cancelled",
              exitCode: null,
              stopReason: "shutdown",
              finalMessage: null,
              usage: null,
              lastSequenceBeforeTerminal: 1,
              finishedAt: "2026-07-18T00:00:01.000Z",
            },
          },
        },
        { durable: true },
      );
    });

    const shutdown = session.shutdown();
    await Promise.resolve();
    expect(appended).toEqual([]);
    releaseDecision();
    await shutdown;

    expect(appended.map((event) => event.msg.type)).toEqual([
      "permission_decision",
      "run_terminal",
    ]);
    expect(() =>
      session.emit({
        id: "late",
        msg: { type: "warning", payload: { cause: "late", message: "late" } },
      }),
    ).toThrow("canonical run journal is sealed");
  });
});

// ─────────────────────────────────────────────────────────────────────
// TurnContext.permissionMode snapshot (I-30)
// ─────────────────────────────────────────────────────────────────────

describe("TurnContext.permissionMode (I-30 snapshot)", () => {
  it("reflects the registry state at buildTurnContext time", () => {
    const ctx = buildTurnContext({
      conversationId: "conv-tcs",
      subId: "sub-1",
      config: mkConfig(),
      modelInfo: mkModelInfo(),
      provider: mkProvider(),
      sessionConfiguration: mkSessionConfiguration(),
      permissionMode: "plan",
      clock: { currentDate: "2026-04-20", timezone: "Etc/UTC" },
    });
    expect(ctx.permissionMode).toBe("plan");
  });

  it("defaults to 'default' when no permissionMode is provided", () => {
    const ctx = buildTurnContext({
      conversationId: "conv-tcs2",
      subId: "sub-1",
      config: mkConfig(),
      modelInfo: mkModelInfo(),
      provider: mkProvider(),
      sessionConfiguration: mkSessionConfiguration(),
      clock: { currentDate: "2026-04-20", timezone: "Etc/UTC" },
    });
    expect(ctx.permissionMode).toBe("default");
  });

  it("newDefaultTurnWithSubId pins the snapshot from the session's registry", () => {
    const registry = new PermissionModeRegistry(
      ctxWithPermissionMode("acceptEdits"),
    );
    let subSeq = 0;
    const sessionLike: SessionForTurn = {
      conversationId: "conv-snap",
      sessionConfiguration: mkSessionConfiguration(),
      config: mkConfig(),
      modelInfo: mkModelInfo(),
      provider: mkProvider(),
      permissionModeRegistry: registry,
      nextInternalSubId: () => `sub-${++subSeq}`,
    };
    const ctx = newDefaultTurnWithSubId(sessionLike, "sub-7");
    expect(ctx.permissionMode).toBe("acceptEdits");
  });

  it("Session.newDefaultTurnWithSubId uses the session-owned builder path", () => {
    const registry = new PermissionModeRegistry(
      ctxWithPermissionMode("acceptEdits"),
    );
    const session = buildSession({
      services: { permissionModeRegistry: registry },
    });
    const ctx = session.newDefaultTurnWithSubId("sub-owned");
    expect(ctx.subId).toBe("sub-owned");
    expect(ctx.permissionMode).toBe("acceptEdits");
    expect(ctx.config.model).toBe("test-model");
  });

  it("Session.newDefaultTurnWithSubId threads network policy interfaces", () => {
    const networkProxy = mkNetworkProxy();
    const session = buildSession({
      services: { networkProxy },
    });

    const ctx = session.newDefaultTurnWithSubId("sub-network-owned");

    expect(session.network).toBe(networkProxy);
    expect(ctx.network?.policyDecider).toBe(networkProxy.policyDecider);
    expect(ctx.network?.blockedRequestObserver).toBe(
      networkProxy.blockedRequestObserver,
    );
  });

  it("I-30: mutating the registry after buildTurnContext does not mutate the snapshot", async () => {
    const registry = new PermissionModeRegistry(
      ctxWithPermissionMode("default"),
    );
    let subSeq = 0;
    const sessionLike: SessionForTurn = {
      conversationId: "conv-i30",
      sessionConfiguration: mkSessionConfiguration(),
      config: mkConfig(),
      modelInfo: mkModelInfo(),
      provider: mkProvider(),
      permissionModeRegistry: registry,
      nextInternalSubId: () => `sub-${++subSeq}`,
    };
    const ctx = newDefaultTurnWithSubId(sessionLike, "sub-a");
    expect(ctx.permissionMode).toBe("default");

    // Registry flips mid-turn — the snapshot on the already-built
    // TurnContext must remain pinned to the construction-time mode.
    await registry.update(ctxWithPermissionMode("plan"));
    expect(registry.current().mode).toBe("plan");
    expect(ctx.permissionMode).toBe("default");

    // Evaluator I-3 re-reads (live registry) see the new mode, proving
    // the two slots are intentionally decoupled.
    expect(registry.current().mode).not.toBe(ctx.permissionMode);
  });
});

// ─────────────────────────────────────────────────────────────────────
// isPlanMode gate (T11 W3 wiring)
// ─────────────────────────────────────────────────────────────────────

describe("isPlanMode via the per-turn permission snapshot", () => {
  it("returns true when the permission context is in plan mode", () => {
    const ctx = {
      subId: "t-plan",
      collaborationMode: { model: "test-model" },
      permissionMode: "plan" as const,
    } as unknown as TurnContext;
    expect(isPlanMode(ctx)).toBe(true);
  });

  it("returns false when the permission context is any non-plan mode", () => {
    for (const mode of [
      "default",
      "acceptEdits",
      "bypassPermissions",
      "dontAsk",
      "auto",
      "unattended",
      "bubble",
    ] as const) {
      const ctx = {
        subId: "t-nonplan",
        collaborationMode: { model: "test-model" },
        permissionMode: mode,
      } as unknown as TurnContext;
      expect(isPlanMode(ctx)).toBe(false);
    }
  });
});

describe("Session.partialCompactFromMessage", () => {
  it("commits a durable replacement history and returns a history_replaced event", async () => {
    const sourceHistory: LLMMessage[] = [
      { role: "user", content: "keep this" },
      { role: "assistant", content: "assistant kept" },
      {
        role: "user",
        content: `summarize from here\n${verboseHistoryText("old-detail")}`,
      },
      {
        role: "assistant",
        content: `assistant summarized\n${verboseHistoryText("more-detail")}`,
      },
    ];
    const harness = createCompactionTransactionHarness(sourceHistory, {
      sessionId: "conv-test",
    });
    const session = buildSession({
      modelInfo: { ...mkModelInfo(), slug: "grok-4.5" },
      services: {
        provider: harness.provider,
        executionAdmission: harness.session.services.executionAdmission,
        admissionRequired: true,
      },
    });
    session.rolloutStore = harness.store;
    try {
      await session.state.with((state) => {
        state.history = sourceHistory;
      });

      const result = await session.partialCompactFromMessage({
        messageOrdinal: 1,
        direction: "from",
        feedback: "keep decisions",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.attemptId).toMatch(/^compact-/u);
      expect(result.displayText).toContain(
        `Rollback attempt ID: ${result.attemptId}`,
      );
      expect(result.event.type).toBe("history_replaced");
      expect(result.event.payload.messages.length).toBeGreaterThan(0);
      expect(
        harness.store
          .readAll()
          .some((item) => item.type === "compaction_committed"),
      ).toBe(true);
      const history = session.snapshotHistoryMessages();
      const boundary = history.find(
        (message) =>
          message.runtimeOnly?.compactionHistory?.kind === "boundary",
      );
      expect(boundary?.role).toBe("developer");
      expect(boundary?.content).toEqual(
        expect.stringContaining("agenc_compaction_boundary_v1:"),
      );
      expect(
        history.some(
          (message) => message.content === sourceHistory[2]?.content,
        ),
      ).toBe(false);
    } finally {
      harness.close();
    }
  });

  it("preserves multimodal kept messages when compacting from a later message", async () => {
    const documentPart: LLMContentPart = {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "ZmFrZS1wZGY=",
      },
      title: "notes.pdf",
      filename: "notes.pdf",
      fallbackText: "document fallback",
      fallbackTextTruncated: true,
      fallbackTextError: "ocr warning",
    };
    const imagePart: LLMContentPart = {
      type: "image_url",
      image_url: { url: "file:///tmp/screenshot.png" },
    };
    const sourceHistory: LLMMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "keep this" }, documentPart, imagePart],
      },
      {
        role: "user",
        content: `summarize from here\n${verboseHistoryText("old-detail")}`,
      },
      {
        role: "assistant",
        content: `assistant summarized\n${verboseHistoryText("more-detail")}`,
      },
    ];
    const harness = createCompactionTransactionHarness(sourceHistory, {
      sessionId: "conv-test",
    });
    const session = buildSession({
      modelInfo: { ...mkModelInfo(), slug: "grok-4.5" },
      services: {
        provider: harness.provider,
        executionAdmission: harness.session.services.executionAdmission,
        admissionRequired: true,
      },
    });
    session.rolloutStore = harness.store;
    try {
      await session.state.with((state) => {
        state.history = sourceHistory;
      });

      const result = await session.partialCompactFromMessage({
        messageOrdinal: 1,
        direction: "from",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      const history = session.snapshotHistoryMessages();
      const kept = history.find(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some((part) => part.type === "document"),
      );
      expect(kept?.content).toContainEqual(documentPart);
      expect(kept?.content).toContainEqual(imagePart);
    } finally {
      harness.close();
    }
  });

  it("installs an active compact task while provider summarization is running", async () => {
    let markStarted!: () => void;
    let releaseChat!: () => void;
    const chatStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const chatGate = new Promise<void>((resolve) => {
      releaseChat = resolve;
    });
    const sourceHistory: LLMMessage[] = [
      {
        role: "user",
        content: `summarize this\n${verboseHistoryText("old-detail")}`,
      },
      {
        role: "assistant",
        content: `assistant text\n${verboseHistoryText("more-detail")}`,
      },
    ];
    const compactionProvider = createCompactionProvider();
    const harness = createCompactionTransactionHarness(sourceHistory, {
      sessionId: "conv-test",
      chat: async (messages) => {
        markStarted();
        await chatGate;
        return compactionProvider.chat(messages);
      },
    });
    const session = buildSession({
      modelInfo: { ...mkModelInfo(), slug: "grok-4.5" },
      services: {
        provider: harness.provider,
        executionAdmission: harness.session.services.executionAdmission,
        admissionRequired: true,
      },
    });
    session.rolloutStore = harness.store;
    try {
      await session.state.with((state) => {
        state.history = sourceHistory;
      });

      const compacting = session.partialCompactFromMessage({
        messageOrdinal: 0,
        direction: "from",
      });
      await chatStarted;

      expect(
        session.activeTurn.unsafePeek()?.tasks.values().next().value?.kind,
      ).toBe("compact");
      await expect(clearSession(session)).rejects.toThrow(
        "Cannot clear right now",
      );
      releaseChat();
      await expect(compacting).resolves.toMatchObject({ ok: true });
    } finally {
      releaseChat();
      harness.close();
    }
  });
});

describe("Session.rewindConversationToMessage", () => {
  it("commits a durable replacement history before the selected active message", async () => {
    const appendRollout = vi.fn();
    const session = buildSession();
    session.rolloutStore = {
      isDegraded: false,
      appendRollout,
    } as unknown as Session["rolloutStore"];
    await session.state.with((state) => {
      state.history = [
        { role: "user", content: "first prompt" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "rewind target" },
        { role: "assistant", content: "discarded answer" },
      ];
    });

    const result = await session.rewindConversationToMessage({
      messageOrdinal: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.event.type).toBe("history_replaced");
    expect(result.event.payload.reason).toBe("rewind");
    expect(appendRollout).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "compacted",
        payload: expect.objectContaining({
          message: "Conversation rewound",
          replacementHistory: [
            { role: "user", content: "first prompt" },
            { role: "assistant", content: "first answer" },
          ],
        }),
      }),
      { durable: true },
    );
    expect(session.snapshotHistoryMessages()).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
    ]);
  });

  it("does not count compact boundary or summary messages as selectable", async () => {
    const appendRollout = vi.fn();
    const session = buildSession();
    session.rolloutStore = {
      isDegraded: false,
      appendRollout,
    } as unknown as Session["rolloutStore"];
    await session.state.with((state) => {
      state.history = [
        {
          role: "developer",
          content: "<compact>Conversation compacted</compact>",
          runtimeOnly: {
            compactionHistory: {
              version: 1,
              kind: "boundary",
              attempt_id: "compact-authenticated",
              summary_sha256: "a".repeat(64),
            },
          },
        },
        {
          role: "user",
          content:
            "This session is being continued from a previous conversation that ran out of context. Summary.",
          runtimeOnly: {
            compactionHistory: {
              version: 1,
              kind: "summary",
              attempt_id: "compact-authenticated",
              summary_sha256: "a".repeat(64),
            },
          },
        },
        { role: "user", content: "active target" },
        { role: "assistant", content: "discarded answer" },
      ];
    });

    const result = await session.rewindConversationToMessage({
      messageOrdinal: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(session.snapshotHistoryMessages()).toEqual([
      {
        role: "developer",
        content: "<compact>Conversation compacted</compact>",
        runtimeOnly: {
          compactionHistory: {
            version: 1,
            kind: "boundary",
            attempt_id: "compact-authenticated",
            summary_sha256: "a".repeat(64),
          },
        },
      },
      {
        role: "user",
        content:
          "This session is being continued from a previous conversation that ran out of context. Summary.",
        runtimeOnly: {
          compactionHistory: {
            version: 1,
            kind: "summary",
            attempt_id: "compact-authenticated",
            summary_sha256: "a".repeat(64),
          },
        },
      },
    ]);
  });

  it("treats an invocation envelope as one rewind boundary at channel zero", async () => {
    const appendRollout = vi.fn();
    const session = buildSession();
    session.rolloutStore = {
      isDegraded: false,
      appendRollout,
    } as unknown as Session["rolloutStore"];
    const invocation = materializeAgentInvocationMessages(
      createCsvAgentInvocationEnvelope({
        jobId: "rewind-job",
        itemId: "rewind-item",
        rowIndex: 0,
        rowSha256: `sha256:${"a".repeat(64)}`,
        instruction: "classify the row",
        row: { value: "untrusted" },
      }),
    );
    await session.state.with((state) => {
      state.history = [
        { role: "user", content: "first prompt" },
        { role: "assistant", content: "first answer" },
        ...invocation,
        { role: "assistant", content: "discarded answer" },
      ];
    });

    const result = await session.rewindConversationToMessage({
      messageOrdinal: 1,
    });

    expect(result.ok).toBe(true);
    expect(session.snapshotHistoryMessages()).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
    ]);
    const replacement =
      appendRollout.mock.calls[0]?.[0]?.payload?.replacementHistory;
    expect(replacement).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first answer" },
    ]);
  });
});

describe("Session.rollbackCompaction", () => {
  function rollbackStore() {
    return {
      isDegraded: false,
      rollbackCompaction: vi.fn(
        () =>
          ({
            attempt_id: "attempt-rollback",
            rollback_mode: "same_session" as const,
            target_session_id: "conv-test",
            source_history: [
              { role: "user" as const, content: "source prompt" },
              { role: "assistant" as const, content: "source answer" },
            ],
          }) as never,
      ),
      recordProjectionFailure: vi.fn(),
      markCleanupPending: vi.fn(),
      markCleanupComplete: vi.fn(),
      extendCompactionRollbackRetention: vi.fn(),
    };
  }

  it("projects the source history and returns an exact replacement event", async () => {
    const store = rollbackStore();
    const session = buildSession();
    session.rolloutStore = store as unknown as Session["rolloutStore"];
    await session.state.with((state) => {
      state.history = [{ role: "user", content: "compacted history" }];
    });

    const result = await session.rollbackCompaction({
      attemptId: "attempt-rollback",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result).toMatchObject({
      eventAlreadyEmitted: false,
      mode: "same_session",
      targetSessionId: "conv-test",
      event: {
        type: "history_replaced",
        payload: { reason: "compaction_rollback" },
      },
    });
    expect(session.snapshotHistoryMessages()).toEqual([
      { role: "user", content: "source prompt" },
      { role: "assistant", content: "source answer" },
    ]);
    expect(store.markCleanupComplete).toHaveBeenCalledWith("attempt-rollback");
    expect(store.recordProjectionFailure).not.toHaveBeenCalled();
  });

  it("marks cleanup pending without poisoning a successful projection", async () => {
    const store = rollbackStore();
    const session = buildSession();
    session.rolloutStore = store as unknown as Session["rolloutStore"];
    let cleanupFails = true;
    const clearSearchIndexes = vi.fn(() => {
      if (cleanupFails) throw new Error("cleanup failed");
    });
    Object.assign(session, { clearSearchIndexes });

    const result = await session.rollbackCompaction({
      attemptId: "attempt-rollback",
    });

    expect(result.ok).toBe(true);
    expect(store.markCleanupPending).toHaveBeenCalledWith(
      "attempt-rollback",
      expect.objectContaining({ message: "cleanup failed" }),
    );
    expect(store.recordProjectionFailure).not.toHaveBeenCalled();

    cleanupFails = false;
    await expect(
      session.extendCompactionRollbackRetention({
        attemptId: "attempt-rollback",
        extendedUntilMs: Date.now() + 60_000,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(store.markCleanupComplete).toHaveBeenCalledWith("attempt-rollback");
    expect(clearSearchIndexes).toHaveBeenCalledTimes(2);
  });

  it("records only projection failures as reconstruction-required", async () => {
    const store = rollbackStore();
    const session = buildSession();
    session.rolloutStore = store as unknown as Session["rolloutStore"];
    const projectionError = new Error("projection failed");
    vi.spyOn(session.state, "with").mockRejectedValueOnce(projectionError);

    await expect(
      session.rollbackCompaction({
        attemptId: "attempt-rollback",
      }),
    ).rejects.toBeInstanceOf(CompactionReconstructionRequiredError);
    expect(store.recordProjectionFailure).toHaveBeenCalledWith(
      "attempt-rollback",
      projectionError,
    );
    expect(store.markCleanupPending).not.toHaveBeenCalled();
    expect(store.markCleanupComplete).not.toHaveBeenCalled();
  });
});

describe("Session.shutdown dispatches SessionEnd hooks", () => {
  it("releases a shared bundled-skill root after the final owning Session shuts down", async () => {
    const sessionTempRoot = mkdtempSync(
      join(tmpdir(), "agenc-session-bundled-skills-"),
    );
    const runtimeOptions = resolveAgentRuntimeOptions({}, { sessionTempRoot });
    const first = buildSession({ services: { runtimeOptions } });
    const second = buildSession({ services: { runtimeOptions } });
    const bundledRoot = runWithAgentRuntimeOptions(runtimeOptions, () =>
      getCurrentBundledSkillExtractionRoot(),
    );

    try {
      await extractBundledSkillFiles(bundledRoot, "session-owned", {
        "reference.txt": "session-owned",
      });
      expect(existsSync(bundledRoot)).toBe(true);

      await first.shutdown();
      expect(existsSync(bundledRoot)).toBe(true);

      await second.shutdown();
      expect(existsSync(bundledRoot)).toBe(false);
    } finally {
      rmSync(sessionTempRoot, { recursive: true, force: true });
    }
  });

  it("removes file-read history from its captured session temp root", async () => {
    const sessionTempRoot = mkdtempSync(
      join(tmpdir(), "agenc-session-shutdown-history-"),
    );
    const runtimeOptions = resolveAgentRuntimeOptions({}, { sessionTempRoot });
    const session = buildSession({ services: { runtimeOptions } });
    const historySessionDirectory = join(
      sessionTempRoot,
      getSessionTempNamespaceName(),
      "filesystem-history",
      createHash("sha256").update(session.conversationId).digest("hex"),
    );

    try {
      runWithAgentRuntimeOptions(runtimeOptions, () => {
        recordSessionRead(session.conversationId, "/project/private.ts", {
          content: "session-confidential-content",
          viewKind: "full",
        });
      });
      expect(existsSync(historySessionDirectory)).toBe(true);

      await session.shutdown();

      expect(existsSync(historySessionDirectory)).toBe(false);
    } finally {
      clearSessionReadState(session.conversationId, sessionTempRoot);
      rmSync(sessionTempRoot, { recursive: true, force: true });
    }
  });

  it("fires registered SessionEnd hooks with the session id", async () => {
    const { registerSessionEndHook, resetLifecycleHookRegistry } =
      await import("../llm/hooks/registry.js");
    const seen: Array<{ reason: string; session_id?: string }> = [];
    resetLifecycleHookRegistry();
    registerSessionEndHook(async (input) => {
      seen.push({ reason: input.reason, session_id: input.session_id });
      return { succeeded: true, output: "" };
    });
    try {
      const session = buildSession();
      await session.shutdown();
      expect(seen).toEqual([{ reason: "exit", session_id: "conv-test" }]);
    } finally {
      resetLifecycleHookRegistry();
    }
  });

  it("does not run unmatched lifecycle hooks for an Editor-only deferred session", async () => {
    const { registerSessionEndHook, resetLifecycleHookRegistry } =
      await import("../llm/hooks/registry.js");
    const sessionStart = vi.fn(async () => {});
    const sessionEnd = vi.fn(async () => ({
      succeeded: true,
      output: "",
    }));
    resetLifecycleHookRegistry();
    registerSessionEndHook(sessionEnd);
    try {
      const session = buildSession();
      session.installDeferredSessionStartHook(sessionStart);

      await session.shutdown();

      expect(sessionStart).not.toHaveBeenCalled();
      expect(sessionEnd).not.toHaveBeenCalled();
    } finally {
      resetLifecycleHookRegistry();
    }
  });

  it("passes its captured bare authority to SessionEnd outside turn scope", async () => {
    const { registerSessionEndHook, resetLifecycleHookRegistry } =
      await import("../llm/hooks/registry.js");
    const sessionEnd = vi.fn(async () => ({
      succeeded: true,
      output: "must not run",
    }));
    resetLifecycleHookRegistry();
    registerSessionEndHook(sessionEnd);
    try {
      const session = buildSession({
        services: {
          runtimeOptions: { simpleMode: true } as never,
        },
      });

      await session.shutdown();

      expect(sessionEnd).not.toHaveBeenCalled();
    } finally {
      resetLifecycleHookRegistry();
    }
  });
});

describe("Session file rewind (previewFileRewind / rewindFilesToMessage)", () => {
  let project = "";

  afterEach(() => {
    if (project) {
      rmSync(project, { recursive: true, force: true });
      project = "";
    }
  });

  async function buildFileRewindFixture(): Promise<{
    session: Session;
    file: string;
  }> {
    const { FileHistory } = await import("./file-history.js");
    project = mkdtempSync(join(tmpdir(), "agenc-session-rewind-"));
    const file = join(project, "tracked.txt");
    writeFileSync(file, "original", "utf8");
    const hist = new FileHistory({ projectDir: project });
    // Barrier snapshot the sidecar would take when the user message
    // with id "user-msg-1" arrived, followed by an edit.
    await hist.trackEdit(file, "user-msg-1");
    await hist.makeSnapshot("user-msg-1");
    writeFileSync(file, "modified-by-turn", "utf8");
    await hist.makeSnapshot("post-edit");

    const session = buildSession();
    session.attachFileHistory(hist);
    await session.state.with((state) => {
      state.history = [
        {
          role: "user",
          content: "rewind target",
          runtimeOnly: { userMessageId: "user-msg-1" },
        },
        { role: "assistant", content: "edited your file" },
      ];
    });
    return { session, file };
  }

  it("previewFileRewind reports restorable files without touching disk", async () => {
    const { session, file } = await buildFileRewindFixture();
    const preview = await session.previewFileRewind({ messageOrdinal: 0 });
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error(preview.message);
    expect(preview.canRestoreFiles).toBe(true);
    expect(preview.filesChanged).toContain(file);
    expect(readFileSync(file, "utf8")).toBe("modified-by-turn");
  });

  it("rewindFilesToMessage restores the tracked file on disk", async () => {
    const { session, file } = await buildFileRewindFixture();
    const result = await session.rewindFilesToMessage({ messageOrdinal: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.restoredFiles).toContain(file);
    expect(readFileSync(file, "utf8")).toBe("original");
  });

  it("fails with NO_FILE_HISTORY when the message carries no userMessageId", async () => {
    const { session } = await buildFileRewindFixture();
    await session.state.with((state) => {
      state.history = [
        { role: "user", content: "unstamped prompt" },
        { role: "assistant", content: "answer" },
      ];
    });
    const result = await session.rewindFilesToMessage({ messageOrdinal: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("NO_FILE_HISTORY");
  });

  it("previewFileRewind degrades to canRestoreFiles=false without attached history", async () => {
    const session = buildSession();
    await session.state.with((state) => {
      state.history = [
        { role: "user", content: "prompt" },
        { role: "assistant", content: "answer" },
      ];
    });
    const preview = await session.previewFileRewind({ messageOrdinal: 0 });
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error(preview.message);
    expect(preview.canRestoreFiles).toBe(false);
  });
});
