import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AsyncQueue } from "../src/utils/async-queue.js";
import { ConfigStore } from "../src/config/store.js";
import type { AgenCConfig } from "../src/config/schema.js";
import type { LLMMessage, LLMProvider, LLMResponse } from "../src/llm/types.js";
import { ProviderHttpClient } from "../src/llm/client.js";
import { createManagedFeatures } from "../src/llm/registry/features.js";
import { PermissionModeRegistry } from "../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../src/permissions/types.js";
import {
  Session,
  type Event,
  type SessionOpts,
  type SessionServices,
} from "../src/session/session.js";
import { resolveAgentRuntimeOptions } from "../src/session/runtime-options.js";
import type {
  Config,
  ManagedFeatures,
  ModelInfo,
  SessionConfiguration,
  TurnContext,
} from "../src/session/turn-context.js";
import type { ToolRegistry } from "../src/tool-registry.js";

const generatedConfigHomes = new Set<string>();

export function createTestConfigStore(
  options: {
    readonly cwd?: string;
    readonly base?: AgenCConfig;
  } = {},
): ConfigStore {
  const home = mkdtempSync(join(tmpdir(), "agenc-test-config-authority-"));
  generatedConfigHomes.add(home);
  return new ConfigStore({
    home,
    env: { AGENC_HOME: home },
    cwd: options.cwd ?? "/tmp",
    ...(options.base !== undefined ? { base: options.base } : {}),
  });
}

afterAll(() => {
  for (const home of generatedConfigHomes) {
    rmSync(home, { recursive: true, force: true });
  }
  generatedConfigHomes.clear();
});

function mkFeatures(): ManagedFeatures {
  return createManagedFeatures();
}

function mkConfig(cwd = "/tmp"): Config {
  return {
    model: "test-model",
    cwd,
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
    contextWindow: 131_072,
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
  readonly cwd?: string;
  readonly provider?: LLMProvider;
  readonly registry?: ToolRegistry;
  readonly services?: Partial<SessionServices>;
  readonly mcpManagerOwnership?: SessionOpts["mcpManagerOwnership"];
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
  const cwd = opts?.cwd ?? "/tmp";
  const state = {
    sessionConfiguration: mkSessionConfiguration({
      cwd,
      provider: {
        slug: "stub-provider",
      } as unknown as SessionConfiguration["provider"],
      collaborationMode: { model: "test-model" },
    }),
    history: [...(opts?.history ?? [])],
    totalTokenUsage: opts?.totalTokenUsage ?? 0,
  };
  const services: SessionServices = {
    admissionRequired: false,
    runtimeOptions: resolveAgentRuntimeOptions({}),
    configStore: createTestConfigStore({
      cwd: state.sessionConfiguration.cwd,
    }),
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
    providerEnvironment: {},
    registry: opts?.registry ?? mkRegistry(),
    hooks: {
      executeStop: async () => ({}),
    },
    permissionModeRegistry: new PermissionModeRegistry(
      createEmptyToolPermissionContext(),
    ),
    ...(opts?.services ?? {}),
  } as unknown as SessionServices;
  const session = new Session({
    conversationId: "conv-test",
    services,
    initialState: state as unknown as SessionOpts["initialState"],
    features: mkFeatures(),
    ...(opts?.mcpManagerOwnership !== undefined
      ? { mcpManagerOwnership: opts.mcpManagerOwnership }
      : {}),
    jsRepl: { id: "repl-test" },
    config: mkConfig(cwd),
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
