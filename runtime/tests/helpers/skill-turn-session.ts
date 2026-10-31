/**
 * A daemon-style session on DeepSeek Flash at high effort, for tests of the
 * turn a user starts by invoking a skill.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigStore } from "../../src/config/store.js";
import { createManagedFeatures } from "../../src/llm/registry/features.js";
import type { LLMProvider, LLMResponse } from "../../src/llm/types.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "../../src/permissions/types.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import {
  Session,
  type SessionOpts,
  type SessionServices,
} from "../../src/session/session.js";
import type {
  Config,
  SessionConfiguration,
} from "../../src/session/turn-context.js";
import { AsyncQueue } from "../../src/utils/async-queue.js";

const homes: string[] = [];

/** Remove the config homes the sessions of a test created. */
export function removeSkillTurnHomes(): void {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
}

function configStore(): ConfigStore {
  const home = mkdtempSync(join(tmpdir(), "agenc-skill-turn-"));
  homes.push(home);
  return new ConfigStore({ home, env: { AGENC_HOME: home }, cwd: "/tmp" });
}

function provider(): LLMProvider {
  const response: LLMResponse = {
    content: "done",
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: "deepseek-flash",
    finishReason: "stop",
  };
  return {
    name: "deepseek",
    chat: async () => response,
    chatStream: async () => response,
    healthCheck: async () => true,
  } as LLMProvider;
}

export function deepSeekSkillTurnSession(options: {
  readonly permissionContext?: ToolPermissionContext;
  readonly skillsManager?: unknown;
} = {}): Session {
  const store = configStore();
  const sessionConfiguration: SessionConfiguration = {
    cwd: "/tmp",
    approvalPolicy: { value: "on_request" },
    sandboxPolicy: { value: "workspace_write" },
    fileSystemSandboxPolicy: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [] },
    networkSandboxPolicy: { allowlist: [], denylist: [], allowManagedDomainsOnly: false },
    windowsSandboxLevel: "none",
    provider: { slug: "deepseek" },
    collaborationMode: { model: "deepseek-flash", reasoningEffort: "high" },
    dynamicTools: [],
    sessionSource: "cli_main",
  } as unknown as SessionConfiguration;
  const config: Config = {
    model: "deepseek-flash",
    cwd: "/tmp",
    features: createManagedFeatures(),
    multiAgentV2: { usageHintEnabled: false, usageHintText: "", hideSpawnAgentMetadata: false },
    permissions: {
      allowLoginShell: false,
      shellEnvironmentPolicy: { allowedEnvVars: [], blockedEnvVars: [] },
      windowsSandboxPrivateDesktop: false,
    },
    ghostSnapshot: { enabled: false },
    agentRoles: [],
  } as Config;
  const services = {
    admissionRequired: false,
    runtimeOptions: resolveAgentRuntimeOptions({}),
    configStore: store,
    mcpConnectionManager: {
      setApprovalPolicy: () => {},
      setSandboxPolicy: () => {},
      requiredStartupFailures: async () => [],
    },
    mcpStartupCancellationToken: { cancel: () => {}, isCancelled: () => false },
    provider: provider(),
    providerEnvironment: { DEEPSEEK_API_KEY: "test-key" },
    registry: {
      tools: [],
      toLLMTools: () => [],
      dispatch: async () => ({ content: "", isError: false }),
    },
    hooks: { executeStop: async () => ({}) },
    ...(options.skillsManager !== undefined
      ? { skillsManager: options.skillsManager }
      : {}),
    permissionModeRegistry: new PermissionModeRegistry(
      options.permissionContext ?? createEmptyToolPermissionContext(),
    ),
  } as unknown as SessionServices;
  return new Session({
    conversationId: "conv-skill-turn",
    services,
    initialState: {
      sessionConfiguration,
      history: [],
      totalTokenUsage: 0,
    } as unknown as SessionOpts["initialState"],
    features: createManagedFeatures(),
    jsRepl: { id: "repl-skill-turn" },
    config,
    modelInfo: {
      slug: "deepseek-flash",
      effectiveContextWindowPercent: 100,
      contextWindow: 1_048_576,
      supportedReasoningLevels: ["low", "high", "max"],
      defaultReasoningSummary: "auto",
      truncationPolicy: "off",
      usedFallbackModelMetadata: false,
    },
    eventQueue: new AsyncQueue(),
  });
}

