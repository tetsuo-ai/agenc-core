/**
 * Thin daemon-client helpers for CLI surfaces.
 *
 * MG-04 moves CLI startup away from local runtime bootstrap. This module keeps
 * daemon request setup and the minimal TUI session shell outside `bin/agenc.ts`.
 */

import { randomUUID } from "node:crypto";
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
  JsonObject,
  MessageContentBlock,
} from "../app-server/protocol/index.js";
import { resolveAgencHome } from "../config/env.js";
import { ConfigStore } from "../config/store.js";
import { resolveStartupSelection } from "../bin/startup-selection.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import {
  createSessionMcpManagerFromSources,
  createSessionMcpService,
} from "../session/mcp-startup.js";
import { createLocalSkillsServices } from "../skills/local-loader.js";
import { projectMcpManagerToConnections } from "../mcp-client/tui-connections.js";
import {
  createAgentRoleWorkspace,
  normalizeAgentRoleWorkspace,
  type AgentRoleWorkspace,
} from "../agents/role-workspace.js";
import { loadFreshAgentDefinitions } from "../tools/AgentTool/loadAgentsDir.js";
import type {
  AgenCBridgeSession,
  ConfigStoreLike,
} from "../tui/session-types.js";

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
  readonly cwd?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly initialContent?: string | readonly MessageContentBlock[];
  readonly metadata?: JsonObject;
  /** See `AgentCreateParams.permissionMode`. Forwarded verbatim. */
  readonly permissionMode?:
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions";
}

export interface StopAgenCDaemonPromptAgentOptions {
  readonly agentId: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly reason: string;
}

export async function startAgenCDaemonPromptAgent(
  options: AgenCDaemonPromptAgentOptions,
): Promise<AgentCreateResult> {
  const prompt = options.prompt.trim();
  if (prompt.length === 0) {
    throw new Error("daemon prompt startup requires non-empty input");
  }
  const env = options.env ?? process.env;
  await defaultEnsureDaemonReady(env)();
  const client = createAgenCJsonLineDaemonClient({ env });
  const envOverrides = collectDaemonClientEnvOverrides(env);
  return client.createAgent({
    objective: prompt,
    instructions: prompt,
    cwd: options.cwd ?? processCwd(),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.initialContent !== undefined
      ? { initialContent: options.initialContent }
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
  const matches = agents.filter((agent) =>
    agent.activeSessionIds?.includes(sessionId),
  );
  if (matches.length > 1) {
    throw new Error(`daemon session matches multiple agents: ${sessionId}`);
  }
  return matches[0] ?? null;
}

export interface AgenCDaemonOnlyTuiContextOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly conversationId: string;
  /** Immutable daemon-owned role authority, separate from execution cwd. */
  readonly roleWorkspace?: Pick<AgentRoleWorkspace, "id" | "cwd">;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  /**
   * Initial permission mode for the bridge session's PermissionModeRegistry.
   * Forwarded from the CLI when `--yolo` (or its deprecated aliases) was on
   * argv so `/permissions`, `/status`, and the footer chip surface the real
   * runtime authority instead of always claiming `default`.
   */
  readonly permissionMode?:
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions";
}

export interface AgenCDaemonOnlyTuiContext {
  readonly configStore: ConfigStoreLike;
  readonly baseSession: AgenCBridgeSession;
  readonly model?: string;
  readonly workspaceRoot: string;
  close(): Promise<void>;
}

export async function createAgenCDaemonOnlyTuiContext(
  options: AgenCDaemonOnlyTuiContextOptions,
): Promise<AgenCDaemonOnlyTuiContext> {
  const env = options.env ?? process.env;
  const roleWorkspace = options.roleWorkspace
    ? normalizeAgentRoleWorkspace(options.roleWorkspace)
    : createAgentRoleWorkspace(options.cwd);
  const agencHome = resolveAgencHome(env);
  const configStore = new ConfigStore({
    home: agencHome,
    env,
    onWarn: (message) => process.stderr.write(`${message}\n`),
  });
  const config = await configStore.reload();
  const startupArgv = [
    "node",
    "agenc",
    ...(options.provider !== undefined ? ["--provider", options.provider] : []),
    ...(options.model !== undefined ? ["--model", options.model] : []),
    ...(options.profile !== undefined ? ["--profile", options.profile] : []),
  ];
  const startup = resolveStartupSelection({
    config,
    env,
    argv: startupArgv,
  });
  const effectiveConfig = {
    ...startup.config,
    model: startup.model,
    model_provider: startup.provider,
  };
  const configStoreLike: ConfigStoreLike = {
    agencHome,
    current: () => effectiveConfig,
    subscribe: (listener) => configStore.subscribe(listener),
    warnings: () => configStore.warnings(),
  };
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
  const mcpRuntimeManager = await createSessionMcpManagerFromSources(
    effectiveConfig,
    env,
    {
      cwd: roleWorkspace.cwd,
      includeProjectMcpServers: options.permissionMode === "bypassPermissions",
    },
  );
  await mcpRuntimeManager.start();
  const mcpService = createSessionMcpService(mcpRuntimeManager, { env });
  const agentDefinitions = await loadFreshAgentDefinitions(roleWorkspace.cwd);
  const abortController = new AbortController();
  let nextEventId = 0;
  const sessionConfiguration = {
    cwd: options.cwd,
    provider: { slug: startup.provider },
    collaborationMode: { model: startup.model },
  };
  const session: AgenCBridgeSession = {
    conversationId: options.conversationId,
    roleWorkspace,
    agentDefinitions,
    cwd: options.cwd,
    home: agencHome,
    sessionConfiguration,
    services: {
      permissionModeRegistry: new PermissionModeRegistry(
        createEmptyToolPermissionContext({
          mode: options.permissionMode ?? "default",
          isBypassPermissionsModeAvailable:
            options.permissionMode === "bypassPermissions",
        }),
      ),
      configStore,
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
    listMcpClients: () =>
      projectMcpManagerToConnections(mcpService as never),
    listMcpTools: () => mcpService.getTools?.() ?? [],
  };
  return {
    configStore: configStoreLike,
    baseSession: session,
    model: startup.model,
    workspaceRoot: options.cwd,
    close: async () => {
      await skillsServices.skillsWatcher?.stop?.();
      await mcpRuntimeManager.stop();
    },
  };
}
