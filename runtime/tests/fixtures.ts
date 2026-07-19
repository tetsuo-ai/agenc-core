import { AsyncQueue } from "../src/utils/async-queue.js";
import type { LLMMessage, LLMProvider, LLMResponse } from "../src/llm/types.js";
import { ProviderHttpClient } from "../src/llm/client.js";
import { PermissionModeRegistry } from "../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../src/permissions/types.js";
import {
  Session,
  type Event,
  type SessionOpts,
  type SessionServices,
} from "../src/session/session.js";
import type {
  Config,
  ManagedFeatures,
  ModelInfo,
  SessionConfiguration,
  TurnContext,
} from "../src/session/turn-context.js";
import type { ToolRegistry } from "../src/tool-registry.js";

function mkFeatures(): ManagedFeatures {
  return {
    appsEnabledForAuth: () => false,
    useLegacyLandlock: () => false,
  };
}

function mkConfig(): Config {
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
  };
}

function mkModelInfo(overrides?: Partial<ModelInfo>): ModelInfo {
  return {
    slug: "test-model",
    effectiveContextWindowPercent: 100,
    contextWindow: 1024,
    supportedReasoningLevels: [],
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
    ...overrides,
  };
}

export function mkCtx(overrides?: Partial<TurnContext>): TurnContext {
  return {
    subId: "turn-abc",
    cwd: "/tmp",
    config: { maxTurns: 100 } as unknown,
    configSnapshot: {} as unknown,
    modelInfo: mkModelInfo(),
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
    currentDate: "2026-04-30",
    timezone: "Etc/UTC",
    dynamicTools: [],
    depth: 0,
    toolCallGate: {
      isReady: () => true,
      signal: () => {},
      wait: async () => {},
    },
    ...overrides,
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

export function mkProvider(
  response: Partial<LLMResponse> = {},
  options?: {
    readonly onChat?: (messages: LLMMessage[]) => void;
    readonly onChatStream?: (messages: LLMMessage[]) => void;
    readonly client?: ProviderHttpClient;
  },
): LLMProvider {
  return {
    name: "stub-provider",
    ...(options?.client ? { client: options.client } : {}),
    chat: async (messages) => {
      options?.onChat?.(messages.map((message) => ({ ...message })));
      return {
        content: "summary",
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: "test-model",
        finishReason: "stop",
        ...response,
      };
    },
    chatStream: async (messages): Promise<LLMResponse> => {
      options?.onChatStream?.(messages.map((message) => ({ ...message })));
      return {
        content: "ok",
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: "test-model",
        finishReason: "stop",
        ...response,
      };
    },
    healthCheck: async () => true,
  } as LLMProvider;
}

function mkRegistry(): ToolRegistry {
  return {
    tools: [],
    toLLMTools: () => [],
    dispatch: async () => ({ content: "", isError: false }),
  } as unknown as ToolRegistry;
}

export function mkSession(opts?: {
  readonly provider?: LLMProvider;
  readonly registry?: ToolRegistry;
  readonly history?: readonly LLMMessage[];
  readonly totalTokenUsage?: number;
  readonly modelInfo?: Partial<ModelInfo>;
}): {
  readonly session: Session;
  readonly events: Event[];
  readonly state: {
    sessionConfiguration: SessionConfiguration;
    history: LLMMessage[];
    totalTokenUsage: number;
  };
} {
  const events: Event[] = [];
  const state = {
    sessionConfiguration: mkSessionConfiguration({
      provider: { slug: "stub-provider" } as unknown as SessionConfiguration["provider"],
      collaborationMode: { model: "test-model" },
    }),
    history: [...(opts?.history ?? [])],
    totalTokenUsage: opts?.totalTokenUsage ?? 0,
  };
  const services: SessionServices = {
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
    provider: opts?.provider ?? mkProvider(),
    registry: opts?.registry ?? mkRegistry(),
    hooks: {
      executeStop: async () => ({}),
    },
    permissionModeRegistry: new PermissionModeRegistry(
      createEmptyToolPermissionContext(),
    ),
  } as unknown as SessionServices;
  const session = new Session({
    conversationId: "conv-test",
    services,
    initialState: state as unknown as SessionOpts["initialState"],
    features: mkFeatures(),
    jsRepl: { id: "repl-test" },
    config: mkConfig(),
    modelInfo: mkModelInfo(opts?.modelInfo),
    eventQueue: new AsyncQueue<Event>(),
  });
  session.eventLog.subscribe((event) => {
    events.push(event);
  });
  return { session, events, state };
}

export async function drain(
  gen: AsyncGenerator<unknown, unknown>,
): Promise<void> {
  for await (const _event of gen) {
    // drain
  }
}
