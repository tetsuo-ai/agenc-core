/**
 * A daemon-style session on DeepSeek Flash at high effort, for tests of the
 * turn a user starts by invoking a skill.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const managedPolicies = new WeakMap<Session, string>();

/** Remove the config homes the sessions of a test created. */
export function removeSkillTurnHomes(): void {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
}

function configStore(managedPolicy: boolean): {
  readonly store: ConfigStore;
  readonly managedConfigPath?: string;
} {
  const home = mkdtempSync(join(tmpdir(), "agenc-skill-turn-"));
  homes.push(home);
  if (!managedPolicy) {
    return { store: new ConfigStore({ home, env: { AGENC_HOME: home }, cwd: "/tmp" }) };
  }
  const managedRoot = join(home, "managed");
  mkdirSync(managedRoot, { recursive: true });
  const managedConfigPath = join(managedRoot, "config.toml");
  writeManagedPolicy(managedConfigPath, []);
  return {
    managedConfigPath,
    store: new ConfigStore({
      home,
      env: { AGENC_HOME: home },
      cwd: "/tmp",
      managedConfigPath,
      managedDropInDir: join(managedRoot, "config.d"),
    }),
  };
}

function writeManagedPolicy(path: string, lines: readonly string[]): void {
  writeFileSync(path, ["config_version = 2", ...lines, ""].join("\n"), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Replace the managed policy of a session made with `managedPolicy: true` and
 * reload its config store, as a policy change the daemon picks up does.
 */
export async function reloadManagedPolicy(
  session: Session,
  lines: readonly string[],
): Promise<void> {
  const path = managedPolicies.get(session);
  if (path === undefined) throw new Error("session has no managed policy file");
  writeManagedPolicy(path, lines);
  await session.services.configStore!.reload();
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
  /** Read managed policy from a file `reloadManagedPolicy` can change. */
  readonly managedPolicy?: boolean;
  readonly registry?: unknown;
  readonly codeModeService?: unknown;
} = {}): Session {
  const { store, managedConfigPath } = configStore(options.managedPolicy === true);
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
    registry: options.registry ?? {
      tools: [],
      toLLMTools: () => [],
      dispatch: async () => ({ content: "", isError: false }),
    },
    ...(options.codeModeService !== undefined
      ? { codeModeService: options.codeModeService }
      : {}),
    hooks: { executeStop: async () => ({}) },
    ...(options.skillsManager !== undefined
      ? { skillsManager: options.skillsManager }
      : {}),
    permissionModeRegistry: new PermissionModeRegistry(
      options.permissionContext ?? createEmptyToolPermissionContext(),
    ),
  } as unknown as SessionServices;
  const session = new Session({
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
  if (managedConfigPath !== undefined) managedPolicies.set(session, managedConfigPath);
  return session;
}

