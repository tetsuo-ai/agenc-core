/**
 * Thin daemon-client helpers for CLI surfaces.
 *
 * MG-04 moves CLI startup away from local runtime bootstrap. This module keeps
 * daemon request setup and the minimal TUI session shell outside `bin/agenc.ts`.
 */

import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { cwd as processCwd } from "node:process";
import {
  collectDaemonClientEnvOverrides,
  createAgenCJsonLineDaemonClient,
  createConnectedAgenCJsonLineDaemonTuiClient,
  defaultEnsureDaemonReady,
  resolveAgenCAgentAttachCwd,
  resolveAgenCAgentAttachRoleWorkspace,
  type AgenCJsonLineDaemonTuiClient,
} from "../app-server/agent-cli.js";
import type {
  AgentCreateResult,
  AgentSummary,
  EditorInteractionParams,
  JsonObject,
  MessageContentBlock,
} from "../app-server/protocol/index.js";
import type { SessionEditorInteraction } from "../session/autonomous-mode.js";
import { sessionConfigurationFromAgenCConfig } from "../session/configuration.js";
import {
  resolveAgentRuntimeOptions,
  runWithAgentRuntimeOptions,
  type AgentRuntimeOptions,
} from "../session/runtime-options.js";
import { resolveAgencHome } from "../config/env.js";
import { ConfigStore } from "../config/store.js";
import {
  resolveCanonicalStartupSelection,
  resolvedStartupProfileName,
  startupConfigLayerOptions,
  type StartupCliFlags,
} from "../bin/startup-selection.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import {
  createSessionMcpManagerFromAuthority,
  createSessionMcpService,
} from "../session/mcp-startup.js";
import { createLocalSkillsServices } from "../skills/local-loader.js";
import { projectMcpManagerToConnections } from "../mcp-client/tui-connections.js";
import { SandboxExecutionBroker } from "../sandbox/execution-broker.js";
import {
  createAgentRoleWorkspace,
  normalizeAgentRoleWorkspace,
  type AgentRoleWorkspace,
} from "../agents/role-workspace.js";
import { loadFreshAgentDefinitions } from "../tools/AgentTool/loadAgentsDir.js";
import type { AgenCBridgeSession } from "../tui/session-types.js";
import { snapshotProviderEnvironment } from "../llm/provider-options.js";

export {
  collectDaemonClientEnvOverrides,
  createAgenCJsonLineDaemonClient,
  createConnectedAgenCJsonLineDaemonTuiClient,
  defaultEnsureDaemonReady,
  resolveAgenCAgentAttachCwd,
  resolveAgenCAgentAttachRoleWorkspace,
  type AgenCJsonLineDaemonTuiClient,
};

export interface AgenCDaemonPromptAgentOptions {
  readonly prompt: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly runtimeOptions?: AgentRuntimeOptions;
  readonly cwd?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly configPath?: string;
  readonly initialContent?: string | readonly MessageContentBlock[];
  readonly deferInitialTurn?: boolean;
  readonly initialDisplayUserMessage?: string | null;
  readonly initialEditorInteraction?: SessionEditorInteraction;
  readonly metadata?: JsonObject;
  /** See `AgentCreateParams.permissionMode`. Forwarded verbatim. */
  readonly permissionMode?:
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions"
    | "dontAsk"
    | "auto";
}

export interface StopAgenCDaemonPromptAgentOptions {
  readonly agentId: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly reason: string;
}

export interface ResumeAgenCDaemonPromptAgentOptions {
  readonly sessionId: string;
  readonly rolloutPath: string;
  readonly sourceProof: {
    readonly dev: string;
    readonly ino: string;
    readonly size: string;
    readonly sha256: string;
    readonly cwdDev: string;
    readonly cwdIno: string;
  };
  readonly env?: NodeJS.ProcessEnv;
  readonly runtimeOptions?: AgentRuntimeOptions;
  readonly cwd?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly configPath?: string;
  readonly permissionMode?:
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions"
    | "dontAsk"
    | "auto";
}

export async function startAgenCDaemonPromptAgent(
  options: AgenCDaemonPromptAgentOptions,
): Promise<AgentCreateResult> {
  const prompt = options.prompt.trim();
  if (prompt.length === 0) {
    throw new Error("daemon prompt startup requires non-empty input");
  }
  const env = options.env ?? process.env;
  const runtimeOptions =
    options.runtimeOptions ?? resolveAgentRuntimeOptions(env);
  await defaultEnsureDaemonReady(env)();
  const client = createAgenCJsonLineDaemonClient({ env });
  const envOverrides = collectDaemonClientEnvOverrides(env);
  const cwd = options.cwd ?? processCwd();
  return client.createAgent({
    objective: prompt,
    instructions: prompt,
    cwd,
    runtimeOptions,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.configPath !== undefined
      ? { configPath: resolvePath(cwd, options.configPath) }
      : {}),
    ...(options.initialContent !== undefined
      ? { initialContent: options.initialContent }
      : {}),
    ...(options.deferInitialTurn !== undefined
      ? { deferInitialTurn: options.deferInitialTurn }
      : {}),
    ...(options.initialDisplayUserMessage !== undefined
      ? { initialDisplayUserMessage: options.initialDisplayUserMessage }
      : {}),
    ...(options.initialEditorInteraction !== undefined
      ? {
          initialEditorInteraction: editorInteractionParams(
            options.initialEditorInteraction,
          ),
        }
      : {}),
    ...(options.permissionMode !== undefined
      ? { permissionMode: options.permissionMode }
      : {}),
    ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
    metadata: {
      source: "agenc.prompt",
      ...(options.metadata ?? {}),
    },
  });
}

/** Restore a retained canonical rollout into a new daemon-owned TUI runtime. */
export async function resumeAgenCDaemonPromptAgent(
  options: ResumeAgenCDaemonPromptAgentOptions,
): Promise<AgentCreateResult> {
  const sessionId = options.sessionId.trim();
  if (sessionId.length === 0) {
    throw new Error("daemon prompt resume requires a non-empty session id");
  }
  const env = options.env ?? process.env;
  const runtimeOptions =
    options.runtimeOptions ?? resolveAgentRuntimeOptions(env);
  await defaultEnsureDaemonReady(env)();
  const client = createAgenCJsonLineDaemonClient({ env });
  const envOverrides = collectDaemonClientEnvOverrides(env);
  const cwd = options.cwd ?? processCwd();
  return client.createAgent({
    resumeSessionId: sessionId,
    resumeRolloutPath: options.rolloutPath,
    resumeSourceProof: options.sourceProof,
    cwd,
    runtimeOptions,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.configPath !== undefined
      ? { configPath: resolvePath(cwd, options.configPath) }
      : {}),
    ...(options.permissionMode !== undefined
      ? { permissionMode: options.permissionMode }
      : {}),
    ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
  });
}

function editorInteractionParams(
  interaction: SessionEditorInteraction,
): EditorInteractionParams {
  return {
    interactionId: interaction.interactionId,
    kind: interaction.kind,
    policy: interaction.policy,
    editorInstanceId: interaction.editorInstanceId,
    bufferHandle: interaction.bufferHandle,
    changedtick: interaction.changedtick,
    contentSha256: interaction.contentSha256,
    ...(interaction.path !== undefined ? { path: interaction.path } : {}),
    range: {
      start: {
        line: interaction.range.start.line,
        column: interaction.range.start.column,
      },
      end: {
        line: interaction.range.end.line,
        column: interaction.range.end.column,
      },
    },
    ...(interaction.selectionMode !== undefined
      ? { selectionMode: interaction.selectionMode }
      : {}),
  };
}

export async function stopAgenCDaemonPromptAgent(
  options: StopAgenCDaemonPromptAgentOptions,
): Promise<void> {
  const env = options.env ?? process.env;
  const client = createAgenCJsonLineDaemonClient({ env });
  await client.stopAgent({
    agentId: options.agentId,
    reason: options.reason,
  });
}

export async function listAgenCDaemonAgents(
  client: AgenCJsonLineDaemonTuiClient,
  options: { readonly maxPages?: number } = {},
): Promise<readonly AgentSummary[]> {
  const agents: AgentSummary[] = [];
  const seenCursors = new Set<string>();
  const maxPages = options.maxPages ?? 1_000;
  let pageCount = 0;
  let cursor: string | undefined;
  for (;;) {
    if (pageCount >= maxPages) {
      throw new Error("daemon agent list exceeded pagination limit");
    }
    pageCount += 1;
    const page = await client.request("agent.list", {
      limit: 100,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    agents.push(...page.agents);
    if (page.nextCursor === undefined) return agents;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("daemon returned a repeated agent list cursor");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export async function findAgenCDaemonAgentBySessionId(
  client: AgenCJsonLineDaemonTuiClient,
  sessionId: string,
): Promise<AgentSummary | null> {
  const agents = await listAgenCDaemonAgents(client);
  const matches = agents.filter(
    (agent) =>
      (agent.agentId === sessionId ||
        agent.activeSessionIds?.includes(sessionId) === true) &&
      (agent.status === "running" || agent.status === "idle") &&
      !isPersistedAgentWithoutRuntime(agent),
  );
  if (matches.length > 1) {
    throw new Error(`daemon session matches multiple agents: ${sessionId}`);
  }
  return matches[0] ?? null;
}

function isPersistedAgentWithoutRuntime(agent: AgentSummary): boolean {
  const recovery = agent.metadata?.recovery;
  if (
    typeof recovery === "object" &&
    recovery !== null &&
    !Array.isArray(recovery)
  ) {
    const runtimeRestore = (recovery as JsonObject).runtimeRestore;
    if (runtimeRestore === "available") return false;
    if (runtimeRestore === "unavailable") return true;
  }
  return agent.metadata?.recovered === true;
}

export interface AgenCDaemonOnlyTuiContextOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly runtimeOptions?: AgentRuntimeOptions;
  readonly cwd: string;
  readonly conversationId: string;
  /** Immutable daemon-owned role authority, separate from execution cwd. */
  readonly roleWorkspace?: Pick<AgentRoleWorkspace, "id" | "cwd">;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly configPath?: string;
  /**
   * Initial permission mode for the bridge session's PermissionModeRegistry.
   * Forwarded from the CLI when
   * `--dangerously-bypass-approvals-and-sandbox` was on argv so
   * `/permissions`, `/status`, and the footer chip surface the real
   * runtime authority instead of always claiming `default`.
   */
  readonly permissionMode?:
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions"
    | "dontAsk"
    | "auto";
}

export type AgenCDaemonOnlyTuiSession = Omit<AgenCBridgeSession, "services"> & {
  readonly services: AgenCBridgeSession["services"] & {
    readonly configStore: ConfigStore;
  };
};

export interface AgenCDaemonOnlyTuiContext {
  readonly baseSession: AgenCDaemonOnlyTuiSession;
  readonly model?: string;
  readonly workspaceRoot: string;
  close(): Promise<void>;
}

export function createAgenCDaemonOnlyTuiContext(
  options: AgenCDaemonOnlyTuiContextOptions,
): Promise<AgenCDaemonOnlyTuiContext> {
  const env = options.env ?? process.env;
  const runtimeOptions =
    options.runtimeOptions ?? resolveAgentRuntimeOptions(env);
  return runWithAgentRuntimeOptions(runtimeOptions, () =>
    createBoundAgenCDaemonOnlyTuiContext(options, env, runtimeOptions),
  );
}

async function createBoundAgenCDaemonOnlyTuiContext(
  options: AgenCDaemonOnlyTuiContextOptions,
  env: NodeJS.ProcessEnv,
  runtimeOptions: AgentRuntimeOptions,
): Promise<AgenCDaemonOnlyTuiContext> {
  const providerEnvironment = snapshotProviderEnvironment(env);
  const roleWorkspace = options.roleWorkspace
    ? normalizeAgentRoleWorkspace(options.roleWorkspace)
    : createAgentRoleWorkspace(options.cwd);
  const agencHome = resolveAgencHome(env);
  const cli: StartupCliFlags = Object.freeze({
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.configPath !== undefined
      ? { configPath: options.configPath }
      : {}),
  });
  const configStore = new ConfigStore({
    home: agencHome,
    env,
    cwd: roleWorkspace.cwd,
    ...startupConfigLayerOptions({ cli, env, cwd: roleWorkspace.cwd }),
    onWarn: (message) => process.stderr.write(`${message}\n`),
  });
  const effectiveConfig = await configStore.reload();
  const profileName = resolvedStartupProfileName(cli, env);
  const startup = resolveCanonicalStartupSelection({
    config: effectiveConfig,
    env,
    ...(profileName !== undefined ? { profileName } : {}),
  });
  const skillsServices = createLocalSkillsServices({
    agencHome,
    workspaceRoot: roleWorkspace.cwd,
    config: effectiveConfig,
    env: {
      HOME: env.HOME,
      AGENC_MANAGED_HOME: env.AGENC_MANAGED_HOME,
    },
  });
  await skillsServices.skillsWatcher.start();
  const sandboxExecutionBroker = new SandboxExecutionBroker({
    mode:
      options.permissionMode === "bypassPermissions"
        ? "danger_full_access"
        : effectiveConfig.sandbox_mode === "read-only"
          ? "read_only"
          : effectiveConfig.sandbox_mode === "danger-full-access"
            ? "danger_full_access"
            : "workspace_write",
    // Role authority remains anchored to the canonical checkout, while
    // execution policy must follow the attached worktree/session cwd.
    cwd: options.cwd,
    env,
    allowGpu: effectiveConfig.sandbox?.allow_gpu === true,
  });
  const mcpRuntimeManager = await createSessionMcpManagerFromAuthority(
    configStore,
    providerEnvironment,
    {
      sandboxExecutionBroker,
    },
  );
  await mcpRuntimeManager.start();
  const mcpService = createSessionMcpService(mcpRuntimeManager, {
    authority: configStore,
    environment: providerEnvironment,
  });
  const agentDefinitions = await loadFreshAgentDefinitions(roleWorkspace.cwd);
  const abortController = new AbortController();
  let nextEventId = 0;
  const sessionConfiguration = {
    ...sessionConfigurationFromAgenCConfig({
      config: effectiveConfig,
      workspaceRoot: options.cwd,
      provider: startup.provider,
      model: startup.model,
      dangerouslyBypassApprovalsAndSandbox:
        options.permissionMode === "bypassPermissions",
    }),
    // The bridge exposes provider identity, not an in-process LLMProvider.
    provider: { slug: startup.provider },
  };
  const session: AgenCDaemonOnlyTuiSession = {
    conversationId: options.conversationId,
    roleWorkspace,
    agentDefinitions,
    cwd: options.cwd,
    home: agencHome,
    sessionConfiguration,
    services: {
      runtimeOptions,
      providerEnvironment,
      permissionModeRegistry: new PermissionModeRegistry(
        createEmptyToolPermissionContext({
          mode: options.permissionMode ?? "default",
          isBypassPermissionsModeAvailable:
            options.permissionMode === "bypassPermissions",
        }),
      ),
      configStore,
      sandboxExecutionBroker,
      mcpManager: mcpService,
      skillsManager: skillsServices.skillsManager,
      pluginsManager: skillsServices.pluginsManager,
      skillsWatcher: skillsServices.skillsWatcher,
      authManager: { mode: "local_no_auth" },
    },
    config: effectiveConfig,
    state: {
      unsafePeek: () => ({
        sessionConfiguration,
        history: [],
      }),
    },
    activeTurn: {
      unsafePeek: () => null,
    },
    abortController,
    abortTerminal: (reason) => {
      if (!abortController.signal.aborted) abortController.abort(reason);
    },
    flushEventLog: () => {},
    emit: () => {},
    nextInternalSubId: () => `daemon-client-${++nextEventId}-${randomUUID()}`,
    listMcpClients: () => projectMcpManagerToConnections(mcpService as never),
    listMcpTools: () => mcpService.getTools?.() ?? [],
  };
  return {
    baseSession: session,
    model: startup.model,
    workspaceRoot: options.cwd,
    close: async () => {
      await skillsServices.skillsWatcher?.stop?.();
      await mcpRuntimeManager.stop();
    },
  };
}
