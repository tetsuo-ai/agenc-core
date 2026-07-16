/**
 * Ports upstream runtime `core/tests/suite/personality.rs` scenarios onto
 * AgenC's turn loop, startup bootstrap, and model instruction helpers.
 *
 * Shape difference from upstream:
 *   - AgenC's current config file is `config.toml`; the startup migration
 *     test proves the no-config default through bootstrap instead of direct
 *     model construction.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

const sessionMemoryPostSamplingMockState = vi.hoisted(() => ({
  calls: [] as unknown[],
  error: null as Error | null,
}));

vi.mock("axios", () => {
  const axiosLike = {
    create: vi.fn(() => axiosLike),
    get: vi.fn(),
    post: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  };
  return {
    default: axiosLike,
    create: axiosLike.create,
    isAxiosError: () => false,
  };
});

vi.mock("../memory/session/sessionMemory.js", () => ({
  runSessionMemoryPostSamplingHook: async (context: unknown) => {
    sessionMemoryPostSamplingMockState.calls.push(context);
    if (sessionMemoryPostSamplingMockState.error) {
      throw sessionMemoryPostSamplingMockState.error;
    }
  },
}));

import {
  BASE_INSTRUCTIONS_PLACEHOLDER,
  getModelInstructions,
  PERSONALITY_PLACEHOLDER,
  PERSONALITY_SPEC_START_MARKER,
  type ModelMessages,
  type Personality,
} from "../context/personality-spec-instructions.js";
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  StreamProgressCallback,
} from "../llm/types.js";
import { trustProjectSync } from "../permissions/trust/project-trust.js";
import { AsyncQueue } from "../utils/async-queue.js";
import { bootstrapLocalRuntimeSession } from "../bin/bootstrap.js";
import {
  Session,
  type Event,
  type SessionOpts,
  type SessionServices,
} from "../session/session.js";
import type {
  Config,
  ManagedFeatures,
  ModelInfo,
  SessionConfiguration,
  TurnContext,
} from "../session/turn-context.js";
import { TurnTimingState } from "../session/turn-context.js";
import type { ToolRegistry } from "../tool-registry.js";

const LOCAL_FRIENDLY_TEMPLATE =
  "You optimize for team morale and being a supportive teammate as much as code quality.";
const LOCAL_PRAGMATIC_TEMPLATE =
  "You are a deeply pragmatic, effective software engineer.";
const BASE_INSTRUCTIONS = "base instructions";
const OPENAI_PERSONALITY_MODEL = "gpt-5.3-codex"; // branding-scan: allow OpenAI model identifier

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sessionMemoryPostSamplingMockState.calls.length = 0;
  sessionMemoryPostSamplingMockState.error = null;
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function mkFeatures(): ManagedFeatures {
  return {
    appsEnabledForAuth: () => false,
    useLegacyLandlock: () => false,
  };
}

function mkConfig(overrides?: Partial<Config> & { personality?: Personality }): Config {
  return {
    model: "test-model",
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
    ...overrides,
  };
}

function mkPersonalityModelMessages(
  personalityDefault = "",
): ModelMessages {
  return {
    instructionsTemplate:
      `${PERSONALITY_PLACEHOLDER}\n\n${BASE_INSTRUCTIONS_PLACEHOLDER}`,
    instructionsVariables: {
      personalityDefault,
      personalityFriendly: LOCAL_FRIENDLY_TEMPLATE,
      personalityPragmatic: LOCAL_PRAGMATIC_TEMPLATE,
    },
  };
}

function mkModelInfo(modelMessages?: ModelMessages): ModelInfo {
  return {
    slug: "test-model",
    effectiveContextWindowPercent: 100,
    contextWindow: 1024,
    supportedReasoningLevels: [],
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
    ...(modelMessages !== undefined
      ? { modelMessages, supportsPersonality: true }
      : {}),
  };
}

function mkCtx(params?: {
  readonly configPersonality?: Personality;
  readonly personality?: Personality;
  readonly modelMessages?: ModelMessages;
}): TurnContext {
  return {
    subId: "turn-personality-contract",
    cwd: "/tmp",
    config: mkConfig(
      params?.configPersonality !== undefined
        ? { personality: params.configPersonality }
        : undefined,
    ) as unknown,
    configSnapshot: {} as unknown,
    modelInfo: mkModelInfo(params?.modelMessages),
    collaborationMode: { model: "test-model" },
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
    reasoningSummary: "auto",
    sessionSource: "cli_main",
    currentDate: "2026-05-07",
    timezone: "Etc/UTC",
    dynamicTools: [],
    depth: 0,
    toolCallGate: {
      isReady: () => true,
      signal: () => {},
      wait: async () => {},
    },
    turnTimingState: new TurnTimingState(),
    ...(params?.personality !== undefined
      ? { personality: params.personality }
      : {}),
  } as unknown as TurnContext;
}

function mkSessionConfiguration(
  overrides?: Partial<SessionConfiguration>,
): SessionConfiguration {
  const base: SessionConfiguration = {
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
    collaborationMode: { model: "test-model" },
    dynamicTools: [],
    sessionSource: "cli_main",
  };
  return {
    ...base,
    ...overrides,
    collaborationMode: {
      ...base.collaborationMode,
      ...(overrides?.collaborationMode ?? {}),
    },
  };
}

function mkRegistry(): ToolRegistry {
  return {
    tools: [],
    toLLMTools: () => [],
    dispatch: async () => ({ content: "", isError: false }),
  } as unknown as ToolRegistry;
}

function mkProviderRecorder(response?: Partial<LLMResponse>): {
  readonly provider: LLMProvider;
  readonly seenMessages: LLMMessage[][];
  readonly seenSystemPrompts: Array<string | undefined>;
} {
  const seenMessages: LLMMessage[][] = [];
  const seenSystemPrompts: Array<string | undefined> = [];
  const finalResponse: LLMResponse = {
    content: "answer",
    toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    model: "test-model",
    finishReason: "stop",
    ...response,
  };
  return {
    seenMessages,
    seenSystemPrompts,
    provider: {
      name: "stub-provider",
      chat: async () => finalResponse,
      chatStream: async (
        messages: LLMMessage[],
        _onChunk: StreamProgressCallback,
        options,
      ) => {
        seenMessages.push(messages.map((message) => ({ ...message })));
        seenSystemPrompts.push(options?.systemPrompt);
        return finalResponse;
      },
      healthCheck: async () => true,
    },
  };
}

function mkSession(provider: LLMProvider): {
  readonly session: Session;
  readonly events: Event[];
} {
  const events: Event[] = [];
  const state = {
    sessionConfiguration: mkSessionConfiguration({
      provider: { slug: "stub-provider" } as unknown as SessionConfiguration["provider"],
      collaborationMode: { model: "stub-model" },
    }),
    history: [],
    totalTokenUsage: 0,
  };
  const services: SessionServices = {
    mcpConnectionManager: {
      setApprovalPolicy: () => {},
      setSandboxPolicy: () => {},
      requiredStartupFailures: async () => [],
    },
    mcpStartupCancellationToken: {
      cancel: () => {},
      isCancelled: () => false,
    },
    provider,
    registry: mkRegistry(),
    hooks: {
      executeStop: async () => ({}),
    },
  } as unknown as SessionServices;
  const session = new Session({
    conversationId: "conv-personality-contract",
    services,
    initialState: state as unknown as SessionOpts["initialState"],
    features: mkFeatures(),
    jsRepl: { id: "repl-personality-contract" },
    config: mkConfig(),
    modelInfo: mkModelInfo(),
    eventQueue: new AsyncQueue<Event>(),
  });
  session.eventLog.subscribe((event) => {
    events.push(event);
  });
  return { session, events };
}

async function drain(gen: AsyncGenerator<unknown, unknown>): Promise<void> {
  for await (const _ of gen) {
    // drain
  }
}

function messageText(message: LLMMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function developerTexts(messages: readonly LLMMessage[]): string[] {
  return messages
    .filter((message) => message.role === "developer")
    .map(messageText);
}

function personalityDeveloperTexts(messages: readonly LLMMessage[]): string[] {
  return developerTexts(messages).filter((text) =>
    text.includes(PERSONALITY_SPEC_START_MARKER)
  );
}

describe("personality contract", () => {
  test("personality_does_not_mutate_base_instructions_without_template", () => {
    const baseInstructions = "plain base instructions";
    const result = getModelInstructions({
      modelInfo: {},
      baseInstructions,
      personality: "friendly",
    });

    expect(result).toBe(baseInstructions);
    expect(baseInstructions).toBe("plain base instructions");
  });

  test("base_instructions_override_disables_personality_template", () => {
    const overrideInstructions = "override instructions";

    expect(
      getModelInstructions({
        modelInfo: mkModelInfo(),
        baseInstructions: overrideInstructions,
        personality: "friendly",
      }),
    ).toBe(overrideInstructions);
  });

  test("user_turn_personality_none_does_not_add_update_message", async () => {
    const { provider, seenMessages } = mkProviderRecorder();
    const { session } = mkSession(provider);
    const ctx = mkCtx({ modelMessages: mkPersonalityModelMessages() });

    await drain(session.runTurn("hello", {
      ctx,
      systemPrompt: BASE_INSTRUCTIONS,
    }));

    expect(personalityDeveloperTexts(seenMessages[0] ?? [])).toEqual([]);
  });

  test("config_personality_some_sets_instructions_template", async () => {
    const { provider, seenMessages, seenSystemPrompts } = mkProviderRecorder();
    const { session } = mkSession(provider);
    const ctx = mkCtx({
      configPersonality: "friendly",
      modelMessages: mkPersonalityModelMessages(),
    });

    await drain(session.runTurn("hello", {
      ctx,
      systemPrompt: BASE_INSTRUCTIONS,
    }));

    expect(seenSystemPrompts[0]).toBe(
      `${LOCAL_FRIENDLY_TEMPLATE}\n\n${BASE_INSTRUCTIONS}`,
    );
    expect(seenMessages[0]?.some((message) => message.role === "system")).toBe(
      false,
    );
    expect(personalityDeveloperTexts(seenMessages[0] ?? [])).toEqual([]);
  });

  test("config_personality_none_sends_no_personality", async () => {
    const { provider, seenMessages, seenSystemPrompts } = mkProviderRecorder();
    const { session } = mkSession(provider);
    const ctx = mkCtx({
      configPersonality: "none",
      modelMessages: mkPersonalityModelMessages(),
    });

    await drain(session.runTurn("hello", {
      ctx,
      systemPrompt: BASE_INSTRUCTIONS,
    }));

    const instructionsText = seenSystemPrompts[0] ?? "";
    expect(instructionsText).toContain(BASE_INSTRUCTIONS);
    expect(instructionsText).not.toContain(LOCAL_FRIENDLY_TEMPLATE);
    expect(instructionsText).not.toContain(LOCAL_PRAGMATIC_TEMPLATE);
    expect(instructionsText).not.toContain(PERSONALITY_PLACEHOLDER);
    expect(personalityDeveloperTexts(seenMessages[0] ?? [])).toEqual([]);
  });

  test("default_personality_is_pragmatic_without_config_toml", async () => {
    const home = await tempDir("agenc-personality-contract-home-");
    const workspace = await tempDir("agenc-personality-contract-ws-");
    trustProjectSync({
      agencHome: home,
      cwd: workspace,
      env: { HOME: home },
    });

    const { provider, seenMessages, seenSystemPrompts } = mkProviderRecorder();
    const providerMod = await import("../llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockReturnValue(provider as never);
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

    const boot = await bootstrapLocalRuntimeSession({
      apiKey: "test-key",
      env: {
        ...process.env,
        AGENC_HOME: home,
        AGENC_WORKSPACE: workspace,
        AGENC_PROVIDER: "openai",
        AGENC_MODEL: OPENAI_PERSONALITY_MODEL,
        HOME: home,
        OPENAI_API_KEY: "test-key",
      },
    });
    try {
      expect(boot.config.personality).toBeUndefined();

      await drain(boot.session.runTurn("hello", {
        ctx: boot.ctx,
        systemPrompt: BASE_INSTRUCTIONS,
      }));

      expect(seenSystemPrompts[0]).toContain(
        LOCAL_PRAGMATIC_TEMPLATE,
      );
    } finally {
      await boot.shutdown();
    }
  });

  test("user_turn_personality_some_adds_update_message", async () => {
    const { provider, seenMessages } = mkProviderRecorder();
    const { session } = mkSession(provider);
    const modelMessages = mkPersonalityModelMessages();

    await drain(session.runTurn("hello", {
      ctx: mkCtx({ modelMessages }),
      systemPrompt: BASE_INSTRUCTIONS,
    }));
    await drain(session.runTurn("change style", {
      ctx: mkCtx({ personality: "friendly", modelMessages }),
      systemPrompt: BASE_INSTRUCTIONS,
    }));

    const secondRequest = seenMessages[1] ?? [];
    const personalityTexts = personalityDeveloperTexts(secondRequest);
    const personalityText = personalityTexts[0];
    const developerIndex = secondRequest.findIndex(
      (message) =>
        message.role === "developer" &&
        messageText(message).includes(PERSONALITY_SPEC_START_MARKER),
    );
    const userIndex = secondRequest.findIndex(
      (message) =>
        message.role === "user" && messageText(message) === "change style",
    );

    expect(personalityTexts).toHaveLength(1);
    expect(developerIndex).toBeGreaterThanOrEqual(0);
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(developerIndex).toBeLessThan(userIndex);
    expect(developerIndex).toBe(userIndex - 1);
    expect(personalityText).toContain(
      "The user has requested a new communication style.",
    );
    expect(personalityText).toContain(LOCAL_FRIENDLY_TEMPLATE);
  });

  test("user_turn_personality_same_value_does_not_add_update_message", async () => {
    const { provider, seenMessages } = mkProviderRecorder();
    const { session } = mkSession(provider);
    const modelMessages = mkPersonalityModelMessages();

    await drain(session.runTurn("hello", {
      ctx: mkCtx({ personality: "pragmatic", modelMessages }),
      systemPrompt: BASE_INSTRUCTIONS,
    }));
    await drain(session.runTurn("hello", {
      ctx: mkCtx({ personality: "pragmatic", modelMessages }),
      systemPrompt: BASE_INSTRUCTIONS,
    }));

    expect(personalityDeveloperTexts(seenMessages[1] ?? [])).toEqual([]);
  });
});
