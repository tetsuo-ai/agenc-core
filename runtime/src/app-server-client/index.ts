/**
 * Thin daemon-client helpers for CLI surfaces.
 *
 * MG-04 moves CLI startup away from local runtime bootstrap. This module keeps
 * daemon request setup and the minimal TUI session shell outside `bin/agenc.ts`.
 */

import { Buffer } from "node:buffer";
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
import { createLocalSkillsServices } from "../skills/local-loader.js";
import { SandboxExecutionBroker } from "../sandbox/execution-broker.js";
import {
  disposeSandboxExecutionBroker,
  transitionSandboxExecutionBrokerMode,
} from "../sandbox/execution-lifecycle.js";
import {
  createAgentRoleWorkspace,
  normalizeAgentRoleWorkspace,
  type AgentRoleWorkspace,
} from "../agents/role-workspace.js";
import { loadFreshAgentDefinitions } from "../tools/AgentTool/loadAgentsDir.js";
import type { AgenCBridgeSession } from "../tui/session-types.js";
import { snapshotProviderEnvironment } from "../llm/provider-options.js";
import {
  RUN_RUNTIME_MODEL_VERBOSITIES,
  RUN_RUNTIME_PERMISSION_MODES,
  RUN_RUNTIME_REASONING_EFFORTS,
  RUN_RUNTIME_SERVICE_TIERS,
  type RunRuntimeSettingsSnapshot,
} from "../contracts/run-contracts.js";
import {
  validateAndDedupeAdditionalWorkingDirectoryInputs,
} from "../contracts/additional-working-directories.js";
import { canonicalizeBypassPermissionsCwd } from "../permissions/bypass-consent-state.js";
import type { SessionConfiguration } from "../session/turn-context.js";

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
  readonly addDirs?: readonly string[];
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
  readonly addDirs?: readonly string[];
  readonly permissionMode?:
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions"
    | "dontAsk"
    | "auto";
}

function additionalDirectoryCreateParams(
  addDirs: readonly string[] | undefined,
): { readonly addDirs?: readonly string[] } {
  if (addDirs === undefined) return {};
  return {
    addDirs: validateAndDedupeAdditionalWorkingDirectoryInputs(
      addDirs,
      "daemon client addDirs",
    ),
  };
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
    ...additionalDirectoryCreateParams(options.addDirs),
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
    ...additionalDirectoryCreateParams(options.addDirs),
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
  const live = agents.filter(
    (agent) =>
      (agent.status === "running" || agent.status === "idle") &&
      !isPersistedAgentWithoutRuntime(agent),
  );
  const exact = live.filter((agent) => agent.agentId === sessionId);
  if (exact.length > 1) {
    throw new Error(`daemon session matches multiple agents: ${sessionId}`);
  }
  if (exact[0] !== undefined) return exact[0];

  const aliases = live.filter(
    (agent) => agent.activeSessionIds?.includes(sessionId) === true,
  );
  if (aliases.length > 1) {
    throw new Error(`daemon session matches multiple agents: ${sessionId}`);
  }
  return aliases[0] ?? null;
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
  /** Live daemon-owned authority returned by `agent.attach`. */
  readonly runtimeSettings?: RunRuntimeSettingsSnapshot;
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

function daemonTuiPermissionContext(
  cwd: string,
  runtimeSettings: RunRuntimeSettingsSnapshot | undefined,
  fallbackMode: AgenCDaemonOnlyTuiContextOptions["permissionMode"],
) {
  const canonicalCwd = canonicalizeBypassPermissionsCwd(cwd);
  if (runtimeSettings === undefined) {
    const mode = fallbackMode ?? "default";
    const bypassActive = mode === "bypassPermissions";
    return createEmptyToolPermissionContext({
      mode,
      isBypassPermissionsModeAvailable: bypassActive,
      ...(bypassActive
        ? { bypassPermissionsAcceptedIn: [canonicalCwd] }
        : {}),
    });
  }

  const bounded = (value: unknown, maxBytes: number): boolean =>
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes;
  const bypassTransitionCritical =
    runtimeSettings.permissionMode === "bypassPermissions" ||
    (runtimeSettings.permissionMode === "plan" &&
      runtimeSettings.prePlanMode === "bypassPermissions");
  if (
    !RUN_RUNTIME_PERMISSION_MODES.includes(runtimeSettings.permissionMode) ||
    (runtimeSettings.prePlanMode !== null &&
      !RUN_RUNTIME_PERMISSION_MODES.includes(runtimeSettings.prePlanMode)) ||
    (runtimeSettings.permissionMode === "plan"
      ? runtimeSettings.prePlanMode === null ||
        runtimeSettings.prePlanMode === "plan"
      : runtimeSettings.prePlanMode !== null) ||
    typeof runtimeSettings.autoModeActive !== "boolean" ||
    typeof runtimeSettings.autoModeAvailable !== "boolean" ||
    (runtimeSettings.autoModeActive && !runtimeSettings.autoModeAvailable) ||
    typeof runtimeSettings.bypassPermissionsModeAvailable !== "boolean" ||
    (runtimeSettings.permissionMode === "auto"
      ? runtimeSettings.autoModeActive !== true
      : runtimeSettings.permissionMode !== "plan" &&
        runtimeSettings.autoModeActive !== false) ||
    (bypassTransitionCritical &&
      (runtimeSettings.bypassPermissionsWorkspace !== canonicalCwd ||
        !runtimeSettings.bypassPermissionsModeAvailable ||
        runtimeSettings.bypassPermissionsConsentWorkspace !== canonicalCwd)) ||
    (!bypassTransitionCritical &&
      runtimeSettings.bypassPermissionsWorkspace !== null) ||
    (runtimeSettings.bypassPermissionsConsentWorkspace !== null &&
      runtimeSettings.bypassPermissionsConsentWorkspace !== canonicalCwd) ||
    (runtimeSettings.bypassPermissionsConsentWorkspace !== null &&
      !runtimeSettings.bypassPermissionsModeAvailable) ||
    !bounded(runtimeSettings.model, 1_024) ||
    !bounded(runtimeSettings.provider, 256) ||
    (runtimeSettings.profile !== null &&
      !bounded(runtimeSettings.profile, 256)) ||
    (runtimeSettings.reasoningEffort !== null &&
      !RUN_RUNTIME_REASONING_EFFORTS.includes(
        runtimeSettings.reasoningEffort,
      )) ||
    (runtimeSettings.modelVerbosity !== null &&
      !RUN_RUNTIME_MODEL_VERBOSITIES.includes(
        runtimeSettings.modelVerbosity,
      )) ||
    (runtimeSettings.serviceTier !== null &&
      !RUN_RUNTIME_SERVICE_TIERS.includes(runtimeSettings.serviceTier)) ||
    typeof runtimeSettings.hooksDisabled !== "boolean"
  ) {
    throw new Error(
      "daemon runtime settings are not canonically valid for this cwd",
    );
  }

  return createEmptyToolPermissionContext({
    mode: runtimeSettings.permissionMode,
    ...(runtimeSettings.permissionMode === "plan" &&
    runtimeSettings.prePlanMode !== null
      ? { prePlanMode: runtimeSettings.prePlanMode }
      : {}),
    autoModeActive: runtimeSettings.autoModeActive,
    isAutoModeAvailable: runtimeSettings.autoModeAvailable,
    isBypassPermissionsModeAvailable:
      runtimeSettings.bypassPermissionsModeAvailable,
    ...(runtimeSettings.bypassPermissionsConsentWorkspace === canonicalCwd
      ? { bypassPermissionsAcceptedIn: [canonicalCwd] }
      : {}),
  });
}

type DaemonTuiSessionConfiguration = Omit<SessionConfiguration, "provider"> & {
  readonly provider: { readonly slug: string };
};

interface DaemonTuiSandboxAuthority {
  readonly broker?: SandboxExecutionBroker;
  readonly configuredMode: SessionConfiguration["sandboxPolicy"]["value"];
  readonly configuredApprovalPolicy: SessionConfiguration["approvalPolicy"];
  readonly configuredSandboxPolicy: SessionConfiguration["sandboxPolicy"];
  readonly configuredFileSystemPolicy: SessionConfiguration[
    "fileSystemSandboxPolicy"
  ];
  hooksDisabled: boolean;
}

const daemonTuiSandboxAuthorities = new WeakMap<
  AgenCDaemonOnlyTuiSession,
  DaemonTuiSandboxAuthority
>();

function captureDaemonTuiSandboxAuthority(
  configuration: DaemonTuiSessionConfiguration,
  broker?: SandboxExecutionBroker,
  hooksDisabled = false,
): DaemonTuiSandboxAuthority {
  return {
    ...(broker !== undefined ? { broker } : {}),
    configuredMode: configuration.sandboxPolicy.value,
    configuredApprovalPolicy: configuration.approvalPolicy,
    configuredSandboxPolicy: configuration.sandboxPolicy,
    configuredFileSystemPolicy: configuration.fileSystemSandboxPolicy,
    hooksDisabled,
  };
}

function replaceDaemonTuiSessionConfiguration(
  target: DaemonTuiSessionConfiguration,
  source: DaemonTuiSessionConfiguration,
): void {
  for (const key of Object.keys(target)) {
    if (!Reflect.deleteProperty(target, key)) {
      throw new Error(`daemon TUI session configuration key is fixed: ${key}`);
    }
  }
  Object.assign(target, source);
}

function daemonTuiSessionConfiguration(
  configured: DaemonTuiSessionConfiguration,
  runtimeSettings: RunRuntimeSettingsSnapshot | undefined,
  sandboxAuthority?: DaemonTuiSandboxAuthority,
  bypassActive = runtimeSettings?.permissionMode === "bypassPermissions",
  dangerouslyBypassApprovalsAndSandbox = false,
): DaemonTuiSessionConfiguration {
  const executionProjection =
    sandboxAuthority === undefined
      ? {}
      : {
          approvalPolicy: bypassActive
            ? { value: "never" as const }
            : sandboxAuthority.configuredApprovalPolicy,
          sandboxPolicy: dangerouslyBypassApprovalsAndSandbox
            ? { value: "danger_full_access" as const }
            : sandboxAuthority.configuredSandboxPolicy,
          fileSystemSandboxPolicy: dangerouslyBypassApprovalsAndSandbox
            ? {
                allowWrite: [],
                denyWrite: [],
                allowRead: [],
                denyRead: [],
              }
            : sandboxAuthority.configuredFileSystemPolicy,
        };
  if (runtimeSettings === undefined) {
    return { ...configured, ...executionProjection };
  }
  const {
    modelVerbosity: _configuredModelVerbosity,
    serviceTier: _configuredServiceTier,
    collaborationMode,
    ...base
  } = configured;
  const configuredCollaborationMode = collaborationMode ?? {
    model: runtimeSettings.model,
  };
  const {
    reasoningEffort: _configuredReasoningEffort,
    ...collaborationModeBase
  } = configuredCollaborationMode;
  return {
    ...base,
    ...executionProjection,
    provider: { slug: runtimeSettings.provider },
    collaborationMode: {
      ...collaborationModeBase,
      model: runtimeSettings.model,
      ...(runtimeSettings.reasoningEffort !== null
        ? { reasoningEffort: runtimeSettings.reasoningEffort }
        : {}),
    },
    ...(runtimeSettings.modelVerbosity !== null
      ? { modelVerbosity: runtimeSettings.modelVerbosity }
      : {}),
    ...(runtimeSettings.serviceTier !== null
      ? { serviceTier: runtimeSettings.serviceTier }
      : {}),
  };
}

export type AgenCDaemonOnlyTuiSession = Omit<AgenCBridgeSession, "services"> & {
  readonly services: AgenCBridgeSession["services"] & {
    readonly configStore: ConfigStore;
  };
};

/** Apply one canonical daemon settings successor to the client-side TUI shim. */
export async function applyDaemonTuiRuntimeSettingsAuthority(
  session: AgenCDaemonOnlyTuiSession,
  cwd: string,
  settings: RunRuntimeSettingsSnapshot,
): Promise<void> {
  const permissionContext = daemonTuiPermissionContext(cwd, settings, undefined);
  const registry = session.services.permissionModeRegistry;
  if (typeof registry.update !== "function") {
    throw new Error("daemon TUI session cannot apply live permission settings");
  }
  const updateRegistry = registry.update.bind(registry);
  const mutable = session as AgenCDaemonOnlyTuiSession & {
    sessionConfiguration: DaemonTuiSessionConfiguration;
  };
  const previousConfiguration = { ...mutable.sessionConfiguration };
  let sandboxAuthority = daemonTuiSandboxAuthorities.get(session);
  if (sandboxAuthority === undefined) {
    const broker = session.services.sandboxExecutionBroker;
    sandboxAuthority = captureDaemonTuiSandboxAuthority(
      mutable.sessionConfiguration,
      broker instanceof SandboxExecutionBroker ? broker : undefined,
      session.services.runtimeOptions?.simpleMode ?? false,
    );
    daemonTuiSandboxAuthorities.set(session, sandboxAuthority);
  }
  const broker = sandboxAuthority.broker;
  const dangerouslyBypassApprovalsAndSandbox =
    session.services.runtimeOptions?.dangerouslyBypassApprovalsAndSandbox ===
    true;
  const nextMode = dangerouslyBypassApprovalsAndSandbox
    ? "danger_full_access"
    : sandboxAuthority.configuredMode;
  const previousContext = registry.current();
  const previousHooksDisabled = sandboxAuthority.hooksDisabled;
  const hooksRuntime = (
    session.services as typeof session.services & {
      readonly hooksRuntime?: { setDisabled(disabled: boolean): void };
    }
  ).hooksRuntime;
  const nextConfiguration = daemonTuiSessionConfiguration(
    mutable.sessionConfiguration,
    settings,
    sandboxAuthority,
    permissionContext.mode === "bypassPermissions",
    dangerouslyBypassApprovalsAndSandbox,
  );
  const commit = async (): Promise<void> => {
    replaceDaemonTuiSessionConfiguration(
      mutable.sessionConfiguration,
      nextConfiguration,
    );
    hooksRuntime?.setDisabled(settings.hooksDisabled);
    await updateRegistry(permissionContext);
    sandboxAuthority.hooksDisabled = settings.hooksDisabled;
  };
  const rollback = async (): Promise<void> => {
    const rollbackErrors: unknown[] = [];
    try {
      replaceDaemonTuiSessionConfiguration(
        mutable.sessionConfiguration,
        previousConfiguration,
      );
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      hooksRuntime?.setDisabled(previousHooksDisabled);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      await updateRegistry(previousContext);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    sandboxAuthority.hooksDisabled = previousHooksDisabled;
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        rollbackErrors,
        "daemon TUI runtime settings rollback was incomplete",
      );
    }
  };

  if (broker !== undefined) {
    await transitionSandboxExecutionBrokerMode(broker, nextMode, {
      commit,
      rollback,
    });
    return;
  }
  try {
    await commit();
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "daemon TUI runtime settings failed and rollback was incomplete",
        { cause: error },
      );
    }
    throw error;
  }
}

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

interface DaemonOnlyTuiCleanupResources {
  readonly watcherStarted: boolean;
  readonly skillsWatcher: ReturnType<
    typeof createLocalSkillsServices
  >["skillsWatcher"];
  readonly sandboxExecutionBroker?: SandboxExecutionBroker;
}

async function closeDaemonOnlyTuiResources(
  resources: DaemonOnlyTuiCleanupResources,
): Promise<void> {
  const startCleanup = (
    operation: () => void | Promise<void>,
  ): Promise<void> => {
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const skillsWatcherStop = startCleanup(() =>
    resources.watcherStarted
      ? (resources.skillsWatcher.stop?.() ?? Promise.resolve())
      : Promise.resolve(),
  );
  const sandboxDispose = startCleanup(() =>
    resources.sandboxExecutionBroker !== undefined
      ? disposeSandboxExecutionBroker(resources.sandboxExecutionBroker)
      : Promise.resolve(),
  );
  const failures = (
    await Promise.allSettled([skillsWatcherStop, sandboxDispose])
  ).flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "daemon-only TUI context cleanup failed",
    );
  }
}

async function createBoundAgenCDaemonOnlyTuiContext(
  options: AgenCDaemonOnlyTuiContextOptions,
  env: NodeJS.ProcessEnv,
  runtimeOptions: AgentRuntimeOptions,
): Promise<AgenCDaemonOnlyTuiContext> {
  const providerEnvironment = snapshotProviderEnvironment(env);
  const runtimeSettings = options.runtimeSettings;
  const roleWorkspace = options.roleWorkspace
    ? normalizeAgentRoleWorkspace(options.roleWorkspace)
    : createAgentRoleWorkspace(options.cwd);
  const agencHome = resolveAgencHome(env);
  const configEnv = { ...env };
  if (runtimeSettings !== undefined) delete configEnv.AGENC_PROFILE;
  const selectedProfile =
    runtimeSettings !== undefined ? runtimeSettings.profile : options.profile;
  const cli: StartupCliFlags = Object.freeze({
    ...(runtimeSettings !== undefined
      ? { provider: runtimeSettings.provider, model: runtimeSettings.model }
      : {
          ...(options.provider !== undefined
            ? { provider: options.provider }
            : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
        }),
    ...(selectedProfile !== undefined && selectedProfile !== null
      ? { profile: selectedProfile }
      : {}),
    ...(options.configPath !== undefined
      ? { configPath: options.configPath }
      : {}),
  });
  const configStore = new ConfigStore({
    home: agencHome,
    env: configEnv,
    cwd: roleWorkspace.cwd,
    ...startupConfigLayerOptions({
      cli,
      cwd: roleWorkspace.cwd,
    }),
    onWarn: (message) => process.stderr.write(`${message}\n`),
  });
  const effectiveConfig = await configStore.reload();
  const profileName = resolvedStartupProfileName(cli, configEnv);
  const startup = resolveCanonicalStartupSelection({
    config: effectiveConfig,
    ...(profileName !== undefined ? { profileName } : {}),
  });
  const skillsServices = createLocalSkillsServices({
    agencHome,
    pluginStorageRoot: runtimeOptions.pluginStorageRoot,
    workspaceRoot: roleWorkspace.cwd,
    config: effectiveConfig,
    env: {
      HOME: env.HOME,
      AGENC_MANAGED_HOME: env.AGENC_MANAGED_HOME,
    },
  });
  let watcherStarted = false;
  let sandboxExecutionBroker: SandboxExecutionBroker | undefined;
  try {
    await skillsServices.skillsWatcher.start();
    watcherStarted = true;
    const permissionContext = daemonTuiPermissionContext(
      options.cwd,
      runtimeSettings,
      options.permissionMode,
    );
    const selectedProvider = runtimeSettings?.provider ?? startup.provider;
    const selectedModel = runtimeSettings?.model ?? startup.model;
    const configuredSessionConfiguration: DaemonTuiSessionConfiguration = {
      ...sessionConfigurationFromAgenCConfig({
        config: effectiveConfig,
        workspaceRoot: options.cwd,
        provider: selectedProvider,
        model: selectedModel,
      }),
      // The bridge exposes provider identity, not an in-process LLMProvider.
      provider: { slug: selectedProvider },
    };
    const configuredSandboxMode =
      configuredSessionConfiguration.sandboxPolicy.value;
    sandboxExecutionBroker = new SandboxExecutionBroker({
      mode: runtimeOptions.dangerouslyBypassApprovalsAndSandbox
        ? "danger_full_access"
        : configuredSandboxMode,
      // Role authority remains anchored to the canonical checkout, while
      // execution policy must follow the attached worktree/session cwd.
      cwd: options.cwd,
      env,
      sessionTempRoot: runtimeOptions.sessionTempRoot,
      allowGpu: effectiveConfig.sandbox?.allow_gpu === true,
    });
    const activeSandboxExecutionBroker = sandboxExecutionBroker;
    const agentDefinitions = await loadFreshAgentDefinitions(
      roleWorkspace.cwd,
      runtimeOptions.pluginStorageRoot,
    );
    const abortController = new AbortController();
    let nextEventId = 0;
    const sandboxAuthority = captureDaemonTuiSandboxAuthority(
      configuredSessionConfiguration,
      activeSandboxExecutionBroker,
      runtimeSettings?.hooksDisabled ?? runtimeOptions.simpleMode,
    );
    const sessionConfiguration = daemonTuiSessionConfiguration(
      configuredSessionConfiguration,
      runtimeSettings,
      sandboxAuthority,
      permissionContext.mode === "bypassPermissions",
      runtimeOptions.dangerouslyBypassApprovalsAndSandbox,
    );
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
          permissionContext,
        ),
        configStore,
        sandboxExecutionBroker: activeSandboxExecutionBroker,
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
    };
    daemonTuiSandboxAuthorities.set(session, sandboxAuthority);
    return {
      baseSession: session,
      model: selectedModel,
      workspaceRoot: options.cwd,
      close: () =>
        closeDaemonOnlyTuiResources({
          watcherStarted,
          skillsWatcher: skillsServices.skillsWatcher,
          sandboxExecutionBroker: activeSandboxExecutionBroker,
        }),
    };
  } catch (error) {
    try {
      await closeDaemonOnlyTuiResources({
        watcherStarted,
        skillsWatcher: skillsServices.skillsWatcher,
        ...(sandboxExecutionBroker !== undefined
          ? { sandboxExecutionBroker }
          : {}),
      });
    } catch (cleanupError) {
      throw new AggregateError(
        [
          error,
          ...(cleanupError instanceof AggregateError
            ? cleanupError.errors
            : [cleanupError]),
        ],
        "daemon-only TUI context setup failed and cleanup was incomplete",
        { cause: error },
      );
    }
    throw error;
  }
}
