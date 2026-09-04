/**
 * Durable runtime settings, permission authority coordination and restore
 * overrides for background agents. Split out of background-agent-runner.ts
 * as a pure move.
 */

import { randomUUID } from "node:crypto";
import type {
  LocalRuntimeBootstrap,
  PreparedConfiguredExecutionAuthority,
} from "../../bin/bootstrap.js";
import {
  buildStructuredSessionBootstrapArgv,
} from "../session-bootstrap-argv.js";
import { stableStringify } from "../../utils/stableStringify.js";
import { runWithCurrentRuntimeSession } from "../../session/current-session.js";
import {
  transitionPermissionMode,
  type PermissionContextPublication,
  type PermissionModeRegistry,
} from "../../permissions/permission-mode.js";
import {
  authorizeBypassPermissionsConsent,
  canonicalizeBypassPermissionsCwd,
  loadBypassPermissionsConsent,
} from "../../permissions/bypass-consent-state.js";
import type { ToolPermissionContext } from "../../permissions/types.js";
import {
  readSessionSelection,
  resolveProviderModelSelection,
} from "../../session/provider-model-selection.js";
import {
  mergeProviderModelLayer,
} from "../../config/provider-model-authority.js";
import type { AgenCConfig } from "../../config/schema.js";
import {
  COORDINATED_CONFIG_STORE_PUBLICATION,
  type PreparedConfigStoreReload,
} from "../../config/store.js";
import type { McpRefreshResult } from "../../session/mcp-startup.js";
import {
  applyUnattendedPermissionPolicyToContext,
} from "../../permissions/unattended-policy.js";
import type { Session } from "../../session/session.js";
import type { Event } from "../../session/event-log.js";
import { isRecord } from "../../utils/record.js";
import {
  RUN_RUNTIME_MODEL_VERBOSITIES,
  RUN_RUNTIME_PERMISSION_MODES,
  RUN_RUNTIME_REASONING_EFFORTS,
  RUN_RUNTIME_SERVICE_TIERS,
  RUN_RUNTIME_SETTINGS_CHANGE_REASONS,
  type RunRuntimeSettingsChangeReason,
  type RunRuntimeSettingsSnapshot,
} from "../../contracts/run-contracts.js";
import {
  cloneFrozenRuntimeSettingsSnapshot,
} from "../../state/runtime-settings-snapshot.js";
import {
  applySessionExecutionAuthority,
  executionAuthorityForPermissionContext,
  sandboxExecutionBrokerAuthorityFromSessionAuthority,
} from "../../session/configuration.js";
import { SandboxExecutionBroker } from "../../sandbox/execution-broker.js";
import {
  transitionSandboxExecutionBrokerAuthority,
} from "../../sandbox/execution-lifecycle.js";

import { positiveSequence, canonicalEventId } from "./shared.js";
import type {
  AgenCBackgroundAgentRestoreParams,
  AgenCBackgroundAgentSetHooksDisabledResult,
  ActiveBackgroundAgent,
} from "./shared.js";
import { currentRunEpochFromRollout } from "./journal-reconstruction.js";

function configuredHookExecutionState(runtime: {
  isDisabled(): boolean;
  isHardSuppressed(): boolean;
  isExecutionSuppressed(): boolean;
}): Omit<AgenCBackgroundAgentSetHooksDisabledResult, "applied"> {
  const disabled = runtime.isDisabled();
  const hardSuppressed = runtime.isHardSuppressed();
  return {
    disabled,
    hardSuppressed,
    effectiveDisabled: runtime.isExecutionSuppressed(),
    suppressionReason: hardSuppressed
      ? "bare_mode"
      : disabled
        ? "session_disabled"
        : null,
  };
}

interface CapturedRuntimeSettingsOptions {
  readonly profile?: string;
  readonly permissionContext?: ToolPermissionContext;
}

function runtimeWorkspaceRoot(bootstrap: LocalRuntimeBootstrap): string {
  const broker = bootstrap.session.services.sandboxExecutionBroker;
  if (!(broker instanceof SandboxExecutionBroker)) {
    throw new Error(
      "canonical runtime settings require the live sandbox execution broker cwd",
    );
  }
  const cwd = broker.cwd;
  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    throw new Error("live sandbox execution broker cwd is unavailable");
  }
  return canonicalizeBypassPermissionsCwd(cwd);
}

function supportsCanonicalRuntimeSettings(
  active: ActiveBackgroundAgent,
): boolean {
  return (
    typeof active.bootstrap.session.permissionModeRegistry
      .installBeforeUpdateHook === "function" &&
    typeof active.bootstrap.session.permissionModeRegistry
      .installPublicationCoordinator === "function" &&
    active.bootstrap.session.services.sandboxExecutionBroker instanceof
      SandboxExecutionBroker &&
    active.bootstrap.configuredExecutionAuthority !== undefined &&
    typeof active.bootstrap.prepareConfiguredExecutionAuthority ===
      "function" &&
    typeof active.bootstrap.rolloutStore.recordRunRuntimeSettingsEvent ===
      "function"
  );
}

function requireCanonicalRuntimeSettingsSupport(
  active: ActiveBackgroundAgent,
  runId: string,
): void {
  if (!supportsCanonicalRuntimeSettings(active)) {
    throw new Error(
      `run ${runId} requires a canonical permission registry and durable runtime-settings journal`,
    );
  }
}

function failClosedDaemonRuntimeAuthority(
  active: ActiveBackgroundAgent,
  error: unknown,
  options: {
    readonly brokerReason: string;
    readonly abortReason: Parameters<Session["abortTerminal"]>[0];
    readonly abortFailureMessage: string;
  },
): never {
  const session = active.bootstrap.session;
  const broker = session.services.sandboxExecutionBroker;
  if (broker instanceof SandboxExecutionBroker) {
    broker.closeAfterLifecycleAuthorityFailure(options.brokerReason);
  }
  active.ingressClosed = true;
  try {
    session.abortTerminal(options.abortReason);
  } catch (abortError) {
    throw new AggregateError([error, abortError], options.abortFailureMessage, {
      cause: error,
    });
  }
  throw error;
}

function installDaemonPermissionAuthorityCoordinator(
  bootstrap: LocalRuntimeBootstrap,
  owner: () => ActiveBackgroundAgent | undefined,
): () => void {
  const session = bootstrap.session;
  const registry = session.permissionModeRegistry;
  const broker = session.services.sandboxExecutionBroker;
  if (!(broker instanceof SandboxExecutionBroker)) {
    throw new Error(
      "daemon session requires the canonical sandbox execution broker",
    );
  }
  if (
    bootstrap.configuredExecutionAuthority === undefined ||
    typeof bootstrap.prepareConfiguredExecutionAuthority !== "function"
  ) {
    throw new Error(
      "daemon session requires a configured execution-authority snapshot",
    );
  }

  return registry.installPublicationCoordinator(
    async (
      next,
      _current,
      metadata,
      publication: PermissionContextPublication,
    ) => {
      const stagedConfiguredAuthority =
        configuredExecutionAuthorityFromPublicationMetadata(metadata);
      const preparedConfigReload =
        preparedConfigStoreReloadFromPublicationMetadata(metadata);
      const preparedMcpAuthorityRefresh =
        preparedMcpAuthorityRefreshFromPublicationMetadata(metadata);
      const authority = executionAuthorityForPermissionContext(
        stagedConfiguredAuthority?.authority ??
          bootstrap.configuredExecutionAuthority,
        next,
        session.services.runtimeOptions
          ?.dangerouslyBypassApprovalsAndSandbox === true,
      );
      let previousConfiguration: Session["sessionConfiguration"] | undefined;
      let configurationWriteStarted = false;
      let stagedConfiguredAuthorityCommitted = false;
      let preparedConfigReloadCommitted = false;
      let preparedMcpAuthorityRefreshStarted = false;
      let authorityTransitionCompleted = false;
      try {
        await transitionSandboxExecutionBrokerAuthority(
          broker,
          sandboxExecutionBrokerAuthorityFromSessionAuthority(
            authority,
            broker.cwd,
          ),
          {
            commit: async () => {
              configurationWriteStarted = true;
              await session.state.with((state) => {
                previousConfiguration = state.sessionConfiguration;
                state.sessionConfiguration = applySessionExecutionAuthority(
                  state.sessionConfiguration,
                  authority,
                );
              });
              preparedConfigReload?.commit();
              preparedConfigReloadCommitted =
                preparedConfigReload !== undefined;
              stagedConfiguredAuthority?.commit();
              stagedConfiguredAuthorityCommitted =
                stagedConfiguredAuthority !== undefined;
              await publication.commit();
              preparedConfigReload?.publish(
                COORDINATED_CONFIG_STORE_PUBLICATION,
              );
              preparedMcpAuthorityRefreshStarted =
                preparedMcpAuthorityRefresh !== undefined;
              preparedMcpAuthorityRefresh?.start();
              await preparedMcpAuthorityRefresh?.waitUntilDeferred();
            },
            rollback: async () => {
              const rollbackErrors: unknown[] = [];
              try {
                await publication.rollback();
              } catch (error) {
                rollbackErrors.push(error);
              }
              if (stagedConfiguredAuthorityCommitted) {
                try {
                  stagedConfiguredAuthority?.rollback();
                  stagedConfiguredAuthorityCommitted = false;
                } catch (error) {
                  rollbackErrors.push(error);
                }
              }
              if (preparedConfigReloadCommitted) {
                try {
                  preparedConfigReload?.rollback();
                  preparedConfigReloadCommitted = false;
                } catch (error) {
                  rollbackErrors.push(error);
                }
              }
              if (
                configurationWriteStarted &&
                previousConfiguration !== undefined
              ) {
                try {
                  await session.state.with((state) => {
                    state.sessionConfiguration = previousConfiguration!;
                  });
                } catch (error) {
                  rollbackErrors.push(error);
                }
              }
              if (rollbackErrors.length > 0) {
                throw new AggregateError(
                  rollbackErrors,
                  "daemon permission authority rollback incomplete",
                );
              }
            },
          },
        );
        authorityTransitionCompleted = true;
        await preparedMcpAuthorityRefresh?.settle();
        preparedConfigReload?.settle();
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        if (!authorityTransitionCompleted) {
          try {
            await publication.rollback();
          } catch (rollbackError) {
            cleanupErrors.push(rollbackError);
          }
          if (
            preparedConfigReload !== undefined &&
            !preparedConfigReload.settled
          ) {
            if (preparedConfigReload.state !== "rolled_back") {
              try {
                preparedConfigReload.rollback();
              } catch (rollbackError) {
                cleanupErrors.push(rollbackError);
              }
            }
            try {
              preparedConfigReload.settle();
            } catch (settleError) {
              cleanupErrors.push(settleError);
            }
          }
        } else {
          if (
            preparedConfigReload !== undefined &&
            !preparedConfigReload.settled
          ) {
            try {
              preparedConfigReload.settle();
            } catch (settleError) {
              cleanupErrors.push(settleError);
            }
          }
          if (!broker.isClosedAfterLifecycleAuthorityFailure()) {
            broker.closeAfterLifecycleAuthorityFailure(
              "daemon permission authority failed after canonical publication",
            );
          }
        }
        const failure =
          cleanupErrors.length === 0
            ? error
            : new AggregateError(
                [error, ...cleanupErrors],
                "daemon permission authority cleanup was incomplete",
                { cause: error },
              );
        if (
          (cleanupErrors.length > 0 || preparedMcpAuthorityRefreshStarted) &&
          !broker.isClosedAfterLifecycleAuthorityFailure()
        ) {
          broker.closeAfterLifecycleAuthorityFailure(
            preparedMcpAuthorityRefreshStarted
              ? "daemon permission authority failed after canonical publication"
              : "daemon permission authority cleanup was incomplete",
          );
        }
        if (!broker.isClosedAfterLifecycleAuthorityFailure()) {
          if (
            failure instanceof AggregateError &&
            failure.errors.length === 1
          ) {
            throw failure.errors[0];
          }
          throw failure;
        }
        const active = owner();
        if (active !== undefined) active.ingressClosed = true;
        const terminalFailure =
          failure instanceof AggregateError && failure.errors.length === 1
            ? failure.errors[0]
            : failure;
        try {
          session.abortTerminal("permission_authority_failure");
        } catch (abortError) {
          throw new AggregateError(
            [terminalFailure, abortError],
            "daemon permission authority failed and session abort was incomplete",
            { cause: terminalFailure },
          );
        }
        throw terminalFailure;
      }
    },
  );
}

function preparedConfigStoreReloadFromPublicationMetadata(
  metadata: unknown,
): PreparedConfigStoreReload | undefined {
  if (!isRecord(metadata)) return undefined;
  const prepared = metadata.preparedConfigReload;
  if (!isRecord(prepared)) return undefined;
  if (
    !isRecord(prepared.authority) ||
    typeof prepared.commit !== "function" ||
    typeof prepared.publish !== "function" ||
    typeof prepared.rollback !== "function" ||
    typeof prepared.settle !== "function"
  ) {
    throw new Error("prepared config reload publication metadata is invalid");
  }
  return prepared as unknown as PreparedConfigStoreReload;
}

interface PreparedMcpAuthorityRefresh {
  readonly result: McpRefreshResult | undefined;
  start(): void;
  waitUntilDeferred(): Promise<void>;
  settle(): Promise<void>;
}

function prepareMcpAuthorityRefresh(
  session: Session,
): PreparedMcpAuthorityRefresh | undefined {
  const manager = session.services.mcpManager;
  const refresh = manager?.refreshFromAuthority;
  if (manager === undefined || refresh === undefined) return undefined;
  let task: Promise<McpRefreshResult> | undefined;
  let result: McpRefreshResult | undefined;
  let deferred = false;
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined);
  const markDeferred = (): void => {
    if (readySettled) return;
    deferred = true;
    readySettled = true;
    resolveReady();
  };
  const failReady = (error: unknown): void => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(error);
  };
  return Object.freeze({
    get result() {
      return result;
    },
    start: () => {
      if (task !== undefined) {
        throw new Error("MCP authority refresh was started more than once");
      }
      try {
        task = Promise.resolve(
          refresh.call(manager, {
            onSandboxRefreshDeferred: markDeferred,
          }),
        );
      } catch (error) {
        task = Promise.reject(error);
      }
      void task.then(() => {
        if (!deferred) {
          failReady(
            new Error(
              "MCP authority refresh completed before sandbox deferral was proven",
            ),
          );
        }
      }, failReady);
      void task.catch(() => undefined);
    },
    waitUntilDeferred: () => ready,
    settle: async () => {
      if (task === undefined) {
        throw new Error("MCP authority refresh was not started");
      }
      result = await task;
    },
  });
}

function preparedMcpAuthorityRefreshFromPublicationMetadata(
  metadata: unknown,
): PreparedMcpAuthorityRefresh | undefined {
  if (!isRecord(metadata)) return undefined;
  const prepared = metadata.preparedMcpAuthorityRefresh;
  if (!isRecord(prepared)) return undefined;
  if (
    typeof prepared.start !== "function" ||
    typeof prepared.waitUntilDeferred !== "function" ||
    typeof prepared.settle !== "function"
  ) {
    throw new Error("prepared MCP refresh publication metadata is invalid");
  }
  return prepared as unknown as PreparedMcpAuthorityRefresh;
}

function configuredExecutionAuthorityFromPublicationMetadata(
  metadata: unknown,
): PreparedConfiguredExecutionAuthority | undefined {
  if (!isRecord(metadata)) return undefined;
  const prepared = metadata.configuredExecutionAuthority;
  if (!isRecord(prepared)) return undefined;
  if (
    !isRecord(prepared.authority) ||
    typeof prepared.commit !== "function" ||
    typeof prepared.rollback !== "function"
  ) {
    throw new Error(
      "configured execution authority publication metadata is invalid",
    );
  }
  return prepared as unknown as PreparedConfiguredExecutionAuthority;
}

function captureRuntimeSettings(
  active: ActiveBackgroundAgent,
  options: CapturedRuntimeSettingsOptions = {},
): RunRuntimeSettingsSnapshot {
  const { bootstrap } = active;
  const session = bootstrap.session;
  const workspaceRoot = runtimeWorkspaceRoot(bootstrap);
  const permission =
    options.permissionContext ?? session.permissionModeRegistry.current();
  if (permission.mode === "bubble") {
    throw new Error("root daemon runtime settings cannot persist bubble mode");
  }
  const prePlanMode =
    permission.mode === "plan"
      ? permission.prePlanMode === undefined ||
        permission.prePlanMode === "bubble"
        ? "default"
        : permission.prePlanMode
      : null;
  const bypassTransitionCritical =
    permission.mode === "bypassPermissions" ||
    prePlanMode === "bypassPermissions";
  const hasSessionExactBypassConsent =
    permission.bypassPermissionsAcceptedIn?.includes(workspaceRoot) === true;
  if (bypassTransitionCritical && !hasSessionExactBypassConsent) {
    throw new Error(
      `cannot persist bypass permission authority without exact workspace consent: ${workspaceRoot}`,
    );
  }
  let hasDurableExactBypassConsent = false;
  try {
    hasDurableExactBypassConsent =
      loadBypassPermissionsConsent(
        bootstrap.configStore.stateRepository,
        workspaceRoot,
        { reload: true },
      )[0] === workspaceRoot;
  } catch {
    // A failed state refresh cannot add authority. Session authority remains
    // usable for an already-active transition, but is not widened here.
  }
  const bypassDisabledByPolicy =
    permission.bypassPermissionsModeDisabledByPolicy === true;
  const hasExactBypassConsent =
    !bypassDisabledByPolicy &&
    (hasSessionExactBypassConsent || hasDurableExactBypassConsent);
  const bypassPermissionsModeAvailable =
    !bypassDisabledByPolicy &&
    (permission.isBypassPermissionsModeAvailable === true ||
      hasExactBypassConsent);

  const pending = session.pendingProviderSwitch;
  const selection = readSessionSelection(session, { includePending: true });
  const configuration = (
    session as Session & {
      readonly sessionConfiguration?: Session["sessionConfiguration"];
    }
  ).sessionConfiguration;
  const reasoningEffort = normalizeRuntimeSetting(
    configuration?.collaborationMode.reasoningEffort,
    RUN_RUNTIME_REASONING_EFFORTS,
    "reasoning effort",
  );
  const modelVerbosity = normalizeRuntimeSetting(
    configuration?.modelVerbosity,
    RUN_RUNTIME_MODEL_VERBOSITIES,
    "model verbosity",
  );
  const serviceTier = normalizeRuntimeSetting(
    configuration?.serviceTier,
    RUN_RUNTIME_SERVICE_TIERS,
    "service tier",
  );
  return cloneFrozenRuntimeSettingsSnapshot({
    permissionMode: permission.mode,
    prePlanMode,
    autoModeActive: permission.autoModeActive === true,
    autoModeAvailable: permission.isAutoModeAvailable === true,
    bypassPermissionsModeAvailable,
    bypassPermissionsWorkspace: bypassTransitionCritical ? workspaceRoot : null,
    bypassPermissionsConsentWorkspace: hasExactBypassConsent
      ? workspaceRoot
      : null,
    model: selection.model,
    provider: selection.provider,
    profile:
      options.profile ??
      pending?.profile ??
      active.runtimeSettings?.profile ??
      null,
    reasoningEffort,
    modelVerbosity,
    serviceTier,
    hooksDisabled: session.services?.hooksRuntime?.isDisabled() === true,
  });
}

function normalizeRuntimeSetting<const T extends readonly string[]>(
  value: unknown,
  accepted: T,
  label: string,
): T[number] | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    !(accepted as readonly string[]).includes(value)
  ) {
    throw new Error(`cannot persist unsupported ${label}: ${String(value)}`);
  }
  return value as T[number];
}

function installRuntimeSettingsPreCommit(
  active: ActiveBackgroundAgent,
  runId: string,
): () => void {
  const registry = active.bootstrap.session.permissionModeRegistry;
  requireCanonicalRuntimeSettingsSupport(active, runId);
  return registry.installBeforeUpdateHook(async (next, current, metadata) => {
    const release = await acquireRuntimeSettingsMutation(active);
    try {
      if (active.ingressClosed === true) {
        throw new Error(`run ${runId} permission ingress is closed`);
      }
      if (active.runtimeSettingsEventId === undefined) {
        const baseline = captureRuntimeSettings(active, {
          permissionContext: current,
        });
        commitDurableRuntimeSettingsChange(active, runId, baseline, "initial");
      }
      const previousSettings = active.runtimeSettings!;
      const nextSettings = captureRuntimeSettings(active, {
        permissionContext: next,
      });
      if (
        active.runtimeSettings !== undefined &&
        stableStringify(active.runtimeSettings) ===
          stableStringify(nextSettings)
      ) {
        release();
        return undefined;
      }
      const prepared = prepareDurableRuntimeSettingsChange(
        active,
        runId,
        nextSettings,
        runtimeSettingsCommitMetadata(metadata)?.reason ??
          "permission_mode_changed",
        runtimeSettingsCommitMetadata(metadata)?.rollbackOfSettingsEventId ??
          null,
      );
      return {
        commit: () => {
          prepared.finalize();
        },
        rollback: () => {
          if (active.runtimeSettingsEventId === prepared.eventId) {
            compensateRuntimeSettingsChange(
              active,
              runId,
              previousSettings,
              prepared.eventId,
            );
            return;
          }
          compensatePreparedRuntimeSettingsChange(
            active,
            runId,
            previousSettings,
            prepared,
          );
        },
        settle: release,
      };
    } catch (error) {
      release();
      throw error;
    }
  });
}

function runtimeSettingsCommitMetadata(metadata: unknown):
  | {
      readonly reason: RunRuntimeSettingsChangeReason;
      readonly rollbackOfSettingsEventId: string | null;
    }
  | undefined {
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    !("runtimeSettings" in metadata)
  ) {
    return undefined;
  }
  const value = (metadata as { readonly runtimeSettings?: unknown })
    .runtimeSettings;
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as {
    readonly reason?: unknown;
    readonly rollbackOfSettingsEventId?: unknown;
  };
  if (
    typeof candidate.reason !== "string" ||
    !RUN_RUNTIME_SETTINGS_CHANGE_REASONS.includes(candidate.reason as never) ||
    (candidate.rollbackOfSettingsEventId !== null &&
      typeof candidate.rollbackOfSettingsEventId !== "string")
  ) {
    throw new Error("invalid permission runtime-settings commit metadata");
  }
  return {
    reason: candidate.reason as RunRuntimeSettingsChangeReason,
    rollbackOfSettingsEventId: candidate.rollbackOfSettingsEventId,
  };
}

async function withRuntimeSettingsMutation<T>(
  active: ActiveBackgroundAgent,
  mutate: () => Promise<T>,
): Promise<T> {
  const result = active.runtimeSettingsMutationQueue.then(mutate);
  active.runtimeSettingsMutationQueue = result.then(
    () => {},
    () => {},
  );
  return result;
}

async function acquireRuntimeSettingsMutation(
  active: ActiveBackgroundAgent,
): Promise<() => void> {
  const previous = active.runtimeSettingsMutationQueue;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = previous.then(
    () => {},
    () => {},
  );
  active.runtimeSettingsMutationQueue = acquired.then(() => held);
  await acquired;
  return release;
}

function ensureInitialRuntimeSettings(
  active: ActiveBackgroundAgent,
  runId: string,
): RunRuntimeSettingsSnapshot {
  if (
    active.runtimeSettings !== undefined &&
    active.runtimeSettingsEventId !== undefined
  ) {
    return active.runtimeSettings;
  }
  const baseline = captureRuntimeSettings(active);
  commitDurableRuntimeSettingsChange(active, runId, baseline, "initial");
  return active.runtimeSettings!;
}

function failClosedRuntimeSettingsAuthority(
  active: ActiveBackgroundAgent,
  runId: string,
  error: unknown,
): never {
  return failClosedDaemonRuntimeAuthority(active, error, {
    brokerReason: "daemon runtime-settings authority is ambiguous",
    abortReason: "permission_authority_failure",
    abortFailureMessage: `run ${runId} runtime-settings authority failed and session abort was incomplete`,
  });
}

function compensateRuntimeSettingsChange(
  active: ActiveBackgroundAgent,
  runId: string,
  previous: RunRuntimeSettingsSnapshot,
  failedSettingsEventId: string,
): void {
  try {
    if (active.runtimeSettingsEventId !== failedSettingsEventId) {
      throw new Error(
        `run ${runId} settings compensation no longer follows ${failedSettingsEventId}`,
      );
    }
    commitDurableRuntimeSettingsChange(
      active,
      runId,
      previous,
      "compensating_rollback",
      failedSettingsEventId,
    );
  } catch (error) {
    failClosedRuntimeSettingsAuthority(active, runId, error);
  }
}

function compensatePreparedRuntimeSettingsChange(
  active: ActiveBackgroundAgent,
  runId: string,
  previous: RunRuntimeSettingsSnapshot,
  failed: PreparedRuntimeSettingsChange,
): void {
  try {
    if (active.runtimeSettingsEventId !== failed.previousSettingsEventId) {
      throw new Error(
        `run ${runId} settings compensation no longer follows ${failed.eventId}`,
      );
    }
    const compensation = prepareDurableRuntimeSettingsChange(
      active,
      runId,
      previous,
      "compensating_rollback",
      failed.eventId,
      failed.eventId,
    );
    projectDurableRuntimeSettingsEvent(active, failed.event);
    compensation.finalize();
  } catch (error) {
    projectDurableRuntimeSettingsEvent(active, failed.event);
    failClosedRuntimeSettingsAuthority(active, runId, error);
  }
}

async function applyRestoredRuntimeSettings(
  bootstrap: LocalRuntimeBootstrap,
  settings: RunRuntimeSettingsSnapshot,
): Promise<RunRuntimeSettingsSnapshot> {
  const workspaceRoot = canonicalizeBypassPermissionsCwd(
    runtimeWorkspaceRoot(bootstrap),
  );
  assertValidRuntimeSettingsSnapshot(settings, workspaceRoot);
  const bypassTransitionCritical =
    settings.permissionMode === "bypassPermissions" ||
    (settings.permissionMode === "plan" &&
      settings.prePlanMode === "bypassPermissions");
  if (
    (bypassTransitionCritical &&
      settings.bypassPermissionsWorkspace !== workspaceRoot) ||
    (!bypassTransitionCritical && settings.bypassPermissionsWorkspace !== null)
  ) {
    throw new Error(
      "canonical bypass permission workspace does not match restored workspace",
    );
  }
  const session = bootstrap.session;
  const registry = session.permissionModeRegistry;
  const current = registry.current();
  const bypassDisabledByPolicy =
    current.bypassPermissionsModeDisabledByPolicy === true;
  const [persistedBypassConsent] = loadBypassPermissionsConsent(
    bootstrap.configStore.stateRepository,
    workspaceRoot,
    { reload: true },
  );
  const hasCurrentDurableBypassConsent =
    persistedBypassConsent === workspaceRoot;
  const autoModeAvailable =
    settings.autoModeAvailable && current.isAutoModeAvailable === true;
  const retainedConsent =
    !bypassDisabledByPolicy &&
    settings.bypassPermissionsModeAvailable &&
    settings.bypassPermissionsConsentWorkspace === workspaceRoot &&
    hasCurrentDurableBypassConsent;
  const bypassModeAvailable =
    !bypassDisabledByPolicy &&
    (current.isBypassPermissionsModeAvailable === true || retainedConsent);
  let transitionContext: ToolPermissionContext = {
    ...current,
    isAutoModeAvailable: autoModeAvailable,
    isBypassPermissionsModeAvailable: bypassModeAvailable,
    bypassPermissionsAcceptedIn: retainedConsent ? [workspaceRoot] : [],
  };
  if (bypassTransitionCritical) {
    if (bypassDisabledByPolicy) {
      throw new Error(
        "restored bypass permission mode is disabled by managed policy",
      );
    }
    if (!hasCurrentDurableBypassConsent) {
      throw new Error(
        "restored bypass permission mode requires persisted exact-cwd consent",
      );
    }
    transitionContext = authorizeBypassPermissionsConsent(
      {
        ...transitionContext,
        isBypassPermissionsModeAvailable: false,
        bypassPermissionsAcceptedIn: [],
      },
      persistedBypassConsent,
    );
  }
  let transitioned = runWithCurrentRuntimeSession(session, () =>
    settings.permissionMode === "bypassPermissions"
      ? transitionPermissionMode(
          transitionContext.mode,
          settings.permissionMode,
          transitionContext,
          { workspacePath: workspaceRoot },
        )
      : transitionPermissionMode(
          transitionContext.mode,
          settings.permissionMode,
          transitionContext,
        ),
  );
  if ("error" in transitioned) {
    throw new Error(
      "restored bypass permission mode lacks exact canonical workspace consent",
    );
  }
  const bypassAccepted =
    bypassTransitionCritical || retainedConsent ? [workspaceRoot] : [];
  transitioned = {
    ...transitioned,
    mode: settings.permissionMode,
    ...(settings.permissionMode === "plan"
      ? { prePlanMode: settings.prePlanMode ?? "default" }
      : { prePlanMode: undefined }),
    autoModeActive: settings.autoModeActive,
    isAutoModeAvailable: autoModeAvailable,
    isBypassPermissionsModeAvailable: bypassModeAvailable,
    bypassPermissionsAcceptedIn: bypassAccepted,
  };
  await registry.update(transitioned);

  const liveSelection = readSessionSelection(session);
  if (
    liveSelection.provider !== settings.provider ||
    liveSelection.model !== settings.model ||
    settings.profile !== null
  ) {
    session.setPendingProviderSwitch({
      provider: settings.provider,
      model: settings.model,
      ...(settings.profile !== null ? { profile: settings.profile } : {}),
    });
  }
  await session.state.with((state) => {
    const configuration = state.sessionConfiguration;
    state.sessionConfiguration = {
      ...configuration,
      collaborationMode: {
        ...configuration.collaborationMode,
        ...(settings.reasoningEffort !== null
          ? { reasoningEffort: settings.reasoningEffort }
          : { reasoningEffort: undefined }),
      } as typeof configuration.collaborationMode,
      ...(settings.modelVerbosity !== null
        ? { modelVerbosity: settings.modelVerbosity }
        : { modelVerbosity: undefined }),
      ...(settings.serviceTier !== null
        ? { serviceTier: settings.serviceTier }
        : { serviceTier: undefined }),
    };
  });
  session.services?.hooksRuntime?.setDisabled(settings.hooksDisabled);
  return cloneFrozenRuntimeSettingsSnapshot({
    ...settings,
    autoModeAvailable,
    bypassPermissionsModeAvailable: bypassModeAvailable,
    bypassPermissionsConsentWorkspace: retainedConsent ? workspaceRoot : null,
  });
}

function currentCanonicalRuntimeStateFromRollout(
  bootstrap: LocalRuntimeBootstrap,
  runId: string,
): {
  readonly pendingStartupActivationResumeEventId?: string;
  readonly runtimeSettings?: RunRuntimeSettingsSnapshot;
  readonly runtimeSettingsEventId?: string;
} {
  const epoch = currentRunEpochFromRollout(bootstrap, runId);
  let pendingStartupActivationResumeEventId: string | undefined;
  let runtimeSettings: RunRuntimeSettingsSnapshot | undefined;
  let runtimeSettingsEventId: string | undefined;
  for (const item of bootstrap.rolloutStore.readAll()) {
    if (item.type !== "event_msg") continue;
    const event = item.payload;
    const payload = event.msg.payload as { runId?: unknown; epoch?: unknown };
    if (payload.runId !== runId) continue;
    if (
      event.msg.type === "run_runtime_settings_changed" &&
      typeof payload.epoch === "number" &&
      payload.epoch <= epoch
    ) {
      runtimeSettings = runtimeSettingsSnapshotFromCanonicalEvent(event);
      runtimeSettingsEventId = canonicalEventId(event);
    }
    if (payload.epoch !== epoch) continue;
    if (event.msg.type === "run_resumed") {
      pendingStartupActivationResumeEventId = canonicalEventId(event);
    } else if (event.msg.type === "run_startup_activated") {
      if (
        event.msg.payload.resumeEventId ===
        pendingStartupActivationResumeEventId
      ) {
        pendingStartupActivationResumeEventId = undefined;
      }
    } else if (
      event.msg.type === "run_suspended" ||
      event.msg.type === "run_terminal"
    ) {
      pendingStartupActivationResumeEventId = undefined;
    }
  }
  return {
    ...(pendingStartupActivationResumeEventId !== undefined
      ? { pendingStartupActivationResumeEventId }
      : {}),
    ...(runtimeSettings !== undefined ? { runtimeSettings } : {}),
    ...(runtimeSettingsEventId !== undefined ? { runtimeSettingsEventId } : {}),
  };
}

function runtimeSettingsSnapshotFromCanonicalEvent(
  event: Event,
): RunRuntimeSettingsSnapshot {
  if (event.msg.type !== "run_runtime_settings_changed") {
    throw new Error("expected canonical runtime settings event");
  }
  const payload = event.msg.payload;
  return cloneFrozenRuntimeSettingsSnapshot({
    permissionMode: payload.permissionMode,
    prePlanMode: payload.prePlanMode,
    autoModeActive: payload.autoModeActive,
    autoModeAvailable: payload.autoModeAvailable,
    bypassPermissionsModeAvailable: payload.bypassPermissionsModeAvailable,
    bypassPermissionsWorkspace: payload.bypassPermissionsWorkspace,
    bypassPermissionsConsentWorkspace:
      payload.bypassPermissionsConsentWorkspace,
    model: payload.model,
    provider: payload.provider,
    profile: payload.profile,
    reasoningEffort: payload.reasoningEffort,
    modelVerbosity: payload.modelVerbosity,
    serviceTier: payload.serviceTier,
    hooksDisabled: payload.hooksDisabled,
  });
}

function commitDurableRuntimeSettingsChange(
  active: ActiveBackgroundAgent,
  runId: string,
  settings: RunRuntimeSettingsSnapshot,
  reason: RunRuntimeSettingsChangeReason,
  rollbackOfSettingsEventId: string | null = null,
): void {
  prepareDurableRuntimeSettingsChange(
    active,
    runId,
    settings,
    reason,
    rollbackOfSettingsEventId,
  ).finalize();
}

interface PreparedRuntimeSettingsChange {
  readonly event: Event;
  readonly eventId: string;
  readonly previousSettingsEventId: string | null;
  finalize(): void;
}

function prepareDurableRuntimeSettingsChange(
  active: ActiveBackgroundAgent,
  runId: string,
  settings: RunRuntimeSettingsSnapshot,
  reason: RunRuntimeSettingsChangeReason,
  rollbackOfSettingsEventId: string | null = null,
  preparedPredecessorEventId?: string,
): PreparedRuntimeSettingsChange {
  if (!supportsCanonicalRuntimeSettings(active)) {
    throw new Error(
      `run ${runId} cannot change runtime settings without canonical journal support`,
    );
  }
  const canonicalSettings = cloneFrozenRuntimeSettingsSnapshot(settings);
  assertValidRuntimeSettingsSnapshot(
    canonicalSettings,
    runtimeWorkspaceRoot(active.bootstrap),
  );
  const epoch = active.runEpoch;
  const previousSettingsEventId =
    preparedPredecessorEventId ?? active.runtimeSettingsEventId ?? null;
  if (
    preparedPredecessorEventId !== undefined &&
    (reason !== "compensating_rollback" ||
      rollbackOfSettingsEventId !== preparedPredecessorEventId)
  ) {
    throw new Error(
      `run ${runId} prepared predecessor is only valid for its compensation`,
    );
  }
  if (previousSettingsEventId === null && reason !== "initial") {
    throw new Error(
      `run ${runId} must establish initial runtime settings before ${reason}`,
    );
  }
  if (previousSettingsEventId !== null && reason === "initial") {
    throw new Error(`run ${runId} already has initial runtime settings`);
  }
  const eventId = `run-runtime-settings:${runId}:${epoch}:${randomUUID()}`;
  const changedAt = new Date().toISOString();
  const acceptCommitted = (proveDurable: boolean): Event | undefined => {
    const matches = active.bootstrap.rolloutStore
      .readAll()
      .flatMap((item) =>
        item.type === "event_msg" &&
        (item.payload.eventId === eventId || item.payload.id === eventId)
          ? [item.payload]
          : [],
      );
    if (matches.length === 0) return undefined;
    if (matches.length !== 1) {
      throw new Error(`runtime settings ${eventId} has duplicate evidence`);
    }
    const event = matches[0]!;
    if (
      event.id !== eventId ||
      event.eventId !== eventId ||
      positiveSequence(event.seq) === undefined ||
      event.msg.type !== "run_runtime_settings_changed" ||
      event.msg.payload.runId !== runId ||
      event.msg.payload.epoch !== epoch ||
      event.msg.payload.previousSettingsEventId !== previousSettingsEventId ||
      event.msg.payload.rollbackOfSettingsEventId !==
        rollbackOfSettingsEventId ||
      event.msg.payload.reason !== reason ||
      event.msg.payload.changedAt !== changedAt ||
      stableStringify(runtimeSettingsSnapshotFromCanonicalEvent(event)) !==
        stableStringify(canonicalSettings)
    ) {
      throw new Error(`runtime settings ${eventId} has conflicting evidence`);
    }
    if (proveDurable) {
      active.bootstrap.rolloutStore.syncCanonicalTail();
      return acceptCommitted(false);
    }
    return event;
  };
  let event: Event;
  let publish: () => Event;
  try {
    const candidate = {
      eventId,
      id: eventId,
      msg: {
        type: "run_runtime_settings_changed",
        payload: {
          runId,
          epoch,
          previousSettingsEventId,
          rollbackOfSettingsEventId,
          reason,
          changedAt,
          ...canonicalSettings,
        },
      },
    } satisfies Event;
    const prepared = active.bootstrap.session.prepareEmit(candidate);
    event = prepared.event;
    publish = prepared.publish;
  } catch (error) {
    let recovered: Event | undefined;
    try {
      recovered = acceptCommitted(true);
    } catch (evidenceError) {
      failClosedRuntimeSettingsAuthority(
        active,
        runId,
        new AggregateError(
          [error, evidenceError],
          `runtime settings ${eventId} preparation failed after an ambiguous canonical append`,
          { cause: error },
        ),
      );
    }
    if (recovered === undefined) throw error;
    event = recovered;
    publish = () => active.bootstrap.session.publishPreparedEvent(recovered);
  }
  if (event.eventId !== eventId || positiveSequence(event.seq) === undefined) {
    throw new Error(`runtime settings ${eventId} lacks canonical coordinates`);
  }
  let finalized = false;
  return {
    event,
    eventId,
    previousSettingsEventId,
    finalize: () => {
      if (finalized) return;
      finalized = true;
      active.runtimeSettings = canonicalSettings;
      active.runtimeSettingsEventId = eventId;
      try {
        publish();
      } catch (publishError) {
        let failure: unknown = publishError;
        try {
          const committed = acceptCommitted(true);
          if (committed === undefined) {
            throw new Error(
              `runtime settings ${eventId} publication failed without canonical evidence`,
            );
          }
          projectDurableRuntimeSettingsEvent(active, committed);
        } catch (evidenceError) {
          failure = new AggregateError(
            [publishError, evidenceError],
            `runtime settings ${eventId} publication failed and canonical evidence could not be proved`,
            { cause: publishError },
          );
        }
        failClosedRuntimeSettingsAuthority(active, runId, failure);
      }
      projectDurableRuntimeSettingsEvent(active, event);
    },
  };
}

function projectDurableRuntimeSettingsEvent(
  active: ActiveBackgroundAgent,
  event: Event,
): void {
  try {
    active.bootstrap.rolloutStore.recordRunRuntimeSettingsEvent(event);
  } catch {
    // Canonical fsync evidence is authoritative; SQLite is rebuildable.
  }
}

function assertValidRuntimeSettingsSnapshot(
  settings: RunRuntimeSettingsSnapshot,
  workspaceRoot: string,
): void {
  const bounded = (value: string, maxBytes: number): boolean =>
    value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
  const nullableBounded = (value: string | null, maxBytes: number): boolean =>
    value === null || bounded(value, maxBytes);
  const bypassTransitionCritical =
    settings.permissionMode === "bypassPermissions" ||
    settings.prePlanMode === "bypassPermissions";
  const hasExactBypassConsent =
    settings.bypassPermissionsConsentWorkspace === workspaceRoot;
  let providerModelIsCanonical = false;
  try {
    const selection = mergeProviderModelLayer(
      {},
      {
        model_provider: settings.provider,
        model: settings.model,
      },
    );
    providerModelIsCanonical =
      selection.model_provider === settings.provider &&
      selection.model === settings.model;
  } catch {
    providerModelIsCanonical = false;
  }
  if (
    !RUN_RUNTIME_PERMISSION_MODES.includes(settings.permissionMode) ||
    (settings.prePlanMode !== null &&
      !RUN_RUNTIME_PERMISSION_MODES.includes(settings.prePlanMode)) ||
    (settings.permissionMode === "plan"
      ? settings.prePlanMode === null || settings.prePlanMode === "plan"
      : settings.prePlanMode !== null) ||
    (settings.permissionMode === "auto"
      ? settings.autoModeActive !== true
      : settings.permissionMode !== "plan" &&
        settings.autoModeActive !== false) ||
    typeof settings.autoModeAvailable !== "boolean" ||
    (settings.autoModeActive && !settings.autoModeAvailable) ||
    typeof settings.bypassPermissionsModeAvailable !== "boolean" ||
    (settings.bypassPermissionsConsentWorkspace !== null &&
      !hasExactBypassConsent) ||
    (hasExactBypassConsent && !settings.bypassPermissionsModeAvailable) ||
    (bypassTransitionCritical
      ? settings.bypassPermissionsWorkspace !== workspaceRoot ||
        !settings.bypassPermissionsModeAvailable ||
        !hasExactBypassConsent
      : settings.bypassPermissionsWorkspace !== null) ||
    !bounded(settings.model, 1_024) ||
    !bounded(settings.provider, 256) ||
    !providerModelIsCanonical ||
    !nullableBounded(settings.profile, 256) ||
    (settings.reasoningEffort !== null &&
      !RUN_RUNTIME_REASONING_EFFORTS.includes(settings.reasoningEffort)) ||
    (settings.modelVerbosity !== null &&
      !RUN_RUNTIME_MODEL_VERBOSITIES.includes(settings.modelVerbosity)) ||
    (settings.serviceTier !== null &&
      !RUN_RUNTIME_SERVICE_TIERS.includes(settings.serviceTier)) ||
    typeof settings.hooksDisabled !== "boolean"
  ) {
    throw new Error("runtime settings snapshot is not canonically valid");
  }
}

function restoreBootstrapSelection(params: AgenCBackgroundAgentRestoreParams): {
  readonly provider?: string;
  readonly model?: string;
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
} {
  const canonical = params.runtimeSettings;
  if (canonical === undefined) return params;
  return {
    provider: canonical.provider,
    model: canonical.model,
    ...(canonical.profile !== null ? { profile: canonical.profile } : {}),
    ...(params.configPath !== undefined
      ? { configPath: params.configPath }
      : {}),
    ...(params.addDirs !== undefined ? { addDirs: params.addDirs } : {}),
  };
}

function runtimeSettingsWithRestoreOverrides(
  canonical: RunRuntimeSettingsSnapshot,
  params: AgenCBackgroundAgentRestoreParams,
  workspaceRoot: string,
  config: AgenCConfig,
): RunRuntimeSettingsSnapshot {
  const permissionMode = params.permissionMode ?? canonical.permissionMode;
  const permissionChanged = permissionMode !== canonical.permissionMode;
  const prePlanMode =
    permissionMode === "plan"
      ? permissionChanged
        ? canonical.permissionMode
        : canonical.prePlanMode
      : null;
  const bypassTransitionCritical =
    permissionMode === "bypassPermissions" ||
    prePlanMode === "bypassPermissions";
  const resolvedSelection = resolveProviderModelSelection(
    config,
    { provider: canonical.provider, model: canonical.model },
    {
      ...(params.provider !== undefined
        ? { model_provider: params.provider }
        : {}),
      ...(params.model !== undefined ? { model: params.model } : {}),
    },
  );
  return {
    ...canonical,
    permissionMode,
    prePlanMode,
    autoModeActive:
      permissionMode === "auto"
        ? true
        : permissionMode === "plan" && !permissionChanged
          ? canonical.autoModeActive
          : false,
    bypassPermissionsWorkspace: bypassTransitionCritical ? workspaceRoot : null,
    model: resolvedSelection.model,
    provider: resolvedSelection.provider,
    profile: params.profile ?? canonical.profile,
  };
}

function buildBootstrapArgv(
  params: {
    readonly provider?: string;
    readonly model?: string;
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
  },
  executableArgv: readonly string[] | undefined,
): readonly string[] {
  return buildStructuredSessionBootstrapArgv(
    params,
    executableArgv ?? [process.execPath, process.argv[1] ?? "agenc"],
  );
}

async function installUnattendedPermissionPolicy(
  registry: PermissionModeRegistry,
  allow: readonly string[] | undefined,
  deny: readonly string[] | undefined,
): Promise<void> {
  const next = applyUnattendedPermissionPolicyToContext(registry.current(), {
    ...(allow !== undefined ? { allowlist: allow } : {}),
    ...(deny !== undefined ? { denylist: deny } : {}),
  });
  await registry.update(next);
}

export {
  configuredHookExecutionState,
  runtimeWorkspaceRoot,
  requireCanonicalRuntimeSettingsSupport,
  failClosedDaemonRuntimeAuthority,
  installDaemonPermissionAuthorityCoordinator,
  prepareMcpAuthorityRefresh,
  captureRuntimeSettings,
  normalizeRuntimeSetting,
  installRuntimeSettingsPreCommit,
  withRuntimeSettingsMutation,
  ensureInitialRuntimeSettings,
  compensateRuntimeSettingsChange,
  compensatePreparedRuntimeSettingsChange,
  applyRestoredRuntimeSettings,
  currentCanonicalRuntimeStateFromRollout,
  commitDurableRuntimeSettingsChange,
  prepareDurableRuntimeSettingsChange,
  restoreBootstrapSelection,
  runtimeSettingsWithRestoreOverrides,
  buildBootstrapArgv,
  installUnattendedPermissionPolicy,
};
export type { PreparedRuntimeSettingsChange };
