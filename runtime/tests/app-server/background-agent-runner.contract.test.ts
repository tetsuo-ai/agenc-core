import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";

import {
  AgenCBackgroundAgentMessageError,
  AgenCBackgroundAgentSuspensionShutdownError,
  AgenCDelegateBackgroundAgentRunner,
  daemonEventFromUnboundSessionEvent,
  notificationFromDaemonEvent,
  resolvePermissionDecisionTimeoutMs,
  type AgenCBootstrapFunction,
  type AgenCEnsureAgentControlFunction,
  managedTokenUsage,
} from "./background-agent-runner.js";
import { collectDaemonClientEnvOverrides } from "./agent-cli.js";
import type { AgentStatus } from "../agents/status.js";
import type { AuthBackend } from "../auth/backend.js";
import type {
  AdmissionAcquireInput,
  ExecutionAdmissionClient,
} from "../budget/admission-client.js";
import type { AdmissionLease } from "../budget/admission-types.js";
import type { ExecutionAdmissionKernel } from "../budget/execution-admission-kernel.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "../permissions/types.js";
import type { UserPromptSubmitHook } from "../hooks/user-prompt-submit.js";
import { JSON_RPC_VERSION } from "./protocol/index.js";
import { requestApproval } from "../tools/orchestrator.js";
import type { CsvAgentJobsRepositoryProvider } from "./csv-agent-jobs-authority.js";
import type { RunRuntimeSettingsSnapshot } from "../contracts/run-contracts.js";
import { resolveAgentRuntimeOptions } from "../session/runtime-options.js";
import type {
  PermissionContextPreparedUpdate,
  PermissionContextPublication,
  PermissionContextPublicationCoordinator,
} from "../permissions/permission-mode.js";
import {
  sandboxExecutionBrokerAuthorityFromSessionAuthority,
  sessionExecutionAuthorityFromAgenCConfig,
  type SessionExecutionAuthority,
} from "../session/configuration.js";
import {
  readSandboxExecutionBroker,
  readSandboxExecutionSurface,
  SandboxExecutionBroker,
} from "../sandbox/execution-broker.js";
import {
  clearCurrentRuntimeSession,
  peekScopedRuntimeSession,
  setCurrentRuntimeSession,
} from "../session/current-session.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { Tool, ToolResult } from "../tools/types.js";
import { readToolRuntimeContext } from "../tools/runtimes/context.js";
import type { ToolRegistry } from "../tool-registry.js";
import {
  getCanonicalSettingsAuthority,
  runWithCanonicalSettingsAuthority,
  type CanonicalSettingsAuthority,
} from "../utils/settings/canonicalAuthority.js";
import { workspaceMutationCoordinators } from "../workspace/mutation-coordinator.js";
import {
  COORDINATED_CONFIG_STORE_PUBLICATION,
  type CoordinatedConfigStorePublishOptions,
} from "../config/store.js";
import {
  registerSandboxExecutionLifecycleParticipant,
  transitionSandboxExecutionBroker,
} from "../sandbox/execution-lifecycle.js";

const backgroundAgentRunnerSourcePath = new URL(
  "../../src/app-server/background-agent-runner.ts",
  import.meta.url,
);

describe("background permission timing", () => {
  it("has no implicit permission-decision deadline", () => {
    expect(resolvePermissionDecisionTimeoutMs({})).toBeUndefined();
    expect(
      resolvePermissionDecisionTimeoutMs({
        AGENC_PERMISSION_TIMEOUT_MS: "invalid",
      }),
    ).toBeUndefined();
    expect(
      resolvePermissionDecisionTimeoutMs({
        AGENC_PERMISSION_TIMEOUT_MS: "7200000",
      }),
    ).toBe(7_200_000);
  });
});

type TurnCompleteProgressProjection = (
  agentId: string,
  progress: {
    readonly kind: "turn_complete";
    readonly turnId: string;
    readonly taskId?: string;
    readonly toolCallCount: number;
    readonly finalMessage?: string;
    readonly worktree?: Readonly<Record<string, unknown>>;
    readonly worktreeEvidence?: Readonly<Record<string, unknown>>;
  },
) => Readonly<Record<string, unknown>> | null;

function loadTurnCompleteProgressProjection(): TurnCompleteProgressProjection {
  const source = readFileSync(backgroundAgentRunnerSourcePath, "utf8");
  const start = source.indexOf("function eventFromProgress(");
  const end = source.indexOf("\nfunction messageText(", start);
  if (start < 0 || end < 0) {
    throw new Error("eventFromProgress source boundary was not found");
  }
  const internalSource = `${source.slice(start, end)}
export { eventFromProgress };
`;
  const transformed = transformSync(internalSource, {
    format: "cjs",
    loader: "ts",
    sourcefile: backgroundAgentRunnerSourcePath.pathname,
    sourcemap: "inline",
    target: "node26",
  });
  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(
    transformed.code,
    {
      exports: module.exports,
      module,
    },
    { filename: backgroundAgentRunnerSourcePath.pathname },
  );
  const projection = module.exports.eventFromProgress;
  if (typeof projection !== "function") {
    throw new Error("eventFromProgress was not exported by the test harness");
  }
  return projection as TurnCompleteProgressProjection;
}

function makeStubConversationThreadManager(opts: {
  readonly threadId: string;
  readonly agentPath?: string;
  readonly submit?: ReturnType<typeof vi.fn>;
  readonly appendMessage?: ReturnType<typeof vi.fn>;
  readonly shutdown?: ReturnType<typeof vi.fn>;
  readonly initialStatus?: AgentStatus;
  readonly totalTokenUsage?: () => {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
  readonly scopedTurnCancellation?: boolean;
}) {
  let listeners: ((status: AgentStatus) => void)[] = [];
  let currentStatus: AgentStatus =
    opts.initialStatus ??
    ({
      status: "running",
      turnId: "turn-stub",
      startedAtMs: 0,
    } as AgentStatus);
  const submit = opts.submit ?? vi.fn(async () => opts.threadId);
  const shutdown = opts.shutdown ?? vi.fn(async () => {});
  const managedThread = {
    threadId: opts.threadId,
    agentPath: opts.agentPath ?? "/root",
    kind: "root" as const,
    status: () => currentStatus,
    subscribeStatus: (cb: (status: AgentStatus) => void) => {
      cb(currentStatus);
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((listener) => listener !== cb);
      };
    },
    submit,
    appendMessage: opts.appendMessage ?? vi.fn(async () => opts.threadId),
    shutdown,
    totalTokenUsage:
      opts.totalTokenUsage ??
      (() => ({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      })),
    configSnapshot: () => ({}),
  };
  return {
    hasThread: (id: string) => id === opts.threadId,
    getThread: (id: string) => {
      if (id !== opts.threadId) {
        throw new Error(`stub conversationThreadManager has no thread ${id}`);
      }
      return managedThread;
    },
    removeThread: vi.fn(() => managedThread),
    pushStatus(next: AgentStatus) {
      currentStatus = next;
      for (const cb of [...listeners]) cb(next);
    },
    thread: managedThread,
  };
}

function makeAuthBackend(
  kind: NonNullable<AuthBackend["kind"]>,
  apiKey: string,
): AuthBackend {
  return {
    kind,
    login: vi.fn(() => ({ authenticated: true, provider: kind })),
    logout: vi.fn(() => ({ authenticated: false })),
    whoami: vi.fn(() => ({ authenticated: true, provider: kind })),
    vendKey: vi.fn((provider, sessionId) => ({
      kind: "api-key",
      provider: String(provider),
      sessionId,
      apiKey,
    })),
    inferAgencModel: vi.fn(() => ({
      provider: "agenc",
      model: "agenc:grok",
    })),
    getSubscriptionTier: vi.fn(() => "pro"),
  };
}

function runtimeSettingsRolloutItem(
  runId: string,
  settings: RunRuntimeSettingsSnapshot,
): unknown {
  const eventId = `runtime-settings:${runId}:initial`;
  return {
    type: "event_msg",
    payload: {
      id: eventId,
      eventId,
      seq: 1,
      msg: {
        type: "run_runtime_settings_changed",
        payload: {
          runId,
          epoch: 1,
          previousSettingsEventId: null,
          rollbackOfSettingsEventId: null,
          reason: "initial",
          changedAt: "2026-05-09T00:00:00.000Z",
          ...settings,
        },
      },
    },
  };
}

function canonicalRuntimeSettings(
  overrides: Partial<RunRuntimeSettingsSnapshot> = {},
): RunRuntimeSettingsSnapshot {
  return {
    permissionMode: "default",
    prePlanMode: null,
    autoModeActive: false,
    autoModeAvailable: false,
    bypassPermissionsModeAvailable: false,
    bypassPermissionsWorkspace: null,
    bypassPermissionsConsentWorkspace: null,
    model: "base-model",
    provider: "grok",
    profile: null,
    reasoningEffort: null,
    modelVerbosity: null,
    serviceTier: null,
    hooksDisabled: false,
    ...overrides,
  };
}

function recordedRuntimeSettingsEvents(
  rolloutItems: readonly unknown[],
): Array<{
  readonly eventId?: string;
  readonly msg?: {
    readonly type?: unknown;
    readonly payload?: Record<string, unknown>;
  };
}> {
  return rolloutItems.flatMap((item) => {
    const event = item as {
      readonly payload?: {
        readonly eventId?: string;
        readonly msg?: {
          readonly type?: unknown;
          readonly payload?: Record<string, unknown>;
        };
      };
    };
    return event.payload?.msg?.type === "run_runtime_settings_changed"
      ? [event.payload]
      : [];
  });
}

function bypassRestoreSettings(
  permissionMode: "bypassPermissions" | "plan",
  workspace: string,
): RunRuntimeSettingsSnapshot {
  return {
    permissionMode,
    prePlanMode: permissionMode === "plan" ? "bypassPermissions" : null,
    autoModeActive: false,
    autoModeAvailable: true,
    bypassPermissionsModeAvailable: true,
    bypassPermissionsWorkspace: workspace,
    bypassPermissionsConsentWorkspace: workspace,
    model: "base-model",
    provider: "grok",
    profile: null,
    reasoningEffort: null,
    modelVerbosity: null,
    serviceTier: null,
    hooksDisabled: false,
  };
}

function makeTopLevelRunner(opts: {
  readonly conversationId: string;
  readonly bootstrapShutdown?: ReturnType<typeof vi.fn>;
  readonly bootstrapShutdownAfterFinalizers?: ReturnType<typeof vi.fn>;
  readonly emitAfterAppendError?: Error;
  readonly emitAfterAppendAfter?: number;
  readonly runtimeSettingsFailpoint?: {
    readonly eventOrdinal: number;
    readonly phase: "before_append" | "publish";
    readonly error: Error;
  };
  readonly syncCanonicalTail?: ReturnType<typeof vi.fn>;
  readonly threadShutdown?: ReturnType<typeof vi.fn>;
  readonly threadAppendMessage?: ReturnType<typeof vi.fn>;
  readonly hydrateStateWith?: ReturnType<typeof vi.fn>;
  readonly authBackend?: AuthBackend;
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly now?: () => string;
  readonly additionalRunnerOptions?: Readonly<Record<string, unknown>>;
  readonly executionAdmissionKernel?: ExecutionAdmissionKernel;
  readonly csvAgentJobsRepositories?: CsvAgentJobsRepositoryProvider;
  readonly rolloutItems?: unknown[];
  readonly threadInitialStatus?: AgentStatus;
  readonly onActiveAgentTerminated?: ReturnType<typeof vi.fn>;
  readonly totalTokenUsage?: () => {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
  readonly canonicalRuntimeSettings?: boolean;
  readonly workspaceRoot?: string;
  readonly persistedBypassConsent?: readonly string[];
  readonly userPromptSubmitHooks?: readonly UserPromptSubmitHook[];
  readonly flushDeferredSessionStartHook?: ReturnType<typeof vi.fn>;
  readonly runtimeSimpleMode?: boolean;
  readonly permissionBeforeUpdateGate?: (
    next: ToolPermissionContext,
    current: ToolPermissionContext,
  ) => Promise<void> | void;
  readonly configLayers?: readonly {
    readonly scope: "managed" | "user" | "project" | "local";
    readonly label: string;
    readonly config: Record<string, unknown>;
  }[];
}) {
  const shutdownImpl = opts.bootstrapShutdown ?? vi.fn(async () => {});
  const durableOperations = new Set<Promise<unknown>>();
  const beforeDurableClose = new Set<() => void | Promise<void>>();
  const permissionUpdates: ToolPermissionContext[] = [];
  let permissionContext = createEmptyToolPermissionContext({
    isAutoModeAvailable:
      typeof opts.env?.XAI_API_KEY === "string" ||
      typeof opts.env?.GROK_API_KEY === "string",
  });
  let permissionRegistryQueue: Promise<void> = Promise.resolve();
  const withPermissionRegistryLock = <T>(
    work: () => Promise<T>,
  ): Promise<T> => {
    const result = permissionRegistryQueue.then(work);
    permissionRegistryQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  let permissionBeforeUpdate:
    | ((
        next: ToolPermissionContext,
        current: ToolPermissionContext,
        metadata: unknown,
      ) =>
        | void
        | (() => void | Promise<void>)
        | PermissionContextPreparedUpdate
        | Promise<
            | void
            | (() => void | Promise<void>)
            | PermissionContextPreparedUpdate
          >)
    | undefined;
  let permissionPublicationCoordinator:
    PermissionContextPublicationCoordinator | undefined;
  const publishPermissionContext = async (
    next: ToolPermissionContext,
    current: ToolPermissionContext,
    metadata: unknown,
  ): Promise<void> => {
    await opts.permissionBeforeUpdateGate?.(next, current);
    const preparedResult = await permissionBeforeUpdate?.(
      next,
      current,
      metadata,
    );
    const prepared =
      typeof preparedResult === "function"
        ? { commit: preparedResult }
        : preparedResult;
    let state: "prepared" | "committed" | "rolled_back" = "prepared";
    const publication: PermissionContextPublication = {
      commit: async () => {
        if (opts.canonicalRuntimeSettings !== false) permissionContext = next;
        try {
          await prepared?.commit();
          state = "committed";
        } catch (error) {
          if (opts.canonicalRuntimeSettings !== false) {
            permissionContext = current;
          }
          state = "rolled_back";
          await prepared?.rollback?.();
          throw error;
        }
      },
      rollback: async () => {
        if (state === "rolled_back") return;
        if (opts.canonicalRuntimeSettings !== false)
          permissionContext = current;
        state = "rolled_back";
        await prepared?.rollback?.();
      },
    };
    try {
      if (permissionPublicationCoordinator === undefined) {
        await publication.commit();
      } else {
        await permissionPublicationCoordinator(
          next,
          current,
          metadata,
          publication,
        );
      }
    } catch (error) {
      await publication.rollback();
      throw error;
    } finally {
      await prepared?.settle?.();
    }
    permissionUpdates.push(next);
  };
  const permissionModeRegistry = {
    current: () =>
      opts.canonicalRuntimeSettings !== false
        ? permissionContext
        : createEmptyToolPermissionContext(),
    update: vi.fn((context: ToolPermissionContext, metadata?: unknown) =>
      withPermissionRegistryLock(async () => {
        await publishPermissionContext(context, permissionContext, metadata);
      }),
    ),
    transact: vi.fn(
      <T>(
        transaction: (current: ToolPermissionContext) => Promise<{
          readonly next: ToolPermissionContext | null;
          readonly metadata?: unknown;
          readonly result: () => T;
        }>,
      ): Promise<T> =>
        withPermissionRegistryLock(async () => {
          const current =
            opts.canonicalRuntimeSettings !== false
              ? permissionContext
              : createEmptyToolPermissionContext();
          const mutation = await transaction(current);
          if (mutation.next !== null) {
            await publishPermissionContext(
              mutation.next,
              current,
              mutation.metadata,
            );
          }
          return mutation.result();
        }),
    ),
    installBeforeUpdateHook: vi.fn((hook: typeof permissionBeforeUpdate) => {
      permissionBeforeUpdate = hook;
      return () => {
        if (permissionBeforeUpdate === hook) permissionBeforeUpdate = undefined;
      };
    }),
    installPublicationCoordinator: vi.fn(
      (coordinator: PermissionContextPublicationCoordinator) => {
        if (permissionPublicationCoordinator !== undefined) {
          throw new Error(
            "permission context publication coordinator already installed",
          );
        }
        permissionPublicationCoordinator = coordinator;
        return () => {
          if (permissionPublicationCoordinator === coordinator) {
            permissionPublicationCoordinator = undefined;
          }
        };
      },
    ),
  };
  const stub = makeStubConversationThreadManager({
    threadId: opts.conversationId,
    ...(opts.threadInitialStatus !== undefined
      ? { initialStatus: opts.threadInitialStatus }
      : {}),
    ...(opts.threadShutdown !== undefined
      ? { shutdown: opts.threadShutdown }
      : {}),
    ...(opts.threadAppendMessage !== undefined
      ? { appendMessage: opts.threadAppendMessage }
      : {}),
    ...(opts.totalTokenUsage !== undefined
      ? { totalTokenUsage: opts.totalTokenUsage }
      : {}),
  });
  const phaseSubscribers: Array<(phase: unknown) => void> = [];
  const eventLogSubscribers: Array<(event: unknown) => void> = [];
  const rolloutItems = opts.rolloutItems ?? [];
  let lastSeq = rolloutItems.reduce((highest, item) => {
    const seq = (item as { payload?: { seq?: unknown } })?.payload?.seq;
    return typeof seq === "number" && Number.isSafeInteger(seq)
      ? Math.max(highest, seq)
      : highest;
  }, 0);
  let preparedEventCount = 0;
  let preparedRuntimeSettingsEventCount = 0;
  const publishSessionEvent = (event: unknown) => {
    for (const listener of [...eventLogSubscribers]) listener(event);
  };
  const rolloutStore = {
    rolloutPath: `/tmp/${opts.conversationId}.jsonl`,
    readAll: () => [...rolloutItems],
    assertRunSuspendable: vi.fn(() => {}),
    recordRunSuspensionEvent: vi.fn(() => {}),
    recordRunStartupActivationEvent: vi.fn(() => {}),
    ...(opts.canonicalRuntimeSettings !== false
      ? { recordRunRuntimeSettingsEvent: vi.fn(() => {}) }
      : {}),
    syncCanonicalTail: opts.syncCanonicalTail ?? vi.fn(() => {}),
  };
  let activeTurnValue: { readonly turnId: string } | null = null;
  const abortTurnIfActive = vi.fn(async (turnId: string) => {
    if (activeTurnValue?.turnId !== turnId) return false;
    activeTurnValue = null;
    return true;
  });
  const activeTurn = {
    unsafePeek: () => activeTurnValue,
  };
  // Runtime workspace identity is security-sensitive and must resolve to a
  // physical directory even in skeletal runner tests. Individual rejection
  // tests can still pass an explicit invalid workspaceRoot.
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const persistedBypassConsent = new Set(opts.persistedBypassConsent ?? []);
  const stateRepository = {
    reload: vi.fn(() => ({})),
    getNamespace: vi.fn((namespace: string) =>
      namespace === "permissions" && persistedBypassConsent.size > 0
        ? {
            bypassPermissionsAcceptedByCwd: Object.fromEntries(
              [...persistedBypassConsent].map((cwd) => {
                const canonicalCwd = realpathSync(cwd);
                const identity = statSync(canonicalCwd);
                return [
                  canonicalCwd,
                  {
                    version: 1,
                    canonicalCwd,
                    dev: identity.dev.toString(10),
                    ino: identity.ino.toString(10),
                  },
                ] as const;
              }),
            ),
          }
        : {},
    ),
  };
  const configPublicationOptions: unknown[] = [];
  const configStore = {
    current: () => ({}),
    stateRepository,
    projectRoot: workspaceRoot,
    authoritySnapshot: () => ({
      config: {},
      layers: [...(opts.configLayers ?? [])],
    }),
    sources: (scope: string) =>
      (opts.configLayers ?? []).filter((layer) => layer.scope === scope),
  };
  Object.assign(configStore, {
    prepareReload: async function (this: Record<string, unknown>) {
      const reload = this.reload;
      const staged =
        typeof reload === "function"
          ? await (reload as () => Promise<Record<string, unknown>>)()
          : (this.current as () => Record<string, unknown>)();
      let state: "prepared" | "committed" | "published" | "rolled_back" =
        "prepared";
      let settled = false;
      const authority = {
        ...this,
        current: () => staged,
        authoritySnapshot: () => ({
          config: staged,
          layers: [...(opts.configLayers ?? [])],
        }),
        sources: (scope: string) =>
          (opts.configLayers ?? []).filter((layer) => layer.scope === scope),
        ignored: () => [],
        warnings: () => [],
        provenance: () => undefined,
      };
      return {
        config: staged,
        authority,
        get state() {
          return state;
        },
        get settled() {
          return settled;
        },
        commit: () => {
          state = "committed";
        },
        publish: (options?: unknown) => {
          state = "published";
          configPublicationOptions.push(options);
        },
        rollback: () => {
          state = "rolled_back";
        },
        settle: () => {
          settled = true;
        },
      };
    },
  });
  let configuredExecutionAuthority: SessionExecutionAuthority =
    sessionExecutionAuthorityFromAgenCConfig({
      config: {},
      workspaceRoot,
      projectTrust: "trusted",
    });
  const sandboxExecutionBroker = new SandboxExecutionBroker({
    cwd: workspaceRoot,
    ...sandboxExecutionBrokerAuthorityFromSessionAuthority(
      configuredExecutionAuthority,
      workspaceRoot,
    ),
  });
  const sessionState = {
    sessionConfiguration: {
      cwd: workspaceRoot,
      ...configuredExecutionAuthority,
      collaborationMode: { model: "base-model" },
      provider: { slug: "grok" },
      dynamicTools: [],
      sessionSource: "cli_main" as const,
    },
    history: [] as unknown[],
  };
  const providerEnvironment = Object.freeze({
    XAI_API_KEY: opts.env?.XAI_API_KEY,
    GROK_API_KEY: opts.env?.GROK_API_KEY,
  });
  const providerService = {
    environment: () => providerEnvironment,
    current: () => ({
      provider: sessionState.sessionConfiguration.provider.slug,
      model: sessionState.sessionConfiguration.collaborationMode.model,
      revision: 0,
    }),
  };
  let nextInternalSubId = 0;
  const sessionAbortController = new AbortController();
  const session = {
    abortController: sessionAbortController,
    abortTerminal: vi.fn((reason: string) => {
      if (!sessionAbortController.signal.aborted) {
        sessionAbortController.abort(reason);
      }
    }),
    conversationId: opts.conversationId,
    providerService,
    permissionModeRegistry,
    get sessionConfiguration() {
      return sessionState.sessionConfiguration;
    },
    pendingProviderSwitch: null as {
      provider: string;
      model: string;
      profile?: string;
    } | null,
    prepareProviderSwitch: vi.fn(
      async (spec: { provider: string; model: string; profile?: string }) => ({
        pending: Object.freeze({ ...spec }),
        provider: { expectedRevision: providerService.current().revision },
        modelInfo: { slug: spec.model },
        baseInstructions: "",
      }),
    ),
    stagePreparedProviderSwitch(
      prepared: {
        pending: { provider: string; model: string; profile?: string };
        provider: { expectedRevision: number };
      },
      expectedPending: {
        provider: string;
        model: string;
        profile?: string;
      } | null,
    ) {
      if (this.pendingProviderSwitch !== expectedPending) {
        throw new Error(
          "pending provider selection changed during test preparation",
        );
      }
      if (
        prepared.provider.expectedRevision !==
        providerService.current().revision
      ) {
        throw new Error("provider binding changed during test preparation");
      }
      this.pendingProviderSwitch = prepared.pending;
    },
    setPendingProviderSwitch(
      spec: {
        provider: string;
        model: string;
        profile?: string;
      } | null,
    ) {
      this.pendingProviderSwitch = spec;
    },
    syncPermissionContextFromRegistry: vi.fn(async () => {}),
    flushDeferredSessionStartHook:
      opts.flushDeferredSessionStartHook ?? vi.fn(async () => {}),
    state: {
      with: vi.fn(async (apply: (state: typeof sessionState) => void) => {
        await apply(sessionState);
      }),
      unsafePeek: () => sessionState,
    },
    abortAllTasks: vi.fn(async () => {}),
    trackDurableOperation: <T>(operation: Promise<T>): Promise<T> => {
      durableOperations.add(operation);
      void operation.then(
        () => durableOperations.delete(operation),
        () => durableOperations.delete(operation),
      );
      return operation;
    },
    onBeforeDurableClose: (listener: () => void | Promise<void>) => {
      beforeDurableClose.add(listener);
      return () => beforeDurableClose.delete(listener);
    },
    eventLog: {
      get lastSeq() {
        return lastSeq;
      },
      subscribe: (listener: (event: unknown) => void) => {
        eventLogSubscribers.push(listener);
        return () => {
          const index = eventLogSubscribers.indexOf(listener);
          if (index >= 0) eventLogSubscribers.splice(index, 1);
        };
      },
    },
    subscribeToEvents: (listener: (phase: unknown) => void) => {
      phaseSubscribers.push(listener);
      return () => {
        const index = phaseSubscribers.indexOf(listener);
        if (index >= 0) phaseSubscribers.splice(index, 1);
      };
    },
    emitPhaseEvent: (phase: unknown) => {
      for (const listener of [...phaseSubscribers]) listener(phase);
    },
    nextInternalSubId: () =>
      `background-runner-hook-${(nextInternalSubId += 1)}`,
    emitSessionEvent: (event: unknown) => {
      const sequence = (event as { seq?: unknown }).seq;
      if (typeof sequence === "number" && Number.isSafeInteger(sequence)) {
        lastSeq = Math.max(lastSeq, sequence);
      }
      publishSessionEvent(event);
    },
    prepareEmit: vi.fn((event: unknown) => {
      const runtimeSettingsEvent =
        (event as { msg?: { type?: unknown } }).msg?.type ===
        "run_runtime_settings_changed";
      const runtimeSettingsEventOrdinal = runtimeSettingsEvent
        ? (preparedRuntimeSettingsEventCount += 1)
        : 0;
      if (
        opts.runtimeSettingsFailpoint?.phase === "before_append" &&
        opts.runtimeSettingsFailpoint.eventOrdinal ===
          runtimeSettingsEventOrdinal
      ) {
        throw opts.runtimeSettingsFailpoint.error;
      }
      const sequence = ++lastSeq;
      preparedEventCount += 1;
      const stamped = {
        ...(event as object),
        eventId:
          (event as { eventId?: unknown }).eventId ?? `event:${sequence}`,
        seq: sequence,
      };
      rolloutItems.push({ type: "event_msg", payload: stamped });
      if (
        opts.emitAfterAppendError !== undefined &&
        preparedEventCount > (opts.emitAfterAppendAfter ?? 0)
      ) {
        throw opts.emitAfterAppendError;
      }
      let published = false;
      return {
        event: stamped,
        publish: () => {
          if (
            opts.runtimeSettingsFailpoint?.phase === "publish" &&
            opts.runtimeSettingsFailpoint.eventOrdinal ===
              runtimeSettingsEventOrdinal
          ) {
            throw opts.runtimeSettingsFailpoint.error;
          }
          if (!published) {
            published = true;
            publishSessionEvent(stamped);
          }
          return stamped;
        },
      };
    }),
    publishPreparedEvent: vi.fn((event: unknown) => {
      publishSessionEvent(event);
      return event;
    }),
    emit: vi.fn((event: unknown) => {
      const prepared = session.prepareEmit(event);
      return prepared.publish();
    }),
    rolloutStore,
    services: {
      conversationThreadManager: stub,
      providerService,
      configStore,
      runtimeOptions: resolveAgentRuntimeOptions(
        {},
        { simpleMode: opts.runtimeSimpleMode ?? false },
      ),
      hooks: {
        userPromptSubmitHooks: [...(opts.userPromptSubmitHooks ?? [])],
      },
      sandboxExecutionBroker,
    },
  };
  if (opts.hydrateStateWith !== undefined) {
    Object.assign(session, { state: { with: opts.hydrateStateWith } });
  }
  if (opts.scopedTurnCancellation === true) {
    Object.assign(session, { abortTurnIfActive, activeTurn });
  }
  const shutdown = vi.fn(async () => {
    await shutdownImpl();
    while (durableOperations.size > 0) {
      await Promise.all([...durableOperations]);
    }
    const finalizers = [...beforeDurableClose];
    beforeDurableClose.clear();
    for (const finalize of finalizers) await finalize();
    await opts.bootstrapShutdownAfterFinalizers?.();
  });
  const control = {
    shutdown: vi.fn(async () => {}),
    sendInput: vi.fn(async () => {}),
    interrupt: vi.fn(),
    openThreadSpawnChildren: vi.fn(() => []),
    liveThreadSpawnChildren: vi.fn(() => new Map()),
    clearConversationHistory: vi.fn(async () => {}),
  };
  const bootstrap = vi.fn(async () => ({
    workspaceRoot,
    configStore,
    get configuredExecutionAuthority() {
      return configuredExecutionAuthority;
    },
    prepareConfiguredExecutionAuthority: (config: Record<string, unknown>) => {
      const previous = configuredExecutionAuthority;
      const authority = sessionExecutionAuthorityFromAgenCConfig({
        config,
        workspaceRoot,
        projectTrust: "trusted",
      });
      let committed = false;
      return {
        authority,
        commit: () => {
          configuredExecutionAuthority = authority;
          committed = true;
        },
        rollback: () => {
          if (!committed) return;
          configuredExecutionAuthority = previous;
          committed = false;
        },
      };
    },
    session,
    rolloutStore,
    registry: {
      tools: [],
      toLLMTools: () => [],
      dispatch: vi.fn(),
    },
    shutdown,
  })) as unknown as ReturnType<typeof vi.fn> & AgenCBootstrapFunction;
  const runner = new AgenCDelegateBackgroundAgentRunner({
    ...opts.additionalRunnerOptions,
    ...(opts.authBackend !== undefined
      ? { authBackend: opts.authBackend }
      : {}),
    bootstrap,
    ensureAgentControl: vi.fn(() => ({
      control,
      registry: {},
    })) as unknown as AgenCEnsureAgentControlFunction,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.argv !== undefined ? { argv: opts.argv } : {}),
    ...(opts.executionAdmissionKernel !== undefined
      ? { executionAdmissionKernel: opts.executionAdmissionKernel }
      : {}),
    ...(opts.csvAgentJobsRepositories !== undefined
      ? { csvAgentJobsRepositories: opts.csvAgentJobsRepositories }
      : {}),
    now: opts.now ?? (() => "2026-05-09T00:00:00.000Z"),
    ...(opts.onActiveAgentTerminated !== undefined
      ? { onActiveAgentTerminated: opts.onActiveAgentTerminated }
      : {}),
  });
  return {
    runner,
    session,
    control,
    stub,
    shutdown,
    bootstrap,
    permissionUpdates,
    permissionModeRegistry,
    rolloutItems,
    rolloutStore,
    configStore,
    configPublicationOptions,
    sandboxExecutionBroker,
    sessionState,
    stateRepository,
    persistedBypassConsent,
    abortTurnIfActive,
    activeTurn,
    setActiveTurn(turnId: string | null) {
      activeTurnValue = turnId === null ? null : { turnId };
    },
    forcePermissionContextForTesting(next: ToolPermissionContext) {
      permissionContext = next;
    },
  };
}

function configureSessionShellHarness(
  harness: ReturnType<typeof makeTopLevelRunner>,
  options: {
    readonly defaultShell?: "bash" | "powershell";
    readonly settingsHome?: string;
    readonly execute?: (
      args: Record<string, unknown>,
      toolName: "system.bash" | "PowerShell",
    ) => Promise<ToolResult>;
  } = {},
) {
  const leaseFallback = new AbortController();
  const acquire = vi.fn(
    async (
      input: AdmissionAcquireInput,
      signal?: AbortSignal,
    ): Promise<AdmissionLease> => ({
      decision: "allow",
      reservation: {
        reservationId: `shell-reservation:${input.stepId}`,
        step: { runId: harness.session.conversationId, stepId: input.stepId },
        reservedCostUsd: input.maxCostUsd ?? 0,
        reservedTokens: input.maxInputTokens + input.maxOutputTokens,
        reservedAt: "2026-08-27T00:00:00.000Z",
      },
      request: {
        step: { runId: harness.session.conversationId, stepId: input.stepId },
        kind: input.kind,
        estimate: {
          maxInputTokens: input.maxInputTokens,
          maxOutputTokens: input.maxOutputTokens,
          maxCostUsd: input.maxCostUsd,
        },
        workspaceId: harness.session.conversationId,
        sessionId: input.sessionId ?? harness.session.conversationId,
        parentScopeId: input.parentScopeId,
        autonomous: false,
      },
      signal: signal ?? leaseFallback.signal,
    }),
  );
  const markDispatched = vi.fn();
  const reconcile = vi.fn(() => ({
    applied: true as const,
    outcome: "reconciled" as const,
  }));
  const admission = {
    scope: {
      runId: harness.session.conversationId,
      workspaceId: harness.session.conversationId,
      sessionId: harness.session.conversationId,
      budgetIdentity: harness.session.conversationId,
      autonomous: false,
    },
    acquire,
    markDispatched,
    reconcile,
    holdUnknown: vi.fn(),
    cancelRun: vi.fn(),
    void: vi.fn(),
    acknowledgeCompletion: vi.fn(),
    recordFallback: vi.fn(),
    forSession: vi.fn(() => admission),
    subscribe: vi.fn(() => () => {}),
  } as unknown as ExecutionAdmissionClient;

  const preHook = vi.fn(
    ({ args }: { readonly args: Record<string, unknown> }) => ({
      kind: "continue" as const,
      args: { ...args, observedByPreHook: true },
    }),
  );
  const postHook = vi.fn(() => ({ kind: "continue" as const }));
  const checkPermissions = vi.fn((input: unknown) => ({
    behavior: "allow" as const,
    updatedInput: input as Record<string, unknown>,
  }));
  const executeShell =
    options.execute ??
    (async (): Promise<ToolResult> => ({
      content: "shell output",
      metadata: {
        stdout: "shell stdout",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      },
    }));
  const shellTool = (name: "system.bash" | "PowerShell"): Tool => ({
    name,
    description: `test ${name}`,
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    metadata: { source: "builtin", mutating: true },
    recoveryCategory: "side-effecting",
    admissionEstimate: () => ({
      maxInputTokens: 0,
      maxOutputTokens: 0,
      maxCostUsd: 0,
    }),
    checkPermissions,
    execute: vi.fn((args: Record<string, unknown>) => executeShell(args, name)),
  });
  const bashTool = shellTool("system.bash");
  const powerShellTool = shellTool("PowerShell");
  const registry: ToolRegistry = {
    tools: [bashTool, powerShellTool],
    toLLMTools: () => [],
    dispatch: vi.fn(async () => ({ content: "registry dispatch unused" })),
  };

  const settings = { defaultShell: options.defaultShell ?? "bash" };
  const settingsHome =
    options.settingsHome ??
    join(tmpdir(), `${harness.session.conversationId}-settings-home`);
  Object.assign(harness.configStore, {
    current: () => settings,
    authoritySnapshot: () => ({ config: settings, layers: [] }),
    homeContext: {
      path: settingsHome,
      identityKey: settingsHome,
      secureStorageAccount: "test-account",
      oauthFileSuffix: "test",
      source: "agenc-home",
      isDefault: false,
      configTomlPath: join(settingsHome, "config.toml"),
      statePath: join(settingsHome, "state.json"),
      authPath: join(settingsHome, "auth.json"),
      trustedProjectsPath: join(settingsHome, "trusted-projects.json"),
    },
    reload: async () => settings,
    subscribe: () => () => {},
  });
  const subscribeToModeChange = vi.fn(() => () => {});
  Object.assign(harness.permissionModeRegistry, { subscribeToModeChange });
  Object.assign(harness.rolloutStore, {
    assertToolAdmissionAllowed: vi.fn(),
    assertToolEffectAttemptAllowed: vi.fn(() => 1),
    recordEffectEvent: vi.fn(),
  });

  const session = harness.session as unknown as {
    readonly conversationId: string;
    readonly services: Record<string, unknown> & {
      hooks?: Readonly<Record<string, unknown>>;
    };
    readonly eventLog: Record<string, unknown>;
    readonly emit: (event: unknown, options?: unknown) => unknown;
    newDefaultTurnWithSubId?: (subId: string) => TurnContext;
  };
  const hooks = session.services.hooks ?? {};
  Object.assign(session.services, {
    registry,
    executionAdmission: admission,
    admissionRequired: true,
    permissionModeRegistry: harness.permissionModeRegistry,
    hooks: {
      ...hooks,
      preToolUseHooks: [preHook],
      postToolUseHooks: [postHook],
    },
  });
  Object.assign(session.eventLog, {
    emit: (event: unknown) => session.emit(event),
  });
  const newDefaultTurnWithSubId = vi.fn(
    (subId: string) =>
      ({
        subId,
        cwd: harness.sessionState.sessionConfiguration.cwd,
        approvalPolicy: { value: "never" },
        sandboxPolicy: { value: "danger_full_access" },
        config: {},
      }) as unknown as TurnContext,
  );
  session.newDefaultTurnWithSubId = newDefaultTurnWithSubId;

  return {
    acquire,
    admission,
    bashExecute: bashTool.execute as ReturnType<typeof vi.fn>,
    checkPermissions,
    markDispatched,
    newDefaultTurnWithSubId,
    postHook,
    powerShellExecute: powerShellTool.execute as ReturnType<typeof vi.fn>,
    preHook,
    reconcile,
    registry,
    subscribeToModeChange,
  };
}

describe("AgenC delegate background-agent runner", () => {
  it("[managed-thread] runs a deferred session shell through the canonical live router authorities", async () => {
    const harness = makeTopLevelRunner({
      conversationId: "session-direct-shell-authorities",
      threadInitialStatus: { status: "pending_init" } as AgentStatus,
    });
    let dispatchSawDurableInput = false;
    const shell = configureSessionShellHarness(harness, {
      defaultShell: "powershell",
      execute: async (args, toolName) => {
        const calls = vi.mocked(harness.session.emit).mock
          .calls as unknown as Array<readonly [unknown, unknown?]>;
        const input = calls.find(([event]) => {
          const payload = (
            event as {
              readonly msg?: {
                readonly type?: unknown;
                readonly payload?: { readonly message?: unknown };
              };
            }
          ).msg;
          return (
            payload?.type === "user_message" &&
            typeof payload.payload?.message === "string" &&
            payload.payload.message.startsWith("<bash-input>")
          );
        });
        dispatchSawDurableInput = input?.[1] !== undefined;
        expect(input?.[1]).toEqual({ durable: true });
        expect(toolName).toBe("PowerShell");
        expect(args).toMatchObject({
          command: "printf shell-route",
          observedByPreHook: true,
        });
        expect(readSandboxExecutionBroker(args)).toBe(
          harness.sandboxExecutionBroker,
        );
        expect(readSandboxExecutionSurface(args)).toBe("tool");
        expect(readToolRuntimeContext(args)).toMatchObject({
          source: "direct",
          toolName: "PowerShell",
          requestedSandboxMode: "danger_full_access",
          sandboxMode: "danger_full_access",
        });
        expect(getCanonicalSettingsAuthority()).toBe(harness.configStore);
        expect(peekScopedRuntimeSession()).toBe(harness.session);
        return {
          content: "shell content",
          metadata: {
            stdout: "shell stdout",
            stderr: "shell stderr",
            exitCode: 0,
            timedOut: false,
          },
        };
      },
    });

    await harness.runner.startAgent({
      objective: "deferred direct shell",
      deferInitialTurn: true,
      unattendedAllow: [],
      unattendedDeny: [],
    });
    harness.forcePermissionContextForTesting(
      createEmptyToolPermissionContext({
        mode: "bypassPermissions",
        isBypassPermissionsModeAvailable: true,
      }),
    );
    const execution = harness.runner.executeAgentShell(
      "session-direct-shell-authorities",
      {
        sessionId: "session-direct-shell-authorities",
        commandId: "shell-authorities-1",
        command: "printf shell-route",
      },
    );
    const result = await execution.then((resolved) => {
      const calls = vi.mocked(harness.session.emit).mock
        .calls as unknown as Array<readonly [unknown, unknown?]>;
      const durableMessages = calls
        .map(([event, options], index) => ({
          index,
          options,
          msg: (
            event as {
              readonly msg?: {
                readonly type?: unknown;
                readonly payload?: { readonly message?: unknown };
              };
            }
          ).msg,
        }))
        .filter(({ msg }) => msg?.type === "user_message");
      const input = durableMessages.find(({ msg }) =>
        String(msg?.payload?.message).startsWith("<bash-input>"),
      );
      const output = durableMessages.find(({ msg }) =>
        String(msg?.payload?.message).startsWith("<bash-stdout>"),
      );
      expect(input?.options).toEqual({ durable: true });
      expect(output?.options).toEqual({ durable: true });
      expect(output?.index).toBeGreaterThan(input?.index ?? Number.MAX_VALUE);
      return resolved;
    });

    expect(result).toEqual({
      commandId: "shell-authorities-1",
      content: "shell content",
      stdout: "shell stdout",
      stderr: "shell stderr",
      exitCode: 0,
      timedOut: false,
      truncated: false,
      isError: false,
    });
    expect(dispatchSawDurableInput).toBe(true);
    expect(shell.powerShellExecute).toHaveBeenCalledOnce();
    expect(shell.bashExecute).not.toHaveBeenCalled();
    expect(shell.newDefaultTurnWithSubId).toHaveBeenCalledWith(
      expect.stringMatching(/^shell-/u),
    );
    expect(shell.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tool_exec",
        sessionId: "session-direct-shell-authorities",
      }),
      expect.any(AbortSignal),
    );
    expect(shell.markDispatched).toHaveBeenCalledWith(
      expect.stringContaining("shell-reservation:"),
      expect.objectContaining({ boundary: "tool_effect" }),
    );
    expect(shell.reconcile).toHaveBeenCalledOnce();
    expect(shell.checkPermissions).toHaveBeenCalled();
    expect(shell.preHook).toHaveBeenCalledOnce();
    expect(shell.postHook).toHaveBeenCalledOnce();
    expect(shell.subscribeToModeChange).toHaveBeenCalledOnce();
    const canonicalToolEvents = (
      vi.mocked(harness.session.emit).mock.calls as unknown as Array<
        readonly [
          {
            readonly msg?: {
              readonly type?: unknown;
              readonly payload?: Readonly<Record<string, unknown>>;
            };
          },
          unknown?,
        ]
      >
    )
      .map(([event, options]) => ({ msg: event.msg, options }))
      .filter(({ msg }) =>
        msg?.type === "tool_call_started" ||
        msg?.type === "tool_call_completed",
      );
    expect(canonicalToolEvents).toEqual([
      {
        msg: {
          type: "tool_call_started",
          payload: expect.objectContaining({
            callId: "shell-authorities-1",
            toolName: "PowerShell",
          }),
        },
        options: { durable: true },
      },
      {
        msg: {
          type: "tool_call_completed",
          payload: expect.objectContaining({
            callId: "shell-authorities-1",
            toolName: "PowerShell",
            result: "shell content",
            isError: false,
            metadata: expect.objectContaining({ toolName: "PowerShell" }),
          }),
        },
        options: {
          durable: true,
          turnId: expect.stringMatching(/^shell-/u),
          toolResultBytes: Buffer.byteLength("shell content", "utf8"),
        },
      },
    ]);
    const durableShellEvents = harness.rolloutItems.flatMap((item) => {
      const payload = (item as {
        readonly type?: unknown;
        readonly payload?: {
          readonly msg?: {
            readonly type?: unknown;
            readonly payload?: Readonly<Record<string, unknown>>;
          };
        };
      });
      if (payload.type !== "event_msg" || payload.payload?.msg === undefined) {
        return [];
      }
      const message = payload.payload.msg;
      if (
        message.type !== "user_message" &&
        message.type !== "tool_call_started" &&
        message.type !== "tool_call_completed"
      ) {
        return [];
      }
      const callId = message.payload?.callId;
      const queuedCommandUuid = message.payload?.queuedCommandUuid;
      return callId === "shell-authorities-1" ||
        queuedCommandUuid === "shell-authorities-1"
        ? [message]
        : [];
    });
    expect(durableShellEvents.map(event => event.type)).toEqual([
      "user_message",
      "tool_call_started",
      "tool_call_completed",
      "user_message",
    ]);
    expect(harness.stub.thread.submit).not.toHaveBeenCalled();
    expect(harness.control.sendInput).not.toHaveBeenCalled();
  });

  it("[managed-thread] durably closes direct shell state when dispatch rejects after start", async () => {
    const agentId = "session-direct-shell-dispatch-rejection";
    const harness = makeTopLevelRunner({
      conversationId: agentId,
      threadInitialStatus: { status: "pending_init" } as AgentStatus,
    });
    const shell = configureSessionShellHarness(harness);
    await harness.runner.startAgent({
      objective: "deferred direct shell",
      deferInitialTurn: true,
      unattendedAllow: [],
      unattendedDeny: [],
    });
    harness.forcePermissionContextForTesting(
      createEmptyToolPermissionContext({
        mode: "bypassPermissions",
        isBypassPermissionsModeAvailable: true,
      }),
    );
    const registeredTools = shell.registry.tools;
    let toolReads = 0;
    Object.defineProperty(shell.registry, "tools", {
      configurable: true,
      get: () => {
        toolReads += 1;
        if (toolReads === 1) return registeredTools;
        throw new Error("injected router construction failure");
      },
    });

    await expect(
      harness.runner.executeAgentShell(agentId, {
        sessionId: agentId,
        commandId: "shell-dispatch-rejection-1",
        command: "printf never-dispatched",
      }),
    ).rejects.toThrow("injected router construction failure");

    const lifecycle = harness.rolloutItems.flatMap((item) => {
      const message = (item as {
        readonly type?: unknown;
        readonly payload?: {
          readonly msg?: {
            readonly type?: unknown;
            readonly payload?: Readonly<Record<string, unknown>>;
          };
        };
      }).payload?.msg;
      return message?.payload?.callId === "shell-dispatch-rejection-1" &&
        (message.type === "tool_call_started" ||
          message.type === "tool_call_completed")
        ? [message]
        : [];
    });
    expect(lifecycle).toEqual([
      expect.objectContaining({
        type: "tool_call_started",
        payload: expect.objectContaining({
          callId: "shell-dispatch-rejection-1",
          toolName: "system.bash",
        }),
      }),
      expect.objectContaining({
        type: "tool_call_completed",
        payload: expect.objectContaining({
          callId: "shell-dispatch-rejection-1",
          toolName: "system.bash",
          result: "injected router construction failure",
          isError: true,
        }),
      }),
    ]);
    expect(shell.bashExecute).not.toHaveBeenCalled();
  });

  it("[managed-thread] durably closes direct shell state when validation fails before dispatch", async () => {
    const agentId = "session-direct-shell-prestart-rejection";
    const harness = makeTopLevelRunner({
      conversationId: agentId,
      threadInitialStatus: { status: "pending_init" } as AgentStatus,
    });
    const shell = configureSessionShellHarness(harness);
    await harness.runner.startAgent({
      objective: "deferred direct shell",
      deferInitialTurn: true,
      unattendedAllow: [],
      unattendedDeny: [],
    });
    harness.forcePermissionContextForTesting(
      createEmptyToolPermissionContext({
        mode: "bypassPermissions",
        isBypassPermissionsModeAvailable: true,
      }),
    );
    Object.defineProperty(shell.registry, "tools", {
      configurable: true,
      get: () => [],
    });

    await expect(
      harness.runner.executeAgentShell(agentId, {
        sessionId: agentId,
        commandId: "shell-prestart-rejection-1",
        command: "printf never-started",
      }),
    ).rejects.toThrow("Configured shell system.bash is not available");

    const lifecycle = harness.rolloutItems.flatMap((item) => {
      const message = (item as {
        readonly payload?: {
          readonly msg?: {
            readonly type?: unknown;
            readonly payload?: Readonly<Record<string, unknown>>;
          };
        };
      }).payload?.msg;
      return message?.payload?.callId === "shell-prestart-rejection-1" &&
        (message.type === "tool_call_started" ||
          message.type === "tool_call_completed")
        ? [message]
        : [];
    });
    expect(lifecycle).toEqual([
      expect.objectContaining({
        type: "tool_call_started",
        payload: expect.objectContaining({
          callId: "shell-prestart-rejection-1",
          toolName: "system.bash",
        }),
      }),
      expect.objectContaining({
        type: "tool_call_completed",
        payload: expect.objectContaining({
          callId: "shell-prestart-rejection-1",
          toolName: "system.bash",
          result: expect.stringContaining("is not available"),
          isError: true,
        }),
      }),
    ]);
    expect(shell.bashExecute).not.toHaveBeenCalled();
  });

  it("[managed-thread] denies direct shell while Editor owns the workspace", async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), "agenc-direct-shell-editor-owned-workspace-"),
    );
    const settingsHome = mkdtempSync(
      join(tmpdir(), "agenc-direct-shell-editor-owned-home-"),
    );
    try {
      const harness = makeTopLevelRunner({
        conversationId: "session-direct-shell-editor-owned",
        threadInitialStatus: { status: "pending_init" } as AgentStatus,
        workspaceRoot,
      });
      const shell = configureSessionShellHarness(harness, { settingsHome });
      const settingsAuthority =
        harness.configStore as unknown as CanonicalSettingsAuthority;
      await harness.runner.startAgent({
        objective: "deferred direct shell",
        deferInitialTurn: true,
        unattendedAllow: [],
        unattendedDeny: [],
      });
      harness.forcePermissionContextForTesting(
        createEmptyToolPermissionContext({
          mode: "bypassPermissions",
          isBypassPermissionsModeAvailable: true,
        }),
      );
      const lease = runWithCanonicalSettingsAuthority(settingsAuthority, () =>
        workspaceMutationCoordinators.acquireEditor(workspaceRoot, {
          workspaceRoot,
          editorInstanceId: "editor-before-direct-shell",
        }),
      );

      const result = await harness.runner.executeAgentShell(
        "session-direct-shell-editor-owned",
        {
          sessionId: "session-direct-shell-editor-owned",
          commandId: "shell-editor-owned-1",
          command: "printf blocked-by-editor",
        },
      );

      expect(result).toMatchObject({
        commandId: "shell-editor-owned-1",
        isError: true,
        stdout: "",
        exitCode: null,
      });
      expect(`${result.content}\n${result.stderr}`).toMatch(
        /Tool 'system\.bash' is blocked while this workspace has protected Editor authority/u,
      );
      expect(shell.bashExecute).not.toHaveBeenCalled();
      expect(shell.acquire).not.toHaveBeenCalled();

      await runWithCanonicalSettingsAuthority(settingsAuthority, () =>
        workspaceMutationCoordinators.getOrCreate(workspaceRoot).release({
          workspaceRoot,
          editorInstanceId: lease.editorInstanceId,
          leaseToken: lease.leaseToken,
          epoch: lease.epoch,
        }),
      );
    } finally {
      workspaceMutationCoordinators.clearForTests();
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(settingsHome, { recursive: true, force: true });
    }
  });

  it("[managed-thread] keeps Editor acquisition fenced until direct shell cleanup", async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), "agenc-direct-shell-inflight-workspace-"),
    );
    const settingsHome = mkdtempSync(
      join(tmpdir(), "agenc-direct-shell-inflight-home-"),
    );
    const resultGate = Promise.withResolvers<ToolResult>();
    let execution: Promise<unknown> | undefined;
    try {
      const harness = makeTopLevelRunner({
        conversationId: "session-direct-shell-inflight",
        threadInitialStatus: { status: "pending_init" } as AgentStatus,
        workspaceRoot,
      });
      const shell = configureSessionShellHarness(harness, {
        settingsHome,
        execute: async () => resultGate.promise,
      });
      const settingsAuthority =
        harness.configStore as unknown as CanonicalSettingsAuthority;
      const acquireEditor = (editorInstanceId: string) =>
        runWithCanonicalSettingsAuthority(settingsAuthority, () =>
          workspaceMutationCoordinators.acquireEditor(workspaceRoot, {
            workspaceRoot,
            editorInstanceId,
          }),
        );
      await harness.runner.startAgent({
        objective: "deferred direct shell",
        deferInitialTurn: true,
        unattendedAllow: [],
        unattendedDeny: [],
      });
      harness.forcePermissionContextForTesting(
        createEmptyToolPermissionContext({
          mode: "bypassPermissions",
          isBypassPermissionsModeAvailable: true,
        }),
      );

      execution = harness.runner.executeAgentShell(
        "session-direct-shell-inflight",
        {
          sessionId: "session-direct-shell-inflight",
          commandId: "shell-inflight-1",
          command: "printf held-open",
        },
      );
      await vi.waitFor(() => expect(shell.bashExecute).toHaveBeenCalledOnce());
      expect(() => acquireEditor("editor-during-direct-shell")).toThrow(
        /waiting for active tool 'system\.bash'/u,
      );

      resultGate.resolve({
        content: "shell completed",
        metadata: {
          stdout: "shell completed",
          stderr: "",
          exitCode: 0,
          timedOut: false,
        },
      });
      await expect(execution).resolves.toMatchObject({
        commandId: "shell-inflight-1",
        isError: false,
        stdout: "shell completed",
      });

      const lease = acquireEditor("editor-after-direct-shell");
      expect(lease).toMatchObject({
        workspaceRoot,
        editorInstanceId: "editor-after-direct-shell",
      });
      await runWithCanonicalSettingsAuthority(settingsAuthority, () =>
        workspaceMutationCoordinators.getOrCreate(workspaceRoot).release({
          workspaceRoot,
          editorInstanceId: lease.editorInstanceId,
          leaseToken: lease.leaseToken,
          epoch: lease.epoch,
        }),
      );
    } finally {
      resultGate.resolve({ content: "test cleanup" });
      await execution?.catch(() => {});
      workspaceMutationCoordinators.clearForTests();
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(settingsHome, { recursive: true, force: true });
    }
  });

  it("[managed-thread] deduplicates identical shell command ids and rejects conflicting reuse", async () => {
    const resultGate = Promise.withResolvers<ToolResult>();
    const harness = makeTopLevelRunner({
      conversationId: "session-direct-shell-deduplication",
      threadInitialStatus: { status: "pending_init" } as AgentStatus,
    });
    const shell = configureSessionShellHarness(harness, {
      execute: async () => resultGate.promise,
    });
    await harness.runner.startAgent({
      objective: "deferred direct shell",
      deferInitialTurn: true,
      unattendedAllow: [],
      unattendedDeny: [],
    });
    harness.forcePermissionContextForTesting(
      createEmptyToolPermissionContext({
        mode: "bypassPermissions",
        isBypassPermissionsModeAvailable: true,
      }),
    );
    const params = {
      sessionId: "session-direct-shell-deduplication",
      commandId: "shell-deduplication-1",
      command: "printf once",
    } as const;

    const first = harness.runner.executeAgentShell(
      "session-direct-shell-deduplication",
      params,
    );
    await vi.waitFor(() => expect(shell.bashExecute).toHaveBeenCalledOnce());
    const duplicate = harness.runner.executeAgentShell(
      "session-direct-shell-deduplication",
      params,
    );
    await expect(
      harness.runner.executeAgentShell("session-direct-shell-deduplication", {
        ...params,
        command: "printf conflicting",
      }),
    ).rejects.toThrow(/already used for different content/u);
    expect(shell.bashExecute).toHaveBeenCalledOnce();

    resultGate.resolve({
      content: "once",
      metadata: { stdout: "once", stderr: "", exitCode: 0 },
    });
    const [firstResult, duplicateResult] = await Promise.all([
      first,
      duplicate,
    ]);
    expect(duplicateResult).toEqual(firstResult);
    expect(shell.bashExecute).toHaveBeenCalledOnce();
  });

  it("[managed-thread] rejects direct shell while the session owns an active model turn", async () => {
    const harness = makeTopLevelRunner({
      conversationId: "session-direct-shell-active-turn",
      threadInitialStatus: { status: "pending_init" } as AgentStatus,
      scopedTurnCancellation: true,
    });
    const shell = configureSessionShellHarness(harness);
    await harness.runner.startAgent({
      objective: "deferred direct shell",
      deferInitialTurn: true,
      unattendedAllow: [],
      unattendedDeny: [],
    });
    harness.setActiveTurn("active-model-turn");

    await expect(
      harness.runner.executeAgentShell("session-direct-shell-active-turn", {
        sessionId: "session-direct-shell-active-turn",
        commandId: "shell-active-turn-1",
        command: "printf blocked",
      }),
    ).rejects.toThrow(/active or queued model turn/u);
    expect(shell.acquire).not.toHaveBeenCalled();
    expect(shell.bashExecute).not.toHaveBeenCalled();
    expect(harness.control.sendInput).not.toHaveBeenCalled();
  });

  it("[managed-thread] admits direct shell when canonical runtime state is idle despite a stale thread status", async () => {
    const harness = makeTopLevelRunner({
      conversationId: "session-direct-shell-thread-running",
      threadInitialStatus: { status: "pending_init" } as AgentStatus,
    });
    const shell = configureSessionShellHarness(harness);
    await harness.runner.startAgent({
      objective: "deferred direct shell",
      deferInitialTurn: true,
      unattendedAllow: [],
      unattendedDeny: [],
    });
    harness.stub.pushStatus({
      status: "running",
      turnId: "untracked-model-turn",
      startedAtMs: 1,
    });
    harness.forcePermissionContextForTesting(
      createEmptyToolPermissionContext({
        mode: "bypassPermissions",
        isBypassPermissionsModeAvailable: true,
      }),
    );

    await expect(
      harness.runner.executeAgentShell("session-direct-shell-thread-running", {
        sessionId: "session-direct-shell-thread-running",
        commandId: "shell-thread-running-1",
        command: "printf admitted",
      }),
    ).resolves.toMatchObject({
      commandId: "shell-thread-running-1",
      isError: false,
      stdout: "shell stdout",
    });
    expect(shell.acquire).toHaveBeenCalledOnce();
    expect(shell.bashExecute).toHaveBeenCalledOnce();
    expect(harness.control.sendInput).not.toHaveBeenCalled();
  });

  it("[managed-thread] queues direct shell until a cancelled message submission finishes cleanup", async () => {
    const messageStarted = Promise.withResolvers<void>();
    const releaseMessageCleanup = Promise.withResolvers<void>();
    const harness = makeTopLevelRunner({
      conversationId: "session-direct-shell-after-cancel",
      threadInitialStatus: { status: "pending_init" } as AgentStatus,
      scopedTurnCancellation: true,
    });
    const shell = configureSessionShellHarness(harness);
    harness.control.sendInput.mockImplementationOnce(async () => {
      harness.setActiveTurn("turn-direct-shell-cancelled");
      harness.stub.pushStatus({
        status: "running",
        turnId: "turn-direct-shell-cancelled",
        startedAtMs: 1,
      });
      harness.session.emit({
        id: "turn-direct-shell-cancelled",
        msg: {
          type: "turn_started",
          payload: { turnId: "turn-direct-shell-cancelled" },
        },
      });
      messageStarted.resolve();
      await releaseMessageCleanup.promise;
      harness.stub.pushStatus({
        status: "interrupted",
        turnId: "turn-direct-shell-cancelled",
        endedAtMs: 2,
        reason: "user_cancel",
      } as AgentStatus);
    });

    await harness.runner.startAgent({
      objective: "deferred direct shell after cancellation",
      deferInitialTurn: true,
      unattendedAllow: [],
      unattendedDeny: [],
    });
    harness.forcePermissionContextForTesting(
      createEmptyToolPermissionContext({
        mode: "bypassPermissions",
        isBypassPermissionsModeAvailable: true,
      }),
    );
    const message = harness.runner.submitAgentMessage(
      "session-direct-shell-after-cancel",
      {
        sessionId: "session-direct-shell-after-cancel",
        content: "cancel this turn",
        originalContent: "cancel this turn",
        messageId: "message-direct-shell-cancelled",
        streamId: "stream-direct-shell-cancelled",
        acceptedAt: "2026-08-27T00:00:00.000Z",
      },
    );
    await messageStarted.promise;

    await expect(
      harness.runner.interruptAgentTurnIfMatches(
        "session-direct-shell-after-cancel",
        "user_cancel",
        "turn-direct-shell-cancelled",
      ),
    ).resolves.toEqual({
      cancelled: true,
      activeTurnId: "turn-direct-shell-cancelled",
    });
    harness.session.emitPhaseEvent({
      type: "turn_complete",
      content: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stopReason: "cancelled",
    });
    harness.session.emit({
      id: "turn-direct-shell-aborted",
      msg: {
        type: "turn_aborted",
        payload: {
          turnId: "turn-direct-shell-cancelled",
          reason: "user_cancel",
        },
      },
    });
    expect(harness.stub.thread.status()).toMatchObject({ status: "running" });

    const execution = harness.runner.executeAgentShell(
      "session-direct-shell-after-cancel",
      {
        sessionId: "session-direct-shell-after-cancel",
        commandId: "shell-after-cancel-1",
        command: "printf after-cancel",
      },
    );
    void execution.catch(() => {});
    expect(shell.bashExecute).not.toHaveBeenCalled();

    releaseMessageCleanup.resolve();
    await expect(message).resolves.toMatchObject({
      disposition: "started",
      terminal: { code: 130 },
    });
    await expect(execution).resolves.toMatchObject({
      commandId: "shell-after-cancel-1",
      isError: false,
      stdout: "shell stdout",
    });
    expect(shell.bashExecute).toHaveBeenCalledOnce();
  });

  it("[managed-thread] forwards direct-shell aborts into the admitted tool dispatch", async () => {
    const reachedTool = Promise.withResolvers<AbortSignal>();
    const harness = makeTopLevelRunner({
      conversationId: "session-direct-shell-abort",
      threadInitialStatus: { status: "pending_init" } as AgentStatus,
    });
    const shell = configureSessionShellHarness(harness, {
      execute: async (args) => {
        const signal = (args as { readonly __abortSignal?: AbortSignal })
          .__abortSignal;
        if (signal === undefined) {
          throw new Error("direct shell dispatch omitted its abort signal");
        }
        reachedTool.resolve(signal);
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        return {
          content: "cancelled before the shell changed state",
          isError: true,
          effectDisposition: {
            disposition: "confirmed_no_effect",
            evidenceKind: "provider_receipt",
            evidenceRef: "test:direct-shell-abort",
            evidenceSha256: "a".repeat(64),
          },
        };
      },
    });
    await harness.runner.startAgent({
      objective: "deferred direct shell",
      deferInitialTurn: true,
      unattendedAllow: [],
      unattendedDeny: [],
    });
    harness.forcePermissionContextForTesting(
      createEmptyToolPermissionContext({
        mode: "bypassPermissions",
        isBypassPermissionsModeAvailable: true,
      }),
    );
    const controller = new AbortController();
    const execution = harness.runner.executeAgentShell(
      "session-direct-shell-abort",
      {
        sessionId: "session-direct-shell-abort",
        commandId: "shell-abort-1",
        command: "printf abort",
      },
      controller.signal,
    );
    const dispatchSignal = await reachedTool.promise;
    const reason = new Error("operator aborted direct shell");
    controller.abort(reason);

    await expect(execution).resolves.toMatchObject({
      commandId: "shell-abort-1",
      isError: true,
      content: expect.stringContaining("operator aborted direct shell"),
    });
    expect(dispatchSignal.aborted).toBe(true);
    expect(dispatchSignal.reason).toBe(reason);
    expect(shell.bashExecute).toHaveBeenCalledOnce();
    expect(shell.markDispatched).toHaveBeenCalledOnce();
    expect(harness.stub.thread.submit).not.toHaveBeenCalled();
    expect(harness.control.sendInput).not.toHaveBeenCalled();
  });

  it("[managed-thread] keeps direct-shell errors session-scoped and accepts an immediate follow-up command", async () => {
    const agentId = "session-direct-shell-error-scope";
    const harness = makeTopLevelRunner({
      conversationId: agentId,
      threadInitialStatus: {
        status: "idle",
        turnId: "turn-direct-shell-idle",
        endedAtMs: 1,
      } as AgentStatus,
    });
    let executionCount = 0;
    const shell = configureSessionShellHarness(harness, {
      execute: async () => {
        executionCount += 1;
        if (executionCount === 1) {
          harness.session.emit({
            id: "shell-error-scope-1",
            msg: {
              type: "error",
              payload: {
                cause: "aborted",
                message: "operator cancelled direct shell",
              },
            },
          });
          return {
            content: "operator cancelled direct shell",
            isError: true,
            effectDisposition: {
              disposition: "confirmed_no_effect",
              evidenceKind: "provider_receipt",
              evidenceRef: "test:direct-shell-error-scope",
              evidenceSha256: "b".repeat(64),
            },
          };
        }
        return {
          content: "second command succeeded",
          metadata: {
            stdout: "second command succeeded",
            stderr: "",
            exitCode: 0,
            timedOut: false,
          },
        };
      },
    });
    const emitted: JsonObject[] = [];

    await harness.runner.startAgent({
      objective: "deferred direct shell",
      deferInitialTurn: true,
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await harness.runner.attachAgentSessionEvents(agentId, {
      sessionId: agentId,
      emit: async (notification) => {
        emitted.push(notification);
      },
    });
    emitted.length = 0;
    harness.forcePermissionContextForTesting(
      createEmptyToolPermissionContext({
        mode: "bypassPermissions",
        isBypassPermissionsModeAvailable: true,
      }),
    );

    const first = harness.runner.executeAgentShell(agentId, {
      sessionId: agentId,
      commandId: "shell-error-scope-1",
      command: "sleep 10",
    });

    await expect(first).resolves.toMatchObject({
      commandId: "shell-error-scope-1",
      isError: true,
      content: expect.stringContaining("operator cancelled direct shell"),
    });
    await vi.waitFor(() => {
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.session_event",
          params: expect.objectContaining({
            agentId,
            event: expect.objectContaining({
              id: "shell-error-scope-1",
              type: "error",
              payload: expect.objectContaining({
                message: "operator cancelled direct shell",
              }),
            }),
          }),
        }),
      );
    });
    expect(
      emitted.filter(
        (notification) => notification.method === "event.agent_status",
      ),
    ).toEqual([]);
    await expect(
      harness.runner.getAgentSnapshot(agentId),
    ).resolves.toMatchObject({ status: "idle" });

    const second = await harness.runner.executeAgentShell(agentId, {
      sessionId: agentId,
      commandId: "shell-error-scope-2",
      command: "printf second-command",
    });
    expect(second.content).toBe("second command succeeded");
    expect(second).toMatchObject({
      commandId: "shell-error-scope-2",
      isError: false,
      stdout: "second command succeeded",
    });
    expect(shell.bashExecute).toHaveBeenCalledTimes(2);
    await expect(
      harness.runner.getAgentSnapshot(agentId),
    ).resolves.toMatchObject({ status: "idle" });
  });

  it("[managed-thread] scopes model input across an ambiguous fallback-session boundary", async () => {
    const target = makeTopLevelRunner({
      conversationId: "session-model-scope-target",
      threadInitialStatus: { status: "pending_init" } as AgentStatus,
    });
    const other = makeTopLevelRunner({
      conversationId: "session-model-scope-other",
      threadInitialStatus: { status: "pending_init" } as AgentStatus,
    });
    const targetSession = target.session as unknown as Session;
    const otherSession = other.session as unknown as Session;
    const enteredSendInput = Promise.withResolvers<void>();
    const releaseSendInput = Promise.withResolvers<void>();
    const scopedSessions: Array<Session | null> = [];
    target.control.sendInput.mockImplementation(async () => {
      scopedSessions.push(peekScopedRuntimeSession());
      enteredSendInput.resolve();
      await releaseSendInput.promise;
      scopedSessions.push(peekScopedRuntimeSession());
      await Promise.resolve();
      scopedSessions.push(peekScopedRuntimeSession());
    });

    clearCurrentRuntimeSession();
    try {
      await target.runner.startAgent({
        objective: "deferred target session",
        deferInitialTurn: true,
        unattendedAllow: [],
        unattendedDeny: [],
      });
      await other.runner.startAgent({
        objective: "deferred other session",
        deferInitialTurn: true,
        unattendedAllow: [],
        unattendedDeny: [],
      });
      setCurrentRuntimeSession(targetSession);
      setCurrentRuntimeSession(otherSession);

      const submission = target.runner.submitAgentMessage(
        "session-model-scope-target",
        {
          sessionId: "session-model-scope-target",
          content: "continue in the target session",
          originalContent: "continue in the target session",
          messageId: "message-model-scope-target",
          streamId: "stream-model-scope-target",
          acceptedAt: "2026-08-27T00:00:00.000Z",
        },
      );
      await enteredSendInput.promise;
      expect(peekScopedRuntimeSession()).toBeNull();
      releaseSendInput.resolve();

      await expect(submission).resolves.toMatchObject({
        disposition: "started",
        terminal: { code: 0 },
      });
      expect(scopedSessions).toEqual([
        targetSession,
        targetSession,
        targetSession,
      ]);
    } finally {
      releaseSendInput.resolve();
      clearCurrentRuntimeSession();
    }
  });

  it("fails closed when a skeletal session lacks canonical runtime-settings journal support", async () => {
    const { runner, shutdown } = makeTopLevelRunner({
      conversationId: "session-without-runtime-settings-journal",
      canonicalRuntimeSettings: false,
    });

    await expect(
      runner.startAgent({ objective: "reject ephemeral settings authority" }),
    ).rejects.toThrow(/canonical .*runtime-settings journal/u);

    expect(shutdown).toHaveBeenCalledTimes(1);
    await expect(
      runner.getAgentSnapshot("session-without-runtime-settings-journal"),
    ).resolves.toBeNull();
  });

  it("clears stale daemon-start provider state with the client snapshot", async () => {
    const { runner, bootstrap } = makeTopLevelRunner({
      conversationId: "session-client-provider-snapshot",
      env: {
        AGENC_PROVIDER: "openai",
        AGENC_MODEL: "stale-daemon-model",
        OPENAI_BASE_URL: "https://stale-daemon.example/v1",
        XAI_API_KEY: "stale-daemon-key",
        AGENC_CREDENTIAL_DOCS_MCP: "stale-daemon-mcp-secret",
        PATH: "/daemon/bin",
      },
    });

    await runner.startAgent({
      objective: "use the client provider snapshot",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
      runtimeOptions: resolveAgentRuntimeOptions({}),
      envOverrides: collectDaemonClientEnvOverrides({
        PATH: "/client/bin",
      }),
    });

    expect(bootstrap).toHaveBeenCalledOnce();
    const runtimeEnvironment = vi.mocked(bootstrap).mock.calls[0]?.[0].env;
    expect(runtimeEnvironment).toMatchObject({ PATH: "/client/bin" });
    expect(runtimeEnvironment).not.toHaveProperty("AGENC_PROVIDER");
    expect(runtimeEnvironment).not.toHaveProperty("AGENC_MODEL");
    expect(runtimeEnvironment).not.toHaveProperty("OPENAI_BASE_URL");
    expect(runtimeEnvironment).not.toHaveProperty("XAI_API_KEY");
    expect(runtimeEnvironment).not.toHaveProperty("AGENC_CREDENTIAL_DOCS_MCP");
  });

  it("waits for the exact terminal generation cleanup before explicit restore", async () => {
    let releaseShutdown!: () => void;
    const shutdownBlocked = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    const bootstrapShutdown = vi.fn(() => shutdownBlocked);
    const { runner, stub, bootstrap } = makeTopLevelRunner({
      conversationId: "session-generation-race",
      bootstrapShutdown,
    });
    await runner.startAgent({
      objective: "retained objective",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });
    stub.pushStatus({
      status: "completed",
      turnId: "turn-generation-race",
      endedAtMs: 2,
      lastMessage: "done",
    });
    await vi.waitFor(() => expect(bootstrapShutdown).toHaveBeenCalledOnce());

    const restoring = runner.restoreAgent({
      agentId: "session-generation-race",
      objective: "retained objective",
      reopenTerminalRun: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(bootstrap).toHaveBeenCalledOnce();
    await expect(
      runner.restoreAgent({
        agentId: "session-generation-race",
        objective: "retained objective",
        reopenTerminalRun: true,
      }),
    ).rejects.toThrow("already being restored");

    stub.pushStatus({
      status: "running",
      turnId: "turn-restored-generation",
      startedAtMs: 3,
    });
    releaseShutdown();
    await expect(restoring).resolves.toBe(true);
    expect(bootstrap).toHaveBeenCalledTimes(2);
    await expect(
      runner.getAgentSnapshot("session-generation-race"),
    ).resolves.not.toBeNull();
  });

  it("retires a failed restore generation so an exact retry can proceed", async () => {
    let harness: ReturnType<typeof makeTopLevelRunner>;
    let hydrationAttempts = 0;
    const hydrateStateWith = vi.fn(
      async (apply: (state: { history?: unknown }) => void | Promise<void>) => {
        hydrationAttempts += 1;
        if (hydrationAttempts === 1) {
          throw new Error("injected recovered-history hydration failure");
        }
        await apply({ history: [] });
      },
    );
    const bootstrapShutdown = vi.fn(async () => {
      harness.stub.pushStatus({
        status: "completed",
        turnId: "turn-failed-restore",
        endedAtMs: 2,
        lastMessage: "retired",
      });
    });
    harness = makeTopLevelRunner({
      conversationId: "session-restore-hydration-retry",
      hydrateStateWith,
      bootstrapShutdown,
    });
    const params = {
      agentId: "session-restore-hydration-retry",
      objective: "retained objective",
      explicitColdResume: true,
      initialMessages: [{ role: "user" as const, content: "retained" }],
    };

    await expect(harness.runner.restoreAgent(params)).rejects.toThrow(
      "injected recovered-history hydration failure",
    );
    await expect(
      harness.runner.getAgentSnapshot("session-restore-hydration-retry"),
    ).resolves.toBeNull();
    expect(
      harness.session.emit.mock.calls.some(
        ([event]) =>
          (event as { msg?: { type?: unknown } }).msg?.type === "run_terminal",
      ),
    ).toBe(false);
    expect(harness.shutdown).toHaveBeenCalledOnce();

    harness.stub.pushStatus({
      status: "running",
      turnId: "turn-restored-retry",
      startedAtMs: 3,
    });
    await expect(harness.runner.restoreAgent(params)).resolves.toBe(true);
    await expect(
      harness.runner.getAgentSnapshot("session-restore-hydration-retry"),
    ).resolves.not.toBeNull();
    expect(hydrateStateWith).toHaveBeenCalledTimes(3);
  });

  it("keeps the hydration failure primary when restore cleanup also fails", async () => {
    const harness = makeTopLevelRunner({
      conversationId: "session-restore-hydration-cleanup-error",
      hydrateStateWith: vi.fn(async () => {
        throw new Error("primary hydration failure");
      }),
      bootstrapShutdown: vi.fn(async () => {
        throw new Error("secondary shutdown failure");
      }),
    });

    const error = await harness.runner
      .restoreAgent({
        agentId: "session-restore-hydration-cleanup-error",
        objective: "retained objective",
        explicitColdResume: true,
        initialMessages: [{ role: "user", content: "retained" }],
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toMatchObject({
      message: "primary hydration failure",
    });
    expect(
      harness.session.emit.mock.calls.some(
        ([event]) =>
          (event as { msg?: { type?: unknown } }).msg?.type === "run_terminal",
      ),
    ).toBe(false);
    await expect(
      harness.runner.getAgentSnapshot(
        "session-restore-hydration-cleanup-error",
      ),
    ).resolves.toBeNull();
  });

  it("defers startup side effects while restoring a suspended generation", async () => {
    const { runner, bootstrap } = makeTopLevelRunner({
      conversationId: "session-suspended-side-effects",
    });

    await expect(
      runner.restoreAgent({
        agentId: "session-suspended-side-effects",
        objective: "retained objective",
        resumeSuspendedRun: true,
        suspendedResumeReason: "daemon_startup_restore",
      }),
    ).resolves.toBe(true);

    expect(bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeSuspendedConversation: true,
        suspendedResumeReason: "daemon_startup_restore",
        deferSessionStartHooks: true,
        deferAgentStartupSideEffects: true,
      }),
    );
  });

  it.each([
    {
      label: "without an override",
      permissionMode: undefined,
      expectedMode: "default" as const,
      expectedSettingsEvents: 1,
    },
    {
      label: "with an explicit plan override",
      permissionMode: "plan" as const,
      expectedMode: "plan" as const,
      expectedSettingsEvents: 2,
    },
  ])(
    "keeps a fresh default run cold-resumable $label",
    async ({ permissionMode, expectedMode, expectedSettingsEvents }) => {
      const runId = `session-default-cold-${expectedMode}`;
      const harness = makeTopLevelRunner({
        conversationId: runId,
        canonicalRuntimeSettings: true,
      });
      const baseline: RunRuntimeSettingsSnapshot = {
        permissionMode: "default",
        prePlanMode: null,
        autoModeActive: false,
        autoModeAvailable: false,
        bypassPermissionsModeAvailable: false,
        bypassPermissionsWorkspace: null,
        bypassPermissionsConsentWorkspace: null,
        model: "base-model",
        provider: "grok",
        profile: null,
        reasoningEffort: null,
        modelVerbosity: null,
        serviceTier: null,
        hooksDisabled: false,
      };

      await harness.runner.startAgent({ objective: "stay cold resumable" });
      const initialSettings = harness.rolloutItems.find(
        (item) =>
          (item as { payload?: { msg?: { type?: unknown } } }).payload?.msg
            ?.type === "run_runtime_settings_changed",
      ) as
        | {
            payload: {
              eventId: string;
              msg: { payload: RunRuntimeSettingsSnapshot };
            };
          }
        | undefined;
      expect(initialSettings?.payload.msg.payload).toMatchObject(baseline);
      expect(harness.permissionModeRegistry.current().mode).toBe("unattended");

      await vi.waitFor(() =>
        expect(harness.stub.thread.submit).toHaveBeenCalledOnce(),
      );
      await harness.stub.thread.submit.mock.results[0]?.value;
      await Promise.resolve();
      harness.stub.pushStatus({
        status: "idle",
        turnId: "turn-before-cold-resume",
        endedAtMs: 1,
      });
      const suspended =
        await harness.runner.suspendIdleAgentForDaemonShutdown(runId);
      expect(suspended.disposition).toBe("suspended");
      if (suspended.disposition !== "suspended") {
        throw new Error("expected a suspended run");
      }
      harness.session.emit({
        eventId: `run-resumed:${runId}:1:test`,
        id: `run-resumed:${runId}:1:test`,
        msg: {
          type: "run_resumed",
          payload: {
            runId,
            epoch: 1,
            suspensionEventId: suspended.suspension.eventId,
            reason: "explicit_continue",
            resumedAt: "2026-05-09T00:01:00.000Z",
          },
        },
      });

      await expect(
        harness.runner.restoreAgent({
          agentId: runId,
          objective: "stay cold resumable",
          explicitColdResume: true,
          resumeSuspendedRun: true,
          suspendedResumeReason: "explicit_continue",
          runtimeSettings: baseline,
          ...(permissionMode !== undefined ? { permissionMode } : {}),
        }),
      ).resolves.toBe(true);

      const settingsEvents = harness.rolloutItems.flatMap((item) => {
        const event = item as {
          payload?: {
            eventId?: string;
            msg?: { type?: unknown; payload?: Record<string, unknown> };
          };
        };
        return event.payload?.msg?.type === "run_runtime_settings_changed"
          ? [event.payload]
          : [];
      });
      expect(settingsEvents).toHaveLength(expectedSettingsEvents);
      expect(settingsEvents[0]?.msg?.payload).toMatchObject(baseline);
      if (permissionMode !== undefined) {
        expect(settingsEvents[1]?.msg?.payload).toMatchObject({
          permissionMode,
          prePlanMode: "default",
          previousSettingsEventId: initialSettings?.payload.eventId,
          reason: "permission_mode_changed",
        });
      }
      expect(harness.permissionModeRegistry.current().mode).toBe(expectedMode);
    },
  );

  it("binds explicit bypass startup authority to the exact durable workspace", async () => {
    const runId = "session-explicit-bypass-startup";
    const harness = makeTopLevelRunner({
      conversationId: runId,
      canonicalRuntimeSettings: true,
    });
    await harness.permissionModeRegistry.update(
      createEmptyToolPermissionContext({
        mode: "bypassPermissions",
        isBypassPermissionsModeAvailable: true,
      }),
    );

    await harness.runner.startAgent({
      objective: "honor explicit bypass",
      permissionMode: "bypassPermissions",
    });

    expect(harness.permissionModeRegistry.current()).toMatchObject({
      mode: "bypassPermissions",
      bypassPermissionsAcceptedIn: [process.cwd()],
    });
    const settingsEvents = harness.rolloutItems.flatMap((item) => {
      const event = item as {
        payload?: { msg?: { type?: unknown; payload?: unknown } };
      };
      return event.payload?.msg?.type === "run_runtime_settings_changed"
        ? [event.payload.msg.payload]
        : [];
    });
    expect(settingsEvents).toHaveLength(1);
    expect(settingsEvents[0]).toMatchObject({
      permissionMode: "bypassPermissions",
      bypassPermissionsWorkspace: process.cwd(),
    });
  });

  it("uses one canonical workspace identity when startup uses a symlink spelling", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-runner-workspace-"));
    try {
      const workspace = join(root, "workspace");
      const alias = join(root, "workspace-alias");
      mkdirSync(workspace);
      symlinkSync(workspace, alias, "dir");
      const canonicalWorkspace = realpathSync(workspace);
      const runId = "session-symlink-bypass-startup";
      const harness = makeTopLevelRunner({
        conversationId: runId,
        canonicalRuntimeSettings: true,
        workspaceRoot: alias,
      });
      await harness.permissionModeRegistry.update(
        createEmptyToolPermissionContext({
          mode: "bypassPermissions",
          isBypassPermissionsModeAvailable: true,
        }),
      );

      await harness.runner.startAgent({
        objective: "honor canonical bypass",
        permissionMode: "bypassPermissions",
      });

      expect(harness.permissionModeRegistry.current()).toMatchObject({
        mode: "bypassPermissions",
        bypassPermissionsAcceptedIn: [canonicalWorkspace],
      });
      const settingsEvents = harness.rolloutItems.flatMap((item) => {
        const event = item as {
          payload?: { msg?: { type?: unknown; payload?: unknown } };
        };
        return event.payload?.msg?.type === "run_runtime_settings_changed"
          ? [event.payload.msg.payload]
          : [];
      });
      expect(settingsEvents).toHaveLength(1);
      expect(settingsEvents[0]).toMatchObject({
        permissionMode: "bypassPermissions",
        bypassPermissionsWorkspace: canonicalWorkspace,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("captures and restores bypass authority against the live rebased broker cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-runner-rebase-cwd-"));
    try {
      const originalWorkspace = join(root, "original");
      const rebasedWorkspace = join(root, "worktree");
      mkdirSync(originalWorkspace);
      mkdirSync(rebasedWorkspace);
      const runId = "session-rebased-bypass-authority";
      const harness = makeTopLevelRunner({
        conversationId: runId,
        canonicalRuntimeSettings: true,
        workspaceRoot: originalWorkspace,
      });
      await harness.runner.startAgent({
        objective: "carry authority into the worktree",
      });

      await transitionSandboxExecutionBroker(
        harness.sandboxExecutionBroker,
        rebasedWorkspace,
      );
      await expect(
        harness.runner.setAgentPermissionMode(runId, {
          sessionId: runId,
          mode: "bypassPermissions",
          bypassAuthority: "operator_tool_approval",
        }),
      ).resolves.toMatchObject({ applied: true, mode: "bypassPermissions" });

      const captured = await harness.runner.getAgentSnapshot(runId);
      const settings = captured?.runtimeSettings;
      if (settings === undefined) {
        throw new Error("expected canonical runtime settings after rebase");
      }
      expect(settings).toMatchObject({
        bypassPermissionsWorkspace: rebasedWorkspace,
        bypassPermissionsConsentWorkspace: rebasedWorkspace,
      });
      expect(JSON.stringify(settings)).not.toContain(originalWorkspace);
      expect(
        recordedRuntimeSettingsEvents(harness.rolloutItems).at(-1)?.msg
          ?.payload,
      ).toMatchObject({
        bypassPermissionsWorkspace: rebasedWorkspace,
        bypassPermissionsConsentWorkspace: rebasedWorkspace,
      });

      harness.persistedBypassConsent.add(rebasedWorkspace);
      harness.stub.pushStatus({
        status: "idle",
        turnId: "turn-before-rebased-restore",
        endedAtMs: 1,
      });
      const suspended =
        await harness.runner.suspendIdleAgentForDaemonShutdown(runId);
      expect(suspended.disposition).toBe("suspended");
      if (suspended.disposition !== "suspended") {
        throw new Error("expected rebased run to suspend");
      }
      harness.session.emit({
        eventId: `run-resumed:${runId}:1:test`,
        id: `run-resumed:${runId}:1:test`,
        msg: {
          type: "run_resumed",
          payload: {
            runId,
            epoch: 1,
            suspensionEventId: suspended.suspension.eventId,
            reason: "explicit_continue",
            resumedAt: "2026-05-09T00:01:00.000Z",
          },
        },
      });

      await expect(
        harness.runner.restoreAgent({
          agentId: runId,
          objective: "carry authority into the worktree",
          explicitColdResume: true,
          resumeSuspendedRun: true,
          suspendedResumeReason: "explicit_continue",
          runtimeSettings: settings,
        }),
      ).resolves.toBe(true);
      expect(harness.permissionModeRegistry.current()).toMatchObject({
        mode: "bypassPermissions",
        bypassPermissionsAcceptedIn: [rebasedWorkspace],
      });
      expect(
        harness.permissionModeRegistry.current().bypassPermissionsAcceptedIn,
      ).not.toContain(originalWorkspace);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "active bypass",
      permissionMode: "bypassPermissions" as const,
      consentPresent: true,
    },
    {
      label: "active bypass after consent revocation",
      permissionMode: "bypassPermissions" as const,
      consentPresent: false,
    },
    {
      label: "plan mode with bypass restore",
      permissionMode: "plan" as const,
      consentPresent: true,
    },
    {
      label: "plan mode with revoked bypass restore",
      permissionMode: "plan" as const,
      consentPresent: false,
    },
  ])(
    "restores $label only while exact-cwd consent remains persisted",
    async ({ label, permissionMode, consentPresent }) => {
      const runId = `session-consent-restore-${label.replaceAll(" ", "-")}`;
      const workspace = process.cwd();
      const settings = bypassRestoreSettings(permissionMode, workspace);
      const rolloutItems = [runtimeSettingsRolloutItem(runId, settings)];
      const harness = makeTopLevelRunner({
        conversationId: runId,
        canonicalRuntimeSettings: true,
        rolloutItems,
        persistedBypassConsent: [workspace],
      });
      if (!consentPresent) harness.persistedBypassConsent.delete(workspace);

      const restoring = harness.runner.restoreAgent({
        agentId: runId,
        objective: "restore exact-cwd permission authority",
        explicitColdResume: true,
        runtimeSettings: settings,
      });

      if (!consentPresent) {
        await expect(restoring).rejects.toThrow(
          /requires persisted exact-cwd consent/u,
        );
        const bootstrapArgv =
          vi.mocked(harness.bootstrap).mock.calls[0]?.[0].argv ?? [];
        expect(bootstrapArgv).not.toContain(
          "--dangerously-bypass-approvals-and-sandbox",
        );
        expect(
          harness.permissionModeRegistry.current()
            .bypassPermissionsAcceptedIn ?? [],
        ).toEqual([]);
        return;
      }

      await expect(restoring).resolves.toBe(true);
      expect(harness.stateRepository.reload).toHaveBeenCalled();
      expect(harness.permissionModeRegistry.current()).toMatchObject({
        mode: permissionMode,
        ...(permissionMode === "plan"
          ? { prePlanMode: "bypassPermissions" }
          : {}),
        bypassPermissionsAcceptedIn: [workspace],
      });
    },
  );

  it("captures inactive auto and exact-cwd durable bypass authority", async () => {
    const runId = "session-inactive-permission-capabilities";
    const workspace = process.cwd();
    const harness = makeTopLevelRunner({
      conversationId: runId,
      canonicalRuntimeSettings: true,
      persistedBypassConsent: [workspace],
    });
    await harness.permissionModeRegistry.update(
      createEmptyToolPermissionContext({
        mode: "default",
        isAutoModeAvailable: true,
        isBypassPermissionsModeAvailable: false,
      }),
    );

    await harness.runner.startAgent({
      objective: "retain inactive permission capabilities",
      cwd: workspace,
    });

    const initialSettings = harness.rolloutItems.find(
      (item) =>
        (item as { payload?: { msg?: { type?: unknown } } }).payload?.msg
          ?.type === "run_runtime_settings_changed",
    ) as {
      readonly payload?: { readonly msg?: { readonly payload?: unknown } };
    };
    expect(initialSettings.payload?.msg?.payload).toMatchObject({
      permissionMode: "default",
      autoModeActive: false,
      autoModeAvailable: true,
      bypassPermissionsModeAvailable: true,
      bypassPermissionsWorkspace: null,
      bypassPermissionsConsentWorkspace: workspace,
    });
    expect(harness.stateRepository.reload).toHaveBeenCalled();
  });

  it("does not recreate revoked inactive bypass consent from the journal projection", async () => {
    const runId = "session-revoked-inactive-bypass-consent";
    const workspace = process.cwd();
    const settings: RunRuntimeSettingsSnapshot = {
      permissionMode: "default",
      prePlanMode: null,
      autoModeActive: false,
      autoModeAvailable: true,
      bypassPermissionsModeAvailable: true,
      bypassPermissionsWorkspace: null,
      bypassPermissionsConsentWorkspace: workspace,
      model: "base-model",
      provider: "grok",
      profile: null,
      reasoningEffort: null,
      modelVerbosity: null,
      serviceTier: null,
      hooksDisabled: false,
    };
    const rolloutItems = [runtimeSettingsRolloutItem(runId, settings)];
    const harness = makeTopLevelRunner({
      conversationId: runId,
      canonicalRuntimeSettings: true,
      rolloutItems,
      env: { XAI_API_KEY: "auto-remains-available" },
    });

    await expect(
      harness.runner.restoreAgent({
        agentId: runId,
        objective: "do not restore revoked inactive consent",
        explicitColdResume: true,
        runtimeSettings: settings,
      }),
    ).resolves.toBe(true);

    expect(harness.permissionModeRegistry.current()).toMatchObject({
      mode: "default",
      isAutoModeAvailable: true,
      isBypassPermissionsModeAvailable: false,
      bypassPermissionsAcceptedIn: [],
    });
    const settingsEvents = rolloutItems.flatMap((item) => {
      const event = item as {
        readonly payload?: {
          readonly msg?: {
            readonly type?: unknown;
            readonly payload?: unknown;
          };
        };
      };
      return event.payload?.msg?.type === "run_runtime_settings_changed"
        ? [event.payload.msg.payload]
        : [];
    });
    expect(settingsEvents).toHaveLength(2);
    expect(settingsEvents.at(-1)).toMatchObject({
      previousSettingsEventId:
        "runtime-settings:session-revoked-inactive-bypass-consent:initial",
      reason: "config_applied",
      autoModeAvailable: true,
      bypassPermissionsModeAvailable: false,
      bypassPermissionsConsentWorkspace: null,
    });
    expect(harness.stateRepository.reload).toHaveBeenCalled();
  });

  it("rejects persisted bypass restore when managed policy disables it", async () => {
    const runId = "session-consent-restore-policy-disabled";
    const workspace = process.cwd();
    const settings = bypassRestoreSettings("bypassPermissions", workspace);
    const harness = makeTopLevelRunner({
      conversationId: runId,
      canonicalRuntimeSettings: true,
      rolloutItems: [runtimeSettingsRolloutItem(runId, settings)],
      persistedBypassConsent: [workspace],
    });
    await harness.permissionModeRegistry.update(
      createEmptyToolPermissionContext({
        bypassPermissionsModeDisabledByPolicy: true,
      }),
    );

    await expect(
      harness.runner.restoreAgent({
        agentId: runId,
        objective: "restore managed permission authority",
        explicitColdResume: true,
        runtimeSettings: settings,
      }),
    ).rejects.toThrow(/disabled by managed policy/u);
    expect(harness.stateRepository.reload).toHaveBeenCalled();
  });

  it("durably applies explicit restore overrides after the canonical settings baseline", async () => {
    const baseline = {
      permissionMode: "default" as const,
      prePlanMode: null,
      autoModeActive: false,
      autoModeAvailable: true,
      bypassPermissionsModeAvailable: false,
      bypassPermissionsWorkspace: null,
      bypassPermissionsConsentWorkspace: null,
      model: "base-model",
      provider: "grok",
      profile: null,
      reasoningEffort: null,
      modelVerbosity: null,
      serviceTier: null,
      hooksDisabled: false,
    };
    const rolloutItems: unknown[] = [
      {
        type: "event_msg",
        payload: {
          id: "runtime-settings-baseline",
          eventId: "runtime-settings-baseline",
          seq: 1,
          msg: {
            type: "run_runtime_settings_changed",
            payload: {
              runId: "session-settings-override",
              epoch: 1,
              previousSettingsEventId: null,
              rollbackOfSettingsEventId: null,
              reason: "initial",
              changedAt: "2026-05-09T00:00:00.000Z",
              ...baseline,
            },
          },
        },
      },
    ];
    const harness = makeTopLevelRunner({
      conversationId: "session-settings-override",
      rolloutItems,
      canonicalRuntimeSettings: true,
      env: { XAI_API_KEY: "auto-remains-available" },
    });

    await expect(
      harness.runner.restoreAgent({
        agentId: "session-settings-override",
        objective: "resume with explicit settings",
        explicitColdResume: true,
        runtimeSettings: baseline,
        model: "override-model",
        provider: "openai",
        profile: "override-profile",
        permissionMode: "plan",
      }),
    ).resolves.toBe(true);

    const settingsEvents = rolloutItems.flatMap((item) => {
      const event = item as {
        type?: unknown;
        payload?: { msg?: { type?: unknown } };
      };
      return event.type === "event_msg" &&
        event.payload?.msg?.type === "run_runtime_settings_changed"
        ? [event.payload]
        : [];
    });
    expect(settingsEvents).toHaveLength(2);
    expect(settingsEvents[1]).toMatchObject({
      msg: {
        payload: {
          previousSettingsEventId: "runtime-settings-baseline",
          reason: "permission_mode_changed",
          permissionMode: "plan",
          prePlanMode: "default",
          model: "override-model",
          provider: "openai",
          profile: "override-profile",
        },
      },
    });
    expect(harness.permissionModeRegistry.current()).toMatchObject({
      mode: "plan",
      prePlanMode: "default",
    });
    expect(harness.session.pendingProviderSwitch).toEqual({
      provider: "openai",
      model: "override-model",
      profile: "override-profile",
    });
  });

  it.each([
    {
      label: "provider-only override",
      config: { model_provider: "openai", model: "gpt-5-mini" },
      override: { provider: "openai" },
      expected: { provider: "openai", model: "gpt-5-mini" },
    },
    {
      label: "model-only override",
      config: {},
      override: { model: "gpt-5" },
      expected: { provider: "openai", model: "gpt-5" },
    },
  ])("canonically resolves a $label before durable restore", async (entry) => {
    const runId = `session-settings-${entry.label.replaceAll(" ", "-")}`;
    const baseline = canonicalRuntimeSettings();
    const rolloutItems = [runtimeSettingsRolloutItem(runId, baseline)];
    const harness = makeTopLevelRunner({
      conversationId: runId,
      rolloutItems,
      canonicalRuntimeSettings: true,
    });
    Object.assign(harness.configStore, {
      current: () => entry.config,
    });

    await expect(
      harness.runner.restoreAgent({
        agentId: runId,
        objective: "resolve one restore selection",
        explicitColdResume: true,
        runtimeSettings: baseline,
        ...entry.override,
      }),
    ).resolves.toBe(true);

    expect(harness.session.pendingProviderSwitch).toEqual(entry.expected);
    expect(
      recordedRuntimeSettingsEvents(rolloutItems).at(-1)?.msg?.payload,
    ).toMatchObject(entry.expected);
  });

  it.each([
    {
      label: "a conflicting pair",
      override: { provider: "grok", model: "gpt-5" },
    },
    {
      label: "an unknown provider",
      override: { provider: "retired-provider" },
    },
  ])("rejects $label before committing restore overrides", async (entry) => {
    const runId = `session-settings-reject-${entry.label.replaceAll(" ", "-")}`;
    const baseline = canonicalRuntimeSettings();
    const rolloutItems = [runtimeSettingsRolloutItem(runId, baseline)];
    const harness = makeTopLevelRunner({
      conversationId: runId,
      rolloutItems,
      canonicalRuntimeSettings: true,
    });

    await expect(
      harness.runner.restoreAgent({
        agentId: runId,
        objective: "reject an invalid restore selection",
        explicitColdResume: true,
        runtimeSettings: baseline,
        ...entry.override,
      }),
    ).rejects.toThrow();

    expect(recordedRuntimeSettingsEvents(rolloutItems)).toHaveLength(1);
    expect(harness.session.pendingProviderSwitch).toBeNull();
  });

  it("rejects a noncanonical journal pair before applying restored state", async () => {
    const runId = "session-settings-invalid-journal-pair";
    const invalid = canonicalRuntimeSettings({
      permissionMode: "plan",
      prePlanMode: "default",
      provider: "grok",
      model: "gpt-5",
    });
    const rolloutItems = [runtimeSettingsRolloutItem(runId, invalid)];
    const harness = makeTopLevelRunner({
      conversationId: runId,
      rolloutItems,
      canonicalRuntimeSettings: true,
    });

    await expect(
      harness.runner.restoreAgent({
        agentId: runId,
        objective: "reject invalid journal authority",
        explicitColdResume: true,
        runtimeSettings: invalid,
      }),
    ).rejects.toThrow("runtime settings snapshot is not canonically valid");

    expect(harness.session.pendingProviderSwitch).toBeNull();
    expect(harness.sessionState.sessionConfiguration).toMatchObject({
      provider: { slug: "grok" },
      collaborationMode: { model: "base-model" },
    });
    expect(harness.permissionModeRegistry.current().mode).not.toBe("plan");
  });

  it("applies restored hook suppression before dispatching SessionStart", async () => {
    const runId = "session-hooks-disabled-restore";
    const settings: RunRuntimeSettingsSnapshot = {
      permissionMode: "default",
      prePlanMode: null,
      autoModeActive: false,
      autoModeAvailable: false,
      bypassPermissionsModeAvailable: false,
      bypassPermissionsWorkspace: null,
      bypassPermissionsConsentWorkspace: null,
      model: "base-model",
      provider: "grok",
      profile: null,
      reasoningEffort: null,
      modelVerbosity: null,
      serviceTier: null,
      hooksDisabled: true,
    };
    let hooksDisabled = false;
    const startupHook = vi.fn();
    const flushDeferredSessionStartHook = vi.fn(async () => {
      if (!hooksDisabled) startupHook();
    });
    const harness = makeTopLevelRunner({
      conversationId: runId,
      canonicalRuntimeSettings: true,
      rolloutItems: [runtimeSettingsRolloutItem(runId, settings)],
      flushDeferredSessionStartHook,
    });
    Object.assign(harness.session, {
      services: {
        ...(harness.session as { services: Record<string, unknown> }).services,
        hooksRuntime: {
          sourcePath: () => "/home/agent/.agenc/config.toml",
          isDisabled: () => hooksDisabled,
          isHardSuppressed: () => false,
          isExecutionSuppressed: () => hooksDisabled,
          issues: () => [],
          listHooks: () => [],
          latestDiagnostics: () => [],
          setDisabled: (disabled: boolean) => {
            hooksDisabled = disabled;
          },
        },
      },
    });

    await expect(
      harness.runner.restoreAgent({
        agentId: runId,
        objective: "restore hook authority",
        explicitColdResume: true,
        runtimeSettings: settings,
      }),
    ).resolves.toBe(true);

    expect(vi.mocked(harness.bootstrap).mock.calls[0]?.[0]).toMatchObject({
      deferSessionStartHooks: true,
    });
    expect(flushDeferredSessionStartHook).toHaveBeenCalledOnce();
    expect(hooksDisabled).toBe(true);
    expect(startupHook).not.toHaveBeenCalled();
  });

  it("commits startup activation before the first resumed user input", async () => {
    const rolloutItems: unknown[] = [
      {
        type: "event_msg",
        payload: {
          id: "resume-event",
          eventId: "resume-event",
          seq: 1,
          msg: {
            type: "run_resumed",
            payload: {
              runId: "session-activation-order",
              epoch: 1,
              suspensionEventId: "suspension-event",
              reason: "daemon_startup_restore",
              resumedAt: "2026-05-09T00:00:00.000Z",
            },
          },
        },
      },
    ];
    const harness = makeTopLevelRunner({
      conversationId: "session-activation-order",
      rolloutItems,
    });
    await expect(
      harness.runner.restoreAgent({
        agentId: "session-activation-order",
        objective: "resume lazily",
        explicitColdResume: true,
        resumeStartupActivationPending: true,
      }),
    ).resolves.toBe(true);

    await harness.runner.submitAgentMessage("session-activation-order", {
      sessionId: "session-activation-order",
      content: "first resumed input",
      originalContent: "first resumed input",
      messageId: "message-after-resume",
      streamId: "stream-after-resume",
      acceptedAt: "2026-05-09T00:01:00.000Z",
    });

    const types = rolloutItems.flatMap((item) => {
      const type = (item as { payload?: { msg?: { type?: string } } }).payload
        ?.msg?.type;
      return type === undefined ? [] : [type];
    });
    expect(types).toEqual([
      "run_resumed",
      "run_startup_activated",
      "user_message",
    ]);
    expect(
      harness.rolloutStore.recordRunStartupActivationEvent,
    ).toHaveBeenCalledOnce();
  });

  it("rolls back only the exact unpublished restore generation without a poison boundary", async () => {
    let harness: ReturnType<typeof makeTopLevelRunner>;
    const bootstrapShutdown = vi.fn(async () => {
      harness.stub.pushStatus({
        status: "shutdown",
        turnId: "turn-restore-publication-rollback",
        endedAtMs: 2,
      });
    });
    harness = makeTopLevelRunner({
      conversationId: "session-restore-publication-rollback",
      bootstrapShutdown,
    });
    await expect(
      harness.runner.restoreAgent({
        agentId: "session-restore-publication-rollback",
        objective: "retained objective",
        explicitColdResume: true,
        restoreAttemptId: "restore-attempt-exact",
      }),
    ).resolves.toBe(true);

    await expect(
      harness.runner.rollbackRestoredAgent(
        "session-restore-publication-rollback",
        "restore-attempt-other",
      ),
    ).rejects.toThrow("generation no longer owns");
    await expect(
      harness.runner.getAgentSnapshot("session-restore-publication-rollback"),
    ).resolves.not.toBeNull();

    await expect(
      harness.runner.rollbackRestoredAgent(
        "session-restore-publication-rollback",
        "restore-attempt-exact",
      ),
    ).resolves.toBeUndefined();
    await expect(
      harness.runner.getAgentSnapshot("session-restore-publication-rollback"),
    ).resolves.toBeNull();
    expect(bootstrapShutdown).toHaveBeenCalledOnce();
    const lifecycleTypes = harness.rolloutItems.flatMap((item) => {
      const type = (item as { payload?: { msg?: { type?: string } } }).payload
        ?.msg?.type;
      return type?.startsWith("run_") ? [type] : [];
    });
    expect(lifecycleTypes).toEqual([]);
  });

  it("projects correlated worktree completion evidence from run-agent progress", () => {
    const worktree = {
      path: "/repo/.agenc-worktrees/reviewer",
      branch: "worktree-reviewer",
      gitRoot: "/repo",
    };
    const worktreeEvidence = {
      state: "committed_clean",
      locator: worktree,
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      treeHash: "c".repeat(40),
      clean: true,
      baseIsAncestor: true,
      integrationRef: "b".repeat(40),
    };

    const event = loadTurnCompleteProgressProjection()("agent-reviewer", {
      kind: "turn_complete",
      turnId: "turn-reviewer",
      taskId: "task-reviewer",
      toolCallCount: 3,
      finalMessage: "review complete",
      worktree,
      worktreeEvidence,
    });

    expect(JSON.parse(JSON.stringify(event))).toEqual({
      id: "turn-complete-agent-reviewer-turn-reviewer",
      type: "turn_complete",
      payload: {
        turnId: "turn-reviewer",
        taskId: "task-reviewer",
        toolCallCount: 3,
        worktree,
        worktreeEvidence,
        lastAgentMessage: "review complete",
      },
    });
  });

  it("carries the canonical rollout sequence into daemon notifications", () => {
    const daemonEvent = daemonEventFromUnboundSessionEvent({
      eventId: "journal-progress-sequenced",
      id: "progress-sequenced",
      seq: 42,
      msg: {
        type: "tool_progress",
        payload: {
          callId: "tool-sequenced",
          toolName: "Bash",
          chunk: "ready",
        },
      },
    });

    expect(daemonEvent).toMatchObject({
      id: "progress-sequenced",
      eventId: "journal-progress-sequenced",
      sequence: 42,
    });
    expect(
      notificationFromDaemonEvent("session-1", "agent-1", daemonEvent!),
    ).toMatchObject({
      params: {
        eventId: "journal-progress-sequenced",
        sequence: 42,
        event: { id: "progress-sequenced" },
      },
    });
  });

  it("maps MCP invalidations to the strict passive status notification", () => {
    expect(
      notificationFromDaemonEvent("session-1", "agent-1", {
        id: "mcp-status:agent-1:7",
        type: "mcp_status_changed",
        payload: { revision: 7 },
      }),
    ).toEqual({
      jsonrpc: JSON_RPC_VERSION,
      method: "event.mcp_status_changed",
      params: {
        sessionId: "session-1",
        revision: 7,
      },
    });
  });

  it("derives collision-free legacy eventIds without changing reused envelope ids", () => {
    const first = daemonEventFromUnboundSessionEvent({
      id: "reused-tool-progress-sub-id",
      seq: 8,
      msg: {
        type: "tool_progress",
        payload: { callId: "call-1", toolName: "Bash", chunk: "one" },
      },
    });
    const second = daemonEventFromUnboundSessionEvent({
      id: "reused-tool-progress-sub-id",
      seq: 9,
      msg: {
        type: "tool_progress",
        payload: { callId: "call-1", toolName: "Bash", chunk: "two" },
      },
    });

    expect(first).toMatchObject({
      id: "reused-tool-progress-sub-id",
      eventId: "legacy-event:8:reused-tool-progress-sub-id",
      sequence: 8,
    });
    expect(second).toMatchObject({
      id: "reused-tool-progress-sub-id",
      eventId: "legacy-event:9:reused-tool-progress-sub-id",
      sequence: 9,
    });
  });

  it.each([
    ["agent_message_delta", { delta: "hello" }],
    ["tool_call_started", { callId: "call-1", toolName: "Read", args: "{}" }],
    ["tool_call_completed", { callId: "call-1", result: "ok", isError: false }],
    ["turn_started", { turnId: "turn-1", startedAt: 1 }],
    [
      "turn_complete",
      {
        turnId: "turn-1",
        lastAgentMessage: "done",
        completedAt: 2,
        durationMs: 1,
      },
    ],
    ["turn_aborted", { turnId: "turn-1", reason: "cancelled" }],
    ["error", { cause: "test", message: "failed" }],
    ["effect_intent", { runId: "run-1", stepId: "step-1" }],
    [
      "execution_admission",
      { runId: "run-1", stepId: "step-1", event: "allowed" },
    ],
    ["artifact_committed", { runId: "run-1", artifactId: "artifact-1" }],
    ["recovery_decision", { runId: "run-1", decision: "projection_rebuilt" }],
    ["run_terminal", { runId: "run-1", epoch: 1, status: "completed" }],
  ] as const)(
    "uses canonical identity for core %s notifications",
    (type, payload) => {
      const daemonEvent = daemonEventFromUnboundSessionEvent({
        eventId: `journal-${type}`,
        id: `canonical-${type}`,
        seq: 17,
        msg: { type, payload },
      });
      expect(daemonEvent).toMatchObject({
        id: `canonical-${type}`,
        eventId: `journal-${type}`,
        sequence: 17,
        type,
      });
      expect(
        notificationFromDaemonEvent("session-1", "agent-1", daemonEvent!),
      ).toMatchObject({
        params: {
          eventId: `journal-${type}`,
          sequence: 17,
        },
      });
      expect(
        daemonEventFromUnboundSessionEvent({
          id: `unsequenced-${type}`,
          msg: { type, payload },
        }),
      ).toBeNull();
    },
  );

  it("uses PhaseEvents only for bookkeeping when the canonical bridge is installed", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-canonical-core",
    });
    const emitted: unknown[] = [];
    await runner.startAgent({
      objective: "verify canonical delivery",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-canonical-core", {
      sessionId: "session-1",
      emit: (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    session.emitPhaseEvent({ type: "assistant_text", content: "hello" });
    session.emitPhaseEvent({
      type: "tool_call",
      toolCall: { id: "call-1", name: "Read", arguments: "{}" },
    });
    session.emitPhaseEvent({
      type: "turn_complete",
      content: "hello",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      stopReason: "completed",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(emitted).toEqual([]);

    session.emit({
      eventId: "journal-delta",
      id: "canonical-delta",
      msg: { type: "agent_message_delta", payload: { delta: "hello" } },
    });
    session.emit({
      eventId: "journal-tool",
      id: "canonical-tool",
      msg: {
        type: "tool_call_started",
        payload: { callId: "call-1", toolName: "Read", args: "{}" },
      },
    });
    session.emit({
      eventId: "journal-turn",
      id: "canonical-turn",
      msg: {
        type: "turn_complete",
        payload: {
          turnId: "turn-1",
          lastAgentMessage: "hello",
          completedAt: 2,
          durationMs: 1,
        },
      },
    });
    await vi.waitFor(() => expect(emitted).toHaveLength(3));
    expect(
      emitted.map(
        (event) =>
          (event as { params?: { eventId?: unknown } }).params?.eventId,
      ),
    ).toEqual(["journal-delta", "journal-tool", "journal-turn"]);
    for (const event of emitted) {
      expect(
        (event as { params?: { sequence?: unknown } }).params?.sequence,
      ).toEqual(expect.any(Number));
    }
  });

  it("reads cached MCP status but keeps invalidations live-only and coalesced", async () => {
    const { runner, session, stub, shutdown } = makeTopLevelRunner({
      conversationId: "session-mcp-status",
    });
    const snapshot = Object.freeze({
      revision: 7,
      servers: Object.freeze([
        Object.freeze({
          name: "audit-ping",
          transport: "stdio" as const,
          enabled: true,
          required: false,
          state: "connected" as const,
          displayTarget: "node",
          toolCount: 1,
        }),
      ]),
      tools: Object.freeze([
        Object.freeze({
          serverName: "audit-ping",
          name: "mcp.audit-ping.check",
        }),
      ]),
    });
    let invalidationListener: ((revision: number) => void) | undefined;
    const unsubscribe = vi.fn();
    Object.assign(session.services, {
      mcpManager: {
        mcpSurfaceSnapshot: () => snapshot,
        subscribeMcpSurfaceInvalidations: (
          listener: (revision: number) => void,
        ) => {
          invalidationListener = listener;
          return unsubscribe;
        },
      },
    });

    await runner.startAgent({
      objective: "inspect MCP status",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await expect(runner.getMcpStatus("session-mcp-status")).resolves.toBe(
      snapshot,
    );

    invalidationListener?.(8);
    await new Promise((resolve) => setImmediate(resolve));
    const emitted: unknown[] = [];
    let markMcpDeliveryStarted!: () => void;
    const mcpDeliveryStarted = new Promise<void>((resolve) => {
      markMcpDeliveryStarted = resolve;
    });
    let releaseMcpDelivery!: () => void;
    await runner.attachAgentSessionEvents("session-mcp-status", {
      sessionId: "daemon-session-1",
      emit: (event) => {
        emitted.push(event);
        if (
          (event as { readonly method?: unknown }).method ===
            "event.mcp_status_changed" &&
          (event as { readonly params?: { readonly revision?: unknown } })
            .params?.revision === 12
        ) {
          return new Promise<void>((resolve) => {
            releaseMcpDelivery = resolve;
            markMcpDeliveryStarted();
          });
        }
      },
    });
    expect(
      emitted.filter(
        (event) =>
          (event as { readonly method?: unknown }).method ===
          "event.mcp_status_changed",
      ),
    ).toEqual([]);

    invalidationListener?.(9);
    invalidationListener?.(10);
    invalidationListener?.(11);
    await vi.waitFor(() => {
      expect(
        emitted.filter(
          (event) =>
            (event as { readonly method?: unknown }).method ===
            "event.mcp_status_changed",
        ),
      ).toEqual([
        {
          jsonrpc: JSON_RPC_VERSION,
          method: "event.mcp_status_changed",
          params: { sessionId: "daemon-session-1", revision: 11 },
        },
      ]);
    });

    invalidationListener?.(12);
    await mcpDeliveryStarted;

    stub.pushStatus({
      status: "completed",
      turnId: "turn-mcp-status",
      endedAtMs: 2,
      lastMessage: "done",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(shutdown).not.toHaveBeenCalled();
    invalidationListener?.(13);

    releaseMcpDelivery();
    await vi.waitFor(() => {
      expect(
        emitted.filter(
          (event) =>
            (event as { readonly method?: unknown }).method ===
            "event.mcp_status_changed",
        ),
      ).toEqual([
        {
          jsonrpc: JSON_RPC_VERSION,
          method: "event.mcp_status_changed",
          params: { sessionId: "daemon-session-1", revision: 11 },
        },
        {
          jsonrpc: JSON_RPC_VERSION,
          method: "event.mcp_status_changed",
          params: { sessionId: "daemon-session-1", revision: 12 },
        },
      ]);
    });
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
    await vi.waitFor(async () => {
      await expect(
        runner.getAgentSnapshot("session-mcp-status"),
      ).resolves.toBeNull();
    });
    expect(unsubscribe).toHaveBeenCalledOnce();

    const emittedAfterRetirement = emitted.length;
    invalidationListener?.(14);
    await new Promise((resolve) => setImmediate(resolve));
    expect(emitted).toHaveLength(emittedAfterRetirement);
  });

  it("preserves compaction recovery details while broadcasting replacement history", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-partial-compact",
    });
    const attemptId = "compact-72d793c1-8f34-4e04-9049-d4bb868c37f3";
    const replacementEvent = {
      id: "history-replaced-partial-compact",
      type: "history_replaced" as const,
      acceptedAt: "2026-08-31T00:00:00.000Z",
      payload: {
        reason: "partial_compact" as const,
        messages: [],
      },
    };
    Object.assign(session, {
      partialCompactFromMessage: vi.fn(async () => ({
        ok: true,
        sessionId: "session-partial-compact",
        eventAlreadyEmitted: false as const,
        event: replacementEvent,
        attemptId,
        replacementHistory: [],
        displayText: `Conversation compacted\nRollback attempt ID: ${attemptId}`,
      })),
    });
    const emitted: unknown[] = [];
    const started = await runner.startAgent({
      objective: "verify partial compaction replacement",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents(started.agentId, {
      sessionId: "session-partial-compact",
      emit: (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    await expect(
      runner.partialCompactFromMessage?.(started.agentId, {
        sessionId: "session-partial-compact",
        messageOrdinal: 0,
        direction: "from",
      }),
    ).resolves.toMatchObject({
      ok: true,
      eventAlreadyEmitted: true,
      event: replacementEvent,
      attemptId,
      displayText: `Conversation compacted\nRollback attempt ID: ${attemptId}`,
    });
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({
      params: {
        event: {
          type: "transcript_epoch",
          payload: { reason: "partial_compact" },
        },
      },
    });
    expect(emitted[1]).toMatchObject({
      params: {
        event: {
          type: "history_replaced",
          payload: { reason: "partial_compact" },
        },
      },
    });
  });

  it("broadcasts a same-session rollback replacement before acknowledging it", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-rollback-replacement",
    });
    const replacementEvent = {
      id: "history-replaced-rollback",
      type: "history_replaced" as const,
      acceptedAt: "2026-05-09T00:00:00.000Z",
      payload: {
        reason: "compaction_rollback" as const,
        messages: [],
      },
    };
    Object.assign(session, {
      rollbackCompaction: vi.fn(async () => ({
        ok: true,
        sessionId: "session-rollback-replacement",
        eventAlreadyEmitted: false as const,
        event: replacementEvent,
        attemptId: "attempt-rollback",
        mode: "same_session" as const,
        targetSessionId: "session-rollback-replacement",
        replacementHistory: [],
        displayText: "Compaction rolled back in the current session",
      })),
    });
    const emitted: unknown[] = [];
    const started = await runner.startAgent({
      objective: "verify rollback replacement",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents(started.agentId, {
      sessionId: "session-rollback-replacement",
      emit: (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    await expect(
      runner.rollbackCompaction?.(started.agentId, {
        sessionId: "session-rollback-replacement",
        attemptId: "attempt-rollback",
      }),
    ).resolves.toMatchObject({
      ok: true,
      eventAlreadyEmitted: true,
      event: replacementEvent,
    });
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({
      params: {
        event: {
          type: "transcript_epoch",
          payload: { reason: "compaction_rollback" },
        },
      },
    });
    expect(emitted[1]).toMatchObject({
      params: {
        event: {
          type: "history_replaced",
          payload: { reason: "compaction_rollback" },
        },
      },
    });
  });

  it("drains the canonical turn tail before shutdown and terminal teardown", async () => {
    let releaseTurnDelivery!: () => void;
    const turnDeliveryBlocked = new Promise<void>((resolve) => {
      releaseTurnDelivery = resolve;
    });
    let markTurnDeliveryStarted!: () => void;
    const turnDeliveryStarted = new Promise<void>((resolve) => {
      markTurnDeliveryStarted = resolve;
    });
    const bootstrapShutdown = vi.fn(async () => {});
    const onActiveAgentTerminated = vi.fn(async () => {});
    const { runner, session, stub } = makeTopLevelRunner({
      conversationId: "session-terminal-delivery-order",
      bootstrapShutdown,
      onActiveAgentTerminated,
    });
    const emitted: unknown[] = [];
    await runner.startAgent({
      objective: "preserve the canonical tail",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-terminal-delivery-order", {
      sessionId: "session-1",
      emit: async (event) => {
        const eventId = (event as { params?: { eventId?: unknown } }).params
          ?.eventId;
        if (eventId === "turn-complete-before-shutdown") {
          markTurnDeliveryStarted();
          await turnDeliveryBlocked;
        }
        emitted.push(event);
      },
    });
    emitted.length = 0;

    session.emit({
      eventId: "turn-complete-before-shutdown",
      id: "turn-complete-before-shutdown",
      msg: {
        type: "turn_complete",
        payload: {
          turnId: "turn-terminal-delivery-order",
          lastAgentMessage: "done",
          completedAt: 2,
          durationMs: 1,
        },
      },
    });
    await turnDeliveryStarted;
    stub.pushStatus({
      status: "completed",
      turnId: "turn-terminal-delivery-order",
      endedAtMs: 2,
      lastMessage: "done",
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(bootstrapShutdown).not.toHaveBeenCalled();
    expect(onActiveAgentTerminated).not.toHaveBeenCalled();

    releaseTurnDelivery();
    await vi.waitFor(() =>
      expect(onActiveAgentTerminated).toHaveBeenCalledTimes(1),
    );
    expect(
      emitted.map(
        (event) =>
          (event as { params?: { eventId?: unknown } }).params?.eventId,
      ),
    ).toEqual([
      "turn-complete-before-shutdown",
      "run-terminal:session-terminal-delivery-order:1",
    ]);
    expect(bootstrapShutdown).toHaveBeenCalledTimes(1);
  });

  it("fsync-journals daemon permission requests and decisions before execution resumes", async () => {
    const { runner, session, rolloutItems } = makeTopLevelRunner({
      conversationId: "session-durable-permission",
    });
    const emitted: unknown[] = [];
    await runner.startAgent({
      objective: "record approval evidence",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-durable-permission", {
      sessionId: "client-session",
      emit: (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    const resolver = (
      session.services as {
        approvalResolver?: {
          request(context: unknown): Promise<{ readonly kind: string }>;
        };
      }
    ).approvalResolver;
    expect(resolver).toBeDefined();
    const pending = requestApproval({
      ctx: {
        invocation: {
          session,
          turn: { subId: "turn-permission-1" },
          tracker: {
            appendFileDiff() {},
            snapshot: () => [],
            clear() {},
          },
          callId: "permission-call-1",
          toolName: { name: "Read" },
          payload: {
            kind: "function",
            arguments: '{"path":"README.md"}',
          },
          source: "direct",
        } as never,
        callId: "permission-call-1",
        toolName: "Read",
        turnId: "turn-permission-1",
      },
      resolver: resolver as never,
    });

    await vi.waitFor(() =>
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.permission_request",
          params: expect.objectContaining({
            requestId: "permission-call-1",
            eventId: expect.any(String),
            sequence: expect.any(Number),
          }),
        }),
      ),
    );
    expect(
      await runner.resolveToolDecision("session-durable-permission", {
        requestId: "permission-call-1",
        decision: { kind: "approved" },
      }),
    ).toBe(true);
    await expect(pending).resolves.toMatchObject({
      decision: { kind: "approved" },
      source: "resolver",
    });

    const journalEvents = rolloutItems
      .filter(
        (
          item,
        ): item is {
          readonly type: "event_msg";
          readonly payload: {
            readonly eventId: string;
            readonly seq: number;
            readonly msg: {
              readonly type: string;
              readonly payload: Record<string, unknown>;
            };
          };
        } => (item as { readonly type?: unknown }).type === "event_msg",
      )
      .map((item) => item.payload);
    const request = journalEvents.find(
      (event) => event.msg.type === "request_permissions",
    );
    const decision = journalEvents.find(
      (event) => event.msg.type === "permission_decision",
    );
    expect(request).toMatchObject({
      eventId: expect.any(String),
      seq: expect.any(Number),
      msg: {
        payload: {
          callId: "permission-call-1",
          toolName: "Read",
          turnId: "turn-permission-1",
          permissions: ["tool.use"],
          input: { path: "README.md" },
        },
      },
    });
    expect(decision).toMatchObject({
      eventId: expect.any(String),
      seq: (request?.seq ?? 0) + 1,
      msg: {
        payload: {
          runId: "session-durable-permission",
          callId: "permission-call-1",
          requestEventId: request?.eventId,
          requestEventSeq: request?.seq,
          decision: "approved",
        },
      },
    });
  });

  it("aborts and journals a pending permission before stop seals the terminal tail", async () => {
    let releaseShutdown!: () => void;
    const shutdownStarted = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    const { runner, session, rolloutItems } = makeTopLevelRunner({
      conversationId: "session-stop-pending-permission",
      bootstrapShutdown: vi.fn(() => shutdownStarted),
    });
    await runner.startAgent({
      objective: "wait for permission",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    const resolver = (
      session.services as {
        approvalResolver?: {
          request(context: unknown): Promise<{ readonly kind: string }>;
        };
      }
    ).approvalResolver;
    expect(resolver).toBeDefined();
    const pending = requestApproval({
      ctx: {
        invocation: {
          session,
          turn: { subId: "turn-stop-permission" },
          tracker: {
            appendFileDiff() {},
            snapshot: () => [],
            clear() {},
          },
          callId: "permission-stop-call",
          toolName: { name: "Bash" },
          payload: { kind: "function", arguments: '{"cmd":"true"}' },
          source: "direct",
        } as never,
        callId: "permission-stop-call",
        toolName: "Bash",
        turnId: "turn-stop-permission",
      },
      resolver: resolver as never,
    });
    await vi.waitFor(() =>
      expect(
        rolloutItems.some(
          (item) =>
            (item as { payload?: { msg?: { type?: unknown } } }).payload?.msg
              ?.type === "request_permissions",
        ),
      ).toBe(true),
    );

    const stopping = runner.stopAgent(
      "session-stop-pending-permission",
      "user_stopped",
    );
    await expect(pending).resolves.toMatchObject({
      decision: { kind: "abort" },
      source: "resolver",
    });
    await expect(
      runner.submitAgentMessage("session-stop-pending-permission", {
        sessionId: "session-stop-pending-permission",
        content: "too late",
        originalContent: "too late",
        displayUserMessage: null,
        messageId: "message-too-late",
        streamId: "stream-too-late",
        acceptedAt: "2026-05-09T00:00:01.000Z",
      }),
    ).rejects.toThrow("not running");
    expect(
      await runner.resolveToolDecision("session-stop-pending-permission", {
        requestId: "permission-stop-call",
        decision: { kind: "approved" },
      }),
    ).toBe(false);
    releaseShutdown();
    await stopping;

    const canonical = rolloutItems
      .filter(
        (
          item,
        ): item is {
          readonly payload: {
            readonly seq: number;
            readonly msg: {
              readonly type: string;
              readonly payload: Record<string, unknown>;
            };
          };
        } => (item as { type?: unknown }).type === "event_msg",
      )
      .map((item) => item.payload);
    const requestIndex = canonical.findIndex(
      (event) => event.msg.type === "request_permissions",
    );
    const decisionIndex = canonical.findIndex(
      (event) => event.msg.type === "permission_decision",
    );
    const terminalIndex = canonical.findIndex(
      (event) => event.msg.type === "run_terminal",
    );
    expect(requestIndex).toBeGreaterThanOrEqual(0);
    expect(decisionIndex).toBeGreaterThan(requestIndex);
    expect(terminalIndex).toBeGreaterThan(decisionIndex);
    expect(terminalIndex).toBe(canonical.length - 1);
    expect(canonical[decisionIndex]?.msg.payload).toMatchObject({
      callId: "permission-stop-call",
      decision: "abort",
    });
    expect(canonical[terminalIndex]?.msg.payload).toMatchObject({
      stopReason: "user_stopped",
    });
  });

  it("suspends a daemon-shutdown idle run without poisoning it terminal", async () => {
    let clock = "2026-05-09T00:00:00.000Z";
    const { runner, rolloutItems, rolloutStore } = makeTopLevelRunner({
      conversationId: "session-daemon-suspend-idle",
      now: () => clock,
      threadInitialStatus: { status: "pending_init" } as AgentStatus,
    });
    await runner.startAgent({
      objective: "stay resumable",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });
    rolloutStore.assertRunSuspendable.mockImplementation(() => {
      clock = "2026-05-09T00:05:00.000Z";
    });

    await expect(
      runner.suspendIdleAgentForDaemonShutdown("session-daemon-suspend-idle"),
    ).resolves.toMatchObject({
      disposition: "suspended",
      suspension: {
        epoch: 1,
        reason: "daemon_shutdown_idle",
      },
    });
    const lifecycle = rolloutItems.flatMap((item) => {
      const event = (item as { payload?: { msg?: { type?: string } } }).payload;
      return event?.msg?.type?.startsWith("run_") ? [event.msg.type] : [];
    });
    expect(lifecycle).toEqual([
      "run_runtime_settings_changed",
      "run_suspended",
    ]);
    expect(
      rolloutItems.find(
        (item) =>
          (item as { payload?: { msg?: { type?: unknown } } }).payload?.msg
            ?.type === "run_suspended",
      ),
    ).toMatchObject({
      payload: {
        msg: {
          payload: { suspendedAt: "2026-05-09T00:05:00.000Z" },
        },
      },
    });
    expect(rolloutStore.assertRunSuspendable).toHaveBeenCalled();
    expect(rolloutStore.recordRunSuspensionEvent).toHaveBeenCalledOnce();
  });

  it("keeps committed suspension durable but rejects and retires authority when shutdown cleanup fails", async () => {
    const bootstrapShutdownAfterFinalizers = vi.fn(async () => {
      throw new Error("helper cleanup failed");
    });
    const { runner, stub, rolloutItems, rolloutStore } = makeTopLevelRunner({
      conversationId: "session-daemon-suspend-cleanup-failure",
      bootstrapShutdownAfterFinalizers,
    });
    await runner.startAgent({
      objective: "retain honest suspension",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });
    stub.pushStatus({ status: "idle", turnId: "turn-finished", endedAtMs: 1 });

    await expect(
      runner.suspendIdleAgentForDaemonShutdown(
        "session-daemon-suspend-cleanup-failure",
      ),
    ).rejects.toMatchObject({
      name: AgenCBackgroundAgentSuspensionShutdownError.name,
      suspension: { epoch: 1, reason: "daemon_shutdown_idle" },
    });

    expect(bootstrapShutdownAfterFinalizers).toHaveBeenCalledOnce();
    expect(rolloutStore.recordRunSuspensionEvent).toHaveBeenCalledOnce();
    expect(
      rolloutItems.filter(
        (item) =>
          (item as { payload?: { msg?: { type?: unknown } } }).payload?.msg
            ?.type === "run_suspended",
      ),
    ).toHaveLength(1);
    await expect(
      runner.getAgentSnapshot("session-daemon-suspend-cleanup-failure"),
    ).resolves.toBeNull();
  });

  it("does not accept readable suspension bytes when the fsync proof and retry fail", async () => {
    const syncCanonicalTail = vi.fn(() => {
      throw new Error("persistent fsync failure");
    });
    const { runner, stub, rolloutItems, rolloutStore } = makeTopLevelRunner({
      conversationId: "session-daemon-suspend-fsync-failure",
      emitAfterAppendError: new Error("append completed but fsync failed"),
      emitAfterAppendAfter: 1,
      syncCanonicalTail,
    });
    await runner.startAgent({
      objective: "never claim page-cache bytes",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });
    stub.pushStatus({ status: "idle", turnId: "turn-finished", endedAtMs: 1 });

    await expect(
      runner.suspendIdleAgentForDaemonShutdown(
        "session-daemon-suspend-fsync-failure",
      ),
    ).rejects.toThrow();

    expect(syncCanonicalTail).toHaveBeenCalled();
    expect(rolloutStore.recordRunSuspensionEvent).not.toHaveBeenCalled();
    expect(
      rolloutItems.some(
        (item) =>
          (item as { payload?: { msg?: { type?: unknown } } }).payload?.msg
            ?.type === "run_suspended",
      ),
    ).toBe(true);
    await expect(
      runner.getAgentSnapshot("session-daemon-suspend-fsync-failure"),
    ).resolves.toBeNull();
  });

  it("allocates a fresh suspension identity for repeated same-epoch restarts", async () => {
    const { runner, stub, session, rolloutItems } = makeTopLevelRunner({
      conversationId: "session-daemon-suspend-cycles",
    });
    await runner.startAgent({
      objective: "restart twice",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });
    stub.pushStatus({ status: "idle", turnId: "turn-1", endedAtMs: 1 });
    const first = await runner.suspendIdleAgentForDaemonShutdown(
      "session-daemon-suspend-cycles",
    );
    expect(first.disposition).toBe("suspended");
    if (first.disposition !== "suspended") throw new Error("not suspended");
    session.emit({
      eventId: `run-resumed:session-daemon-suspend-cycles:1:${first.suspension.eventId}`,
      id: `run-resumed:session-daemon-suspend-cycles:1:${first.suspension.eventId}`,
      msg: {
        type: "run_resumed",
        payload: {
          runId: "session-daemon-suspend-cycles",
          epoch: 1,
          suspensionEventId: first.suspension.eventId,
          reason: "daemon_startup_restore",
          resumedAt: "2026-05-09T00:01:00.000Z",
        },
      },
    });

    await runner.startAgent({
      objective: "restart twice",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });
    stub.pushStatus({ status: "idle", turnId: "turn-2", endedAtMs: 2 });
    const second = await runner.suspendIdleAgentForDaemonShutdown(
      "session-daemon-suspend-cycles",
    );
    expect(second.disposition).toBe("suspended");
    if (second.disposition !== "suspended") throw new Error("not suspended");
    expect(second.suspension.epoch).toBe(1);
    expect(second.suspension.eventId).not.toBe(first.suspension.eventId);
    const lifecycle = rolloutItems.flatMap((item) => {
      const event = (
        item as {
          payload?: { eventId?: string; msg?: { type?: string } };
        }
      ).payload;
      return event?.msg?.type === "run_suspended" ||
        event?.msg?.type === "run_resumed"
        ? [{ type: event.msg.type, eventId: event.eventId }]
        : [];
    });
    expect(lifecycle.map(({ type }) => type)).toEqual([
      "run_suspended",
      "run_resumed",
      "run_suspended",
    ]);
  });

  it("cancels instead of suspending when idle proof finds an unsettled effect", async () => {
    const { runner, stub, rolloutItems, rolloutStore } = makeTopLevelRunner({
      conversationId: "session-daemon-suspend-effect-gate",
    });
    await runner.startAgent({
      objective: "has effect intent",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });
    stub.pushStatus({
      status: "idle",
      turnId: "turn-effect",
      endedAtMs: 1,
    });
    rolloutStore.assertRunSuspendable.mockImplementation(() => {
      throw new Error("unsettled side effect");
    });

    await expect(
      runner.suspendIdleAgentForDaemonShutdown(
        "session-daemon-suspend-effect-gate",
      ),
    ).resolves.toMatchObject({ disposition: "cancelled" });
    const lifecycle = rolloutItems.flatMap((item) => {
      const event = (item as { payload?: { msg?: { type?: string } } }).payload;
      return event?.msg?.type?.startsWith("run_") ? [event.msg.type] : [];
    });
    expect(lifecycle).toEqual(["run_runtime_settings_changed", "run_terminal"]);
  });

  it("cancels and quiesces when the root is idle but a child remains open", async () => {
    const bootstrapShutdown = vi.fn(async () => {});
    const { runner, stub, control, rolloutItems, shutdown } =
      makeTopLevelRunner({
        conversationId: "session-daemon-suspend-child",
        bootstrapShutdown,
      });
    await runner.startAgent({
      objective: "wait for child",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });
    stub.pushStatus({
      status: "idle",
      turnId: "turn-parent",
      endedAtMs: 1,
    });
    control.liveThreadSpawnChildren.mockReturnValue(
      new Map([
        [
          "session-daemon-suspend-child",
          [["child-running", { agentPath: "/root/child" }]],
        ],
      ]),
    );

    await expect(
      runner.suspendIdleAgentForDaemonShutdown("session-daemon-suspend-child"),
    ).resolves.toMatchObject({ disposition: "cancelled" });
    expect(shutdown).toHaveBeenCalledOnce();
    expect(bootstrapShutdown).toHaveBeenCalledOnce();
    const lifecycle = rolloutItems.flatMap((item) => {
      const event = (item as { payload?: { msg?: { type?: string } } }).payload;
      return event?.msg?.type?.startsWith("run_") ? [event.msg.type] : [];
    });
    expect(lifecycle).toEqual(["run_runtime_settings_changed", "run_terminal"]);
  });

  it("canonicalizes cancellation and admission decisions before the terminal tail", async () => {
    const { runner, session, rolloutItems } = makeTopLevelRunner({
      conversationId: "session-two-phase-cancel",
    });
    const cancelAdmissions = vi.fn((reason: string) => {
      session.emit({
        eventId: "admission-cancelled-before-terminal",
        id: "admission-cancelled-before-terminal",
        msg: {
          type: "execution_admission",
          payload: {
            sequence: 7,
            eventId: "admission-cancelled-before-terminal",
            timestamp: "2026-05-09T00:00:00.000Z",
            runId: "session-two-phase-cancel",
            stepId: "model-turn-1",
            kind: "model_turn",
            event: "cancelled",
            reason,
          },
        },
      });
      return {
        affectedRunIds: ["session-two-phase-cancel"],
        voidedReservations: 1,
        heldUnknownReservations: 0,
      };
    });
    (
      session.services as typeof session.services & {
        executionAdmission?: { cancelAdmissions: typeof cancelAdmissions };
      }
    ).executionAdmission = { cancelAdmissions };

    await runner.startAgent({
      objective: "cancel safely",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    const prepared = await runner.prepareAgentCancellation(
      "session-two-phase-cancel",
      "operator",
    );
    expect(prepared).toMatchObject({
      affectedRunIds: ["session-two-phase-cancel"],
      voidedHolds: 1,
    });
    await expect(
      runner.submitAgentMessage("session-two-phase-cancel", {
        sessionId: "session-two-phase-cancel",
        content: "late input",
        originalContent: "late input",
        messageId: "late-message",
        streamId: "late-stream",
        acceptedAt: "2026-05-09T00:00:01.000Z",
      }),
    ).rejects.toThrow("not running");

    await runner.stopAgent("session-two-phase-cancel", "operator");

    const canonical = rolloutItems
      .filter(
        (
          item,
        ): item is {
          readonly payload: {
            readonly seq: number;
            readonly msg: { readonly type: string };
          };
        } => (item as { type?: unknown }).type === "event_msg",
      )
      .map((item) => item.payload);
    const requestIndex = canonical.findIndex(
      (event) => event.msg.type === "run_cancel_requested",
    );
    const admissionIndex = canonical.findIndex(
      (event) => event.msg.type === "execution_admission",
    );
    const terminalIndex = canonical.findIndex(
      (event) => event.msg.type === "run_terminal",
    );
    expect(requestIndex).toBeGreaterThanOrEqual(0);
    expect(admissionIndex).toBeGreaterThan(requestIndex);
    expect(terminalIndex).toBeGreaterThan(admissionIndex);
    expect(terminalIndex).toBe(canonical.length - 1);
    expect(cancelAdmissions).toHaveBeenCalledOnce();
  });

  it("does not revive the removed runner-side budget monitor from unknown input", async () => {
    let totalTokens = 0;
    const { runner, session, rolloutItems } = makeTopLevelRunner({
      conversationId: "session-budget-pending-permission",
      // A stale caller may still pass the retired field at runtime. Unknown
      // constructor data must not recreate a second enforcement authority.
      additionalRunnerOptions: { agentBudget: { token_cap: 1 } },
      totalTokenUsage: () => ({
        inputTokens: totalTokens,
        outputTokens: 0,
        totalTokens,
      }),
    });
    await runner.startAgent({
      objective: "wait under budget",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    const resolver = (
      session.services as {
        approvalResolver?: {
          request(context: unknown): Promise<{ readonly kind: string }>;
        };
      }
    ).approvalResolver;
    const pending = requestApproval({
      ctx: {
        invocation: {
          session,
          turn: { subId: "turn-budget-permission" },
          tracker: {
            appendFileDiff() {},
            snapshot: () => [],
            clear() {},
          },
          callId: "permission-budget-call",
          toolName: { name: "exec_command" },
          payload: { kind: "function", arguments: '{"cmd":"true"}' },
          source: "direct",
        } as never,
        callId: "permission-budget-call",
        toolName: "exec_command",
        turnId: "turn-budget-permission",
      },
      resolver: resolver as never,
    });
    await vi.waitFor(() =>
      expect(
        rolloutItems.some(
          (item) =>
            (item as { payload?: { msg?: { type?: unknown } } }).payload?.msg
              ?.type === "request_permissions",
        ),
      ).toBe(true),
    );

    totalTokens = 2;
    session.emitPhaseEvent({ type: "assistant_text", content: "budget tick" });
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    for (let index = 0; index < 10; index += 1) await Promise.resolve();

    expect(settled).toBe(false);
    expect(
      rolloutItems.some(
        (item) =>
          (item as { payload?: { msg?: { type?: unknown } } }).payload?.msg
            ?.type === "run_terminal",
      ),
    ).toBe(false);
    expect(
      await runner.getAgentSnapshot("session-budget-pending-permission"),
    ).toMatchObject({ status: "running" });

    await runner.stopAgent("session-budget-pending-permission", "test_cleanup");
    await expect(pending).resolves.toMatchObject({
      decision: { kind: "abort" },
    });
  });

  it("commits an epoch-aware terminal at the quiesced shutdown boundary and publishes it canonically", async () => {
    const threadShutdown = vi.fn(async () => {});
    const onActiveAgentTerminated = vi.fn(async () => {});
    const rolloutItems = [
      {
        type: "event_msg",
        payload: {
          id: "reopen-2",
          seq: 7,
          msg: {
            type: "run_reopened",
            payload: {
              runId: "session-stop-epoch-2",
              previousEpoch: 1,
              epoch: 2,
              reason: "review",
              reopenedAt: "2026-05-08T00:00:00.000Z",
            },
          },
        },
      },
    ];
    const { runner, session, shutdown } = makeTopLevelRunner({
      conversationId: "session-stop-epoch-2",
      threadShutdown,
      rolloutItems,
      onActiveAgentTerminated,
    });
    const emitted: unknown[] = [];
    await runner.startAgent({
      objective: "stop durably",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-stop-epoch-2", {
      sessionId: "session-1",
      emit: (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    await runner.stopAgent("session-stop-epoch-2", "user_stopped");

    const terminalCallIndex = session.emit.mock.calls.findIndex(
      ([event]) =>
        (event as { msg?: { type?: unknown } }).msg?.type === "run_terminal",
    );
    expect(terminalCallIndex).toBeGreaterThanOrEqual(0);
    expect(session.emit.mock.calls[terminalCallIndex]![0]).toMatchObject({
      id: "run-terminal:session-stop-epoch-2:2",
      msg: {
        type: "run_terminal",
        payload: {
          epoch: 2,
          status: "cancelled",
          stopReason: "user_stopped",
        },
      },
    });
    expect(
      session.emit.mock.invocationCallOrder[terminalCallIndex]!,
    ).toBeGreaterThan(shutdown.mock.invocationCallOrder[0]!);
    expect(threadShutdown).not.toHaveBeenCalled();
    expect(emitted).toContainEqual(
      expect.objectContaining({
        method: "event.agent_status",
        params: expect.objectContaining({
          eventId: "run-terminal:session-stop-epoch-2:2",
          sequence: expect.any(Number),
          status: "stopped",
          runStatus: "stopped",
        }),
      }),
    );
    expect(onActiveAgentTerminated).toHaveBeenCalledWith(
      "session-stop-epoch-2",
      expect.objectContaining({
        terminal: expect.objectContaining({
          epoch: 2,
          eventId: "run-terminal:session-stop-epoch-2:2",
        }),
      }),
    );
  });

  it("does not advertise a canonical terminal status when its durable append fails", async () => {
    const onActiveAgentTerminated = vi.fn(async () => {});
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-terminal-append-failure",
      onActiveAgentTerminated,
    });
    await runner.startAgent({
      objective: "fail terminal commit",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    session.emit.mockImplementationOnce(() => {
      throw new Error("terminal write failed");
    });

    await expect(
      runner.stopAgent("session-terminal-append-failure", "user_stopped"),
    ).rejects.toThrow("terminal write failed");
    expect(onActiveAgentTerminated).not.toHaveBeenCalled();
  });

  it("announces sequenced pre-attach eviction with valid cursor coordinates", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-buffer-gap",
    });
    await runner.startAgent({
      objective: "fill detached buffer",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    for (let index = 0; index < 1_005; index += 1) {
      session.emit({
        id: `delta-${index}`,
        msg: {
          type: "agent_message_delta",
          payload: { delta: String(index) },
        },
      });
    }
    for (let index = 0; index < 5; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const emitted: unknown[] = [];
    await runner.attachAgentSessionEvents("session-buffer-gap", {
      sessionId: "session-1",
      emit: (event) => {
        emitted.push(event);
      },
    });
    expect(emitted).toHaveLength(1_001);
    expect(emitted[0]).toMatchObject({
      method: "event.event_gap",
      params: {
        type: "event_gap",
        runId: "session-buffer-gap",
        retiredCount: 7,
        coordinatesAvailable: true,
        afterSequence: 0,
        firstAvailableSequence: 8,
      },
    });
  });

  it("preserves the trusted Ledger clientAction through the session-event bridge", () => {
    const clientAction = {
      type: "ledger_solana_transfer_v1",
      source: "agenc-core",
      targetCapability: "portal.ledger.solana.sign.v1",
      network: "mainnet-beta",
      intentId: "ledger-action-1",
      responseNonce: "response-nonce-ledger-action-1",
      to: "11111111111111111111111111111111",
      lamports: "1",
      expiresAt: "2026-07-10T10:10:00.000Z",
    };
    const daemonEvent = daemonEventFromUnboundSessionEvent({
      id: "ledger-event",
      msg: {
        type: "request_user_input",
        payload: {
          requestId: "ledger-request",
          callId: "ledger-call",
          turnId: "ledger-turn",
          questions: [],
          clientAction,
        },
      },
    });

    expect(daemonEvent).toMatchObject({
      type: "request_user_input",
      payload: { clientAction },
    });
    expect(
      notificationFromDaemonEvent("session-1", "agent-1", daemonEvent!),
    ).toMatchObject({
      method: "event.user_input_request",
      params: { sessionId: "session-1", clientAction },
    });
  });

  it("bridges collab subagent lifecycle session events into daemon session notifications", () => {
    expect(
      daemonEventFromUnboundSessionEvent({
        id: "spawn-begin",
        msg: {
          type: "collab_agent_spawn_begin",
          payload: {
            callId: "call-agent",
            senderThreadId: "root",
            prompt: "inspect /tmp",
            model: "qwen3.6-27b-fp8",
          },
        },
      }),
    ).toEqual({
      id: "spawn-begin",
      eventId: "spawn-begin",
      type: "collab_agent_spawn_begin",
      payload: {
        callId: "call-agent",
        senderThreadId: "root",
        prompt: "inspect /tmp",
        model: "qwen3.6-27b-fp8",
      },
    });

    expect(
      daemonEventFromUnboundSessionEvent({
        id: "spawn-end",
        msg: {
          type: "collab_agent_spawn_end",
          payload: {
            callId: "call-agent",
            senderThreadId: "root",
            status: {
              status: "errored",
              turnId: "call-agent",
              error: "task_name is required",
            },
          },
        },
      }),
    ).toEqual({
      id: "spawn-end",
      eventId: "spawn-end",
      type: "collab_agent_spawn_end",
      payload: {
        callId: "call-agent",
        senderThreadId: "root",
        status: {
          status: "errored",
          turnId: "call-agent",
          error: "task_name is required",
        },
      },
    });

    expect(
      daemonEventFromUnboundSessionEvent({
        id: "agent-status",
        msg: {
          type: "collab_agent_status",
          payload: {
            callId: "call-agent",
            senderThreadId: "root",
            threadId: "thread-agent",
            agentNickname: "Librarian",
            status: "completed",
          },
        },
      }),
    ).toEqual({
      id: "agent-status",
      eventId: "agent-status",
      type: "collab_agent_status",
      payload: {
        callId: "call-agent",
        senderThreadId: "root",
        threadId: "thread-agent",
        agentNickname: "Librarian",
        status: "completed",
      },
    });
  });

  it("bridges tool_progress session events for live daemon snapshots", () => {
    expect(
      daemonEventFromUnboundSessionEvent({
        id: "progress-1",
        msg: {
          type: "tool_progress",
          payload: {
            callId: "tool-1",
            toolName: "Bash",
            chunk: "output\n",
            stream: "stdout",
          },
        },
      }),
    ).toEqual({
      id: "progress-1",
      eventId: "progress-1",
      type: "tool_progress",
      payload: {
        callId: "tool-1",
        toolName: "Bash",
        chunk: "output\n",
        stream: "stdout",
      },
    });
  });

  it("starts agent.create through the managed-thread path and keeps it alive", async () => {
    const csvAgentJobsRepositories = {
      withRepository: vi.fn(),
    } as unknown as CsvAgentJobsRepositoryProvider;
    const {
      runner,
      bootstrap,
      permissionUpdates,
      permissionModeRegistry,
      shutdown,
    } = makeTopLevelRunner({
      conversationId: "parent-session",
      argv: ["/usr/bin/node", "/opt/agenc/bin/agenc.js"],
      env: { AGENC_HOME: "/tmp/agenc-home" },
      csvAgentJobsRepositories,
      now: () => "2026-05-01T12:00:00.500Z",
    });

    await expect(
      runner.startAgent({
        objective: "compile the daemon",
        cwd: "/workspace",
        model: "grok-4",
        metadata: { ticket: "F-06a" },
        unattendedAllow: ["FileRead", "Grep"],
        unattendedDeny: ["exec_command"],
      }),
    ).resolves.toEqual({
      agentId: "parent-session",
      agentPath: "/root",
      startedAt: "2026-05-01T12:00:00.500Z",
      status: "running",
    });

    expect(bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          AGENC_HOME: "/tmp/agenc-home",
        }),
        argv: ["/usr/bin/node", "/opt/agenc/bin/agenc.js", "--model", "grok-4"],
        cwd: "/workspace",
        executionAdmissionAutonomous: true,
        csvAgentJobsRepositories,
      }),
    );
    const runtimeEnvironment = vi.mocked(bootstrap).mock.calls[0]?.[0].env;
    expect(runtimeEnvironment).not.toHaveProperty("AGENC_PROVIDER");
    expect(runtimeEnvironment).not.toHaveProperty("AGENC_MODEL");
    expect(runtimeEnvironment).not.toHaveProperty("XAI_API_KEY");
    expect(permissionModeRegistry.update).toHaveBeenCalledTimes(1);
    expect(permissionUpdates[0]).toMatchObject({
      mode: "unattended",
      unattendedPolicy: {
        allowlist: ["FileRead", "Grep"],
        denylist: ["system.bash"],
      },
    });
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("uses only structured agent configuration, never inherited daemon argv", async () => {
    const { runner, bootstrap } = makeTopLevelRunner({
      conversationId: "positional-bootstrap-session",
      argv: [
        "node",
        "agenc",
        "--provider",
        "grok",
        "--config",
        "/daemon-launch-config.toml",
        "daemon",
        "status",
      ],
    });

    await runner.startAgent({
      objective: "compile the daemon",
      provider: "openai",
      model: "gpt-5",
      profile: "fast",
      configPath: "/workspace/explicit-config.toml",
      permissionMode: "plan",
      unattendedAllow: [],
      unattendedDeny: [],
    });

    expect(bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: [
          "node",
          "agenc",
          "--provider",
          "openai",
          "--model",
          "gpt-5",
          "--profile",
          "fast",
          "--config",
          "/workspace/explicit-config.toml",
          "--permission-mode",
          "plan",
        ],
      }),
    );
  });

  it("keeps ordinary bypass out of the combined dangerous startup flag", async () => {
    const { runner, bootstrap } = makeTopLevelRunner({
      conversationId: "canonical-bypass-bootstrap-session",
    });

    await runner.startAgent({
      objective: "compile without approval prompts",
      permissionMode: "bypassPermissions",
      unattendedAllow: [],
      unattendedDeny: [],
      runtimeOptions: resolveAgentRuntimeOptions({}),
    });

    const argv = vi.mocked(bootstrap).mock.calls[0]?.[0].argv ?? [];
    expect(argv.slice(-2)).toEqual([
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv).not.toContain("--yolo");
    expect(argv).not.toContain("--allow-dangerously-skip-permissions");
  });

  it("forwards combined dangerous authority only through runtime options", async () => {
    const { runner, bootstrap } = makeTopLevelRunner({
      conversationId: "dangerous-runtime-options-bootstrap-session",
    });
    const runtimeOptions = resolveAgentRuntimeOptions({}, {
      dangerouslyBypassApprovalsAndSandbox: true,
    });

    await runner.startAgent({
      objective: "compile with explicit sandbox escape",
      permissionMode: "bypassPermissions",
      unattendedAllow: [],
      unattendedDeny: [],
      runtimeOptions,
    });

    expect(bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: expect.arrayContaining([
          "--permission-mode",
          "bypassPermissions",
        ]),
        runtimeOptions,
      }),
    );
    const argv = vi.mocked(bootstrap).mock.calls[0]?.[0].argv ?? [];
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("passes the sole budget authority into session execution admission", async () => {
    const executionAdmissionKernel = {} as ExecutionAdmissionKernel;
    const { runner, bootstrap, shutdown } = makeTopLevelRunner({
      conversationId: "kernel-budget-session",
      executionAdmissionKernel,
    });

    await runner.startAgent({ objective: "kernel-owned budget" });
    await Promise.resolve();

    expect(
      await runner.getAgentSnapshot("kernel-budget-session"),
    ).toMatchObject({
      status: "running",
    });
    expect(shutdown).not.toHaveBeenCalled();
    expect(bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        executionAdmissionAutonomous: true,
        executionAdmissionKernel,
      }),
    );
  });

  it("publishes a model successor only after the live provider selection is staged and keeps attach snapshots behind the mutation", async () => {
    const agentId = "model-publication-order";
    const { runner, session, rolloutItems } = makeTopLevelRunner({
      conversationId: agentId,
      canonicalRuntimeSettings: true,
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });

    const observations: Array<{
      readonly pending: unknown;
      readonly snapshotSettled: boolean;
    }> = [];
    let attachSnapshot: ReturnType<typeof runner.getAgentSnapshot> | undefined;
    let snapshotSettled = false;
    let attachBarrierHeld = false;
    let attachBarrierProbe: Promise<void> | undefined;
    const unsubscribe = session.eventLog.subscribe((event: unknown) => {
      if (
        (event as { msg?: { type?: unknown } }).msg?.type !==
        "run_runtime_settings_changed"
      ) {
        return;
      }
      attachSnapshot = runner.getAgentSnapshot(agentId);
      void attachSnapshot.then(() => {
        snapshotSettled = true;
      });
      attachBarrierProbe = Promise.resolve().then(() => {
        attachBarrierHeld = !snapshotSettled;
      });
      observations.push({
        pending: session.pendingProviderSwitch,
        snapshotSettled,
      });
    });

    const result = await runner.setAgentModel(agentId, {
      model: "gpt-5",
      provider: "openai",
    });
    expect(result).toMatchObject({
      applied: true,
      provider: "openai",
      model: "gpt-5",
    });
    unsubscribe();

    const successor = recordedRuntimeSettingsEvents(rolloutItems).at(-1);
    expect(result.runtimeSettingsEventId).toBe(successor?.eventId);
    expect(successor?.msg?.payload).toMatchObject({
      provider: result.provider,
      model: result.model,
    });

    expect(observations).toEqual([
      {
        pending: { provider: "openai", model: "gpt-5" },
        snapshotSettled: false,
      },
    ]);
    await expect(attachSnapshot).resolves.toMatchObject({
      runtimeSettings: { provider: "openai", model: "gpt-5" },
    });
    await attachBarrierProbe;
    expect(attachBarrierHeld).toBe(true);
    expect(snapshotSettled).toBe(true);
  });

  it("resolves a model-only background change before staging durable settings", async () => {
    const agentId = "model-only-canonical-selection";
    const { runner, session, rolloutItems } = makeTopLevelRunner({
      conversationId: agentId,
      canonicalRuntimeSettings: true,
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });

    await expect(
      runner.setAgentModel(agentId, { model: "gpt-5" }),
    ).resolves.toMatchObject({ applied: true });

    expect(session.pendingProviderSwitch).toEqual({
      provider: "openai",
      model: "gpt-5",
    });
    expect(
      recordedRuntimeSettingsEvents(rolloutItems).at(-1)?.msg?.payload,
    ).toMatchObject({
      reason: "model_provider_changed",
      provider: "openai",
      model: "gpt-5",
    });
    await expect(runner.getAgentSnapshot(agentId)).resolves.toMatchObject({
      runtimeSettings: { provider: "openai", model: "gpt-5" },
    });
  });

  it("does not publish model settings when provider preparation fails", async () => {
    const agentId = "model-provider-preparation-failure";
    const { runner, session, rolloutItems } = makeTopLevelRunner({
      conversationId: agentId,
      canonicalRuntimeSettings: true,
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });
    const before = recordedRuntimeSettingsEvents(rolloutItems);
    vi.mocked(session.prepareProviderSwitch).mockRejectedValueOnce(
      new Error("injected provider preparation failure"),
    );

    await expect(
      runner.setAgentModel(agentId, {
        provider: "openai",
        model: "gpt-5",
      }),
    ).rejects.toThrow("injected provider preparation failure");

    expect(session.pendingProviderSwitch).toBeNull();
    expect(recordedRuntimeSettingsEvents(rolloutItems)).toEqual(before);
    await expect(runner.getAgentSnapshot(agentId)).resolves.toMatchObject({
      runtimeSettings: { provider: "grok", model: "base-model" },
    });
  });

  it("keeps the runtime-settings cursor unchanged for the active provider/model pair", async () => {
    const agentId = "unchanged-provider-model-pair";
    const { runner, session, rolloutItems } = makeTopLevelRunner({
      conversationId: agentId,
      canonicalRuntimeSettings: true,
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });
    const before = recordedRuntimeSettingsEvents(rolloutItems);
    const cursor = before.at(-1)?.eventId;

    await expect(
      runner.setAgentModel(agentId, {
        provider: "grok",
        model: "base-model",
      }),
    ).resolves.toMatchObject({
      applied: false,
      provider: "grok",
      model: "base-model",
      runtimeSettingsEventId: cursor,
      summary: "Model unchanged: grok/base-model.",
    });
    expect(session.pendingProviderSwitch).toBeNull();
    expect(recordedRuntimeSettingsEvents(rolloutItems)).toHaveLength(
      before.length,
    );
  });

  it("rejects an impossible background provider/model pair before durable staging", async () => {
    const agentId = "conflicting-model-provider-selection";
    const { runner, session, rolloutItems } = makeTopLevelRunner({
      conversationId: agentId,
      canonicalRuntimeSettings: true,
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });
    const before = recordedRuntimeSettingsEvents(rolloutItems);
    const beforeEvents = before.length;
    const originalCursor = before.at(-1)?.eventId;

    const result = await runner.setAgentModel(agentId, {
      provider: "grok",
      model: "gpt-5",
    });
    expect(result).toMatchObject({
      applied: false,
      provider: "grok",
      model: "base-model",
      runtimeSettingsEventId: originalCursor,
      summary: expect.stringContaining("belongs to provider 'openai'"),
    });

    expect(session.pendingProviderSwitch).toBeNull();
    expect(recordedRuntimeSettingsEvents(rolloutItems)).toHaveLength(
      beforeEvents,
    );
  });

  it("keeps canonical runtime settings detached from mutable in-process snapshots", async () => {
    const agentId = "runtime-settings-snapshot-isolation";
    let hooksDisabled = false;
    const { runner, session, rolloutItems } = makeTopLevelRunner({
      conversationId: agentId,
      canonicalRuntimeSettings: true,
    });
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        hooksRuntime: {
          sourcePath: () => "/home/agent/.agenc/config.toml",
          isDisabled: () => hooksDisabled,
          isHardSuppressed: () => false,
          isExecutionSuppressed: () => hooksDisabled,
          issues: () => [],
          listHooks: () => [],
          latestDiagnostics: () => [],
          setDisabled: (next: boolean) => {
            hooksDisabled = next;
          },
        },
      },
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });
    await runner.setAgentPermissionMode(agentId, {
      sessionId: agentId,
      mode: "plan",
    });

    const exposed = (await runner.getAgentSnapshot(agentId))?.runtimeSettings;
    if (exposed === undefined) {
      throw new Error("expected exposed runtime settings");
    }
    const canonical = structuredClone(exposed);
    expect(Object.isFrozen(exposed)).toBe(true);
    for (const [key, value] of Object.entries(exposed)) {
      const replacement =
        typeof value === "boolean"
          ? !value
          : typeof value === "string"
            ? `${value}-mutated`
            : "mutated";
      expect(Reflect.set(exposed, key, replacement)).toBe(false);
    }
    const detached = (await runner.getAgentSnapshot(agentId))?.runtimeSettings;
    expect(detached).toEqual(canonical);
    expect(detached).not.toBe(exposed);

    const beforeNoOps = recordedRuntimeSettingsEvents(rolloutItems).length;
    await expect(runner.setAgentModel(agentId, {})).resolves.toMatchObject({
      applied: false,
    });
    await expect(
      runner.setAgentHooksDisabled(agentId, { disabled: false }),
    ).resolves.toMatchObject({ applied: false });
    await expect(
      runner.applyAgentConfig(agentId, { sessionId: agentId }),
    ).resolves.toMatchObject({ applied: false });
    await expect(
      runner.setAgentPermissionMode(agentId, {
        sessionId: agentId,
        mode: "plan",
      }),
    ).resolves.toMatchObject({ applied: false });
    expect(recordedRuntimeSettingsEvents(rolloutItems)).toHaveLength(
      beforeNoOps,
    );

    let pending: {
      provider: string;
      model: string;
      profile?: string;
    } | null = null;
    let failNextStage = true;
    Object.defineProperty(session, "pendingProviderSwitch", {
      configurable: true,
      get: () => pending,
    });
    Object.assign(session, {
      stagePreparedProviderSwitch: (prepared: {
        pending: {
          provider: string;
          model: string;
          profile?: string;
        };
      }) => {
        if (failNextStage) {
          failNextStage = false;
          throw new Error("injected isolated snapshot staging failure");
        }
        pending = prepared.pending;
      },
      setPendingProviderSwitch: (
        spec: {
          provider: string;
          model: string;
          profile?: string;
        } | null,
      ) => {
        pending = spec;
      },
    });

    await expect(
      runner.setAgentModel(agentId, {
        model: "gpt-5",
        provider: "openai",
      }),
    ).rejects.toThrow("injected isolated snapshot staging failure");
    await expect(runner.getAgentSnapshot(agentId)).resolves.toMatchObject({
      runtimeSettings: canonical,
    });
    expect(
      recordedRuntimeSettingsEvents(rolloutItems).at(-1)?.msg?.payload,
    ).toMatchObject({
      ...canonical,
      reason: "compensating_rollback",
    });
  });

  it("closes a failed prepared model successor with a durable compensation after restoring live state", async () => {
    const agentId = "model-mutation-compensation-order";
    const { runner, session, rolloutItems, rolloutStore } = makeTopLevelRunner({
      conversationId: agentId,
      canonicalRuntimeSettings: true,
    });
    let pending: {
      provider: string;
      model: string;
      profile?: string;
    } | null = null;
    let failNextStage = true;
    Object.defineProperty(session, "pendingProviderSwitch", {
      configurable: true,
      get: () => pending,
    });
    Object.assign(session, {
      stagePreparedProviderSwitch: (prepared: {
        pending: {
          provider: string;
          model: string;
          profile?: string;
        };
      }) => {
        if (failNextStage) {
          failNextStage = false;
          throw new Error("injected provider staging failure");
        }
        pending = prepared.pending;
      },
      setPendingProviderSwitch: (
        spec: {
          provider: string;
          model: string;
          profile?: string;
        } | null,
      ) => {
        pending = spec;
      },
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });

    const published: Array<{
      readonly pending: unknown;
      readonly payload: Record<string, unknown>;
    }> = [];
    const unsubscribe = session.eventLog.subscribe((event: unknown) => {
      const message = (
        event as {
          msg?: { type?: unknown; payload?: Record<string, unknown> };
        }
      ).msg;
      if (message?.type !== "run_runtime_settings_changed") return;
      published.push({
        pending,
        payload: message.payload ?? {},
      });
    });

    await expect(
      runner.setAgentModel(agentId, {
        model: "gpt-5",
        provider: "openai",
      }),
    ).rejects.toThrow("injected provider staging failure");
    unsubscribe();

    expect(pending).toBeNull();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      pending: null,
      payload: {
        reason: "compensating_rollback",
        provider: "grok",
        model: "base-model",
      },
    });
    const settingsEvents = rolloutItems.flatMap((item) => {
      const event = item as {
        payload?: {
          eventId?: string;
          msg?: { type?: unknown; payload?: Record<string, unknown> };
        };
      };
      return event.payload?.msg?.type === "run_runtime_settings_changed"
        ? [event.payload]
        : [];
    });
    expect(settingsEvents).toHaveLength(3);
    expect(settingsEvents[2]?.msg?.payload).toMatchObject({
      previousSettingsEventId: settingsEvents[1]?.eventId,
      rollbackOfSettingsEventId: settingsEvents[1]?.eventId,
      reason: "compensating_rollback",
    });
    expect(rolloutStore.recordRunRuntimeSettingsEvent).toHaveBeenCalledTimes(3);
    await expect(runner.getAgentSnapshot(agentId)).resolves.toMatchObject({
      runtimeSettingsEventId: settingsEvents[2]?.eventId,
      runtimeSettings: { provider: "grok", model: "base-model" },
    });
  });

  it("terminal-fences a model change when its fsynced settings event cannot publish", async () => {
    const agentId = "model-settings-publish-failure";
    const publishError = new Error("injected settings publish failure");
    const { runner, session, rolloutItems, sandboxExecutionBroker } =
      makeTopLevelRunner({
        conversationId: agentId,
        canonicalRuntimeSettings: true,
        runtimeSettingsFailpoint: {
          eventOrdinal: 2,
          phase: "publish",
          error: publishError,
        },
      });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });

    await expect(
      runner.setAgentModel(agentId, {
        model: "gpt-5",
        provider: "openai",
      }),
    ).rejects.toBe(publishError);

    const settingsEvents = recordedRuntimeSettingsEvents(rolloutItems);
    expect(settingsEvents).toHaveLength(2);
    expect(settingsEvents[1]?.msg?.payload).toMatchObject({
      reason: "model_provider_changed",
      provider: "openai",
      model: "gpt-5",
    });
    expect(session.pendingProviderSwitch).toEqual({
      provider: "openai",
      model: "gpt-5",
    });
    await expect(runner.getAgentSnapshot(agentId)).resolves.toMatchObject({
      runtimeSettingsEventId: settingsEvents[1]?.eventId,
      runtimeSettings: { provider: "openai", model: "gpt-5" },
    });
    expect(
      sandboxExecutionBroker.isClosedAfterLifecycleAuthorityFailure(),
    ).toBe(true);
    expect(session.abortTerminal).toHaveBeenCalledWith(
      "permission_authority_failure",
    );
    await expect(
      runner.setAgentModel(agentId, { model: "gpt-5-mini" }),
    ).rejects.toThrow(`AgenC daemon agent not running: ${agentId}`);
  });

  it("terminal-fences a model rollback when compensation cannot append", async () => {
    const agentId = "model-settings-compensation-append-failure";
    const compensationError = new Error(
      "injected settings compensation append failure",
    );
    const { runner, session, rolloutItems, sandboxExecutionBroker } =
      makeTopLevelRunner({
        conversationId: agentId,
        canonicalRuntimeSettings: true,
        runtimeSettingsFailpoint: {
          eventOrdinal: 3,
          phase: "before_append",
          error: compensationError,
        },
      });
    let pending: {
      provider: string;
      model: string;
      profile?: string;
    } | null = null;
    let failNextStage = true;
    Object.defineProperty(session, "pendingProviderSwitch", {
      configurable: true,
      get: () => pending,
    });
    Object.assign(session, {
      setPendingProviderSwitch: (
        spec: {
          provider: string;
          model: string;
          profile?: string;
        } | null,
      ) => {
        pending = spec;
        if (spec !== null && failNextStage) {
          failNextStage = false;
          throw new Error("injected provider staging failure");
        }
      },
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });

    await expect(
      runner.setAgentModel(agentId, {
        model: "gpt-5",
        provider: "openai",
      }),
    ).rejects.toThrow(`agent model rollback failed for ${agentId}`);

    expect(pending).toBeNull();
    const settingsEvents = recordedRuntimeSettingsEvents(rolloutItems);
    expect(settingsEvents).toHaveLength(2);
    expect(settingsEvents[1]?.msg?.payload).toMatchObject({
      reason: "model_provider_changed",
      provider: "openai",
      model: "gpt-5",
    });
    expect(
      sandboxExecutionBroker.isClosedAfterLifecycleAuthorityFailure(),
    ).toBe(true);
    expect(session.abortTerminal).toHaveBeenCalledWith(
      "permission_authority_failure",
    );
    await expect(
      runner.setAgentModel(agentId, { model: "gpt-5-mini" }),
    ).rejects.toThrow(`AgenC daemon agent not running: ${agentId}`);
  });

  it("setAgentPermissionMode mutates the real session permission registry", async () => {
    const { runner, permissionModeRegistry, permissionUpdates } =
      makeTopLevelRunner({
        conversationId: "parent-session",
        argv: ["node", "agenc"],
      });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });
    permissionUpdates.length = 0;
    (permissionModeRegistry.update as ReturnType<typeof vi.fn>).mockClear();

    const result = await runner.setAgentPermissionMode("parent-session", {
      sessionId: "session_1",
      mode: "plan",
    });

    expect(result).toEqual({
      applied: true,
      previousMode: "unattended",
      mode: "plan",
    });
    // The genuine daemon registry — the one the tool evaluator reads — is
    // updated to the new mode.
    expect(permissionModeRegistry.transact).toHaveBeenCalledTimes(1);
    expect(permissionUpdates[0]).toMatchObject({ mode: "plan" });
  });

  it("rejects the 4097th session rule before the production registry publishes", async () => {
    const agentId = "permission-rule-runner-bound";
    const {
      runner,
      permissionModeRegistry,
      permissionUpdates,
      forcePermissionContextForTesting,
    } = makeTopLevelRunner({
      conversationId: agentId,
      canonicalRuntimeSettings: true,
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });
    const existingRules = Array.from(
      { length: 4_096 },
      (_, index) => `tool-${index}`,
    );
    forcePermissionContextForTesting(
      createEmptyToolPermissionContext({
        mode: permissionModeRegistry.current().mode,
        alwaysAllowRules: { session: existingRules },
      }),
    );
    permissionUpdates.length = 0;

    await expect(
      runner.mutateAgentPermissionRule(agentId, {
        sessionId: agentId,
        operation: "add",
        behavior: "allow",
        rule: "overflow-tool",
      }),
    ).rejects.toThrow(/exceeds 4096 rules/u);

    expect(permissionUpdates).toEqual([]);
    expect(permissionModeRegistry.current().alwaysAllowRules.session).toEqual(
      existingRules,
    );
  });

  it("rejects session rule mutation at the managed-only policy boundary", async () => {
    const agentId = "permission-rule-managed-policy";
    const { runner, permissionModeRegistry, permissionUpdates } =
      makeTopLevelRunner({
        conversationId: agentId,
        canonicalRuntimeSettings: true,
        configLayers: [
          {
            scope: "managed",
            label: "managed-policy",
            config: { allowManagedPermissionRulesOnly: true },
          },
        ],
      });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });
    const before = permissionModeRegistry.current();
    permissionUpdates.length = 0;

    await expect(
      runner.mutateAgentPermissionRule(agentId, {
        sessionId: agentId,
        operation: "add",
        behavior: "allow",
        rule: "FileRead",
      }),
    ).rejects.toThrow(
      "Session permission rules are disabled by managed-only policy",
    );

    expect(permissionUpdates).toEqual([]);
    expect(permissionModeRegistry.current()).toBe(before);
  });

  it("publishes runtime settings only after the matching registry context is visible", async () => {
    const { runner, session, permissionModeRegistry } = makeTopLevelRunner({
      conversationId: "permission-publication-order",
      canonicalRuntimeSettings: true,
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });
    const observedModes: string[] = [];
    const unsubscribe = session.eventLog.subscribe((event: unknown) => {
      if (
        (event as { msg?: { type?: unknown } }).msg?.type ===
        "run_runtime_settings_changed"
      ) {
        observedModes.push(permissionModeRegistry.current().mode);
      }
    });

    await runner.setAgentPermissionMode("permission-publication-order", {
      sessionId: "session_1",
      mode: "plan",
    });
    unsubscribe();

    expect(observedModes).toEqual(["plan"]);
  });

  it("does not publish or mutate the registry when settings preparation fails", async () => {
    const { runner, session, permissionModeRegistry } = makeTopLevelRunner({
      conversationId: "permission-precommit-failure",
      canonicalRuntimeSettings: true,
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });
    const initialMode = permissionModeRegistry.current().mode;
    const observed: unknown[] = [];
    const unsubscribe = session.eventLog.subscribe((event: unknown) => {
      if (
        (event as { msg?: { type?: unknown } }).msg?.type ===
        "run_runtime_settings_changed"
      ) {
        observed.push(event);
      }
    });
    session.prepareEmit.mockImplementationOnce(() => {
      throw new Error("injected settings append failure");
    });

    await expect(
      runner.setAgentPermissionMode("permission-precommit-failure", {
        sessionId: "session_1",
        mode: "plan",
      }),
    ).rejects.toThrow("injected settings append failure");
    unsubscribe();

    expect(permissionModeRegistry.current().mode).toBe(initialMode);
    expect(observed).toEqual([]);
  });

  it("setAgentPermissionMode resolves the auto gate inside the target session", async () => {
    const { runner, permissionUpdates } = makeTopLevelRunner({
      conversationId: "parent-session-auto",
      argv: ["node", "agenc"],
      env: { XAI_API_KEY: "session-auto-key" },
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });
    permissionUpdates.length = 0;

    const result = await runner.setAgentPermissionMode("parent-session-auto", {
      sessionId: "session_1",
      mode: "auto",
    });

    expect(result).toEqual({
      applied: true,
      previousMode: "unattended",
      mode: "auto",
    });
    expect(permissionUpdates.at(-1)).toMatchObject({
      mode: "auto",
      autoModeActive: true,
    });
  });

  it.each([
    {
      label: "canonical auto availability is revoked",
      env: { XAI_API_KEY: "session-auto-key" },
      isAutoModeAvailable: false,
    },
    {
      label: "the live auto gate is closed",
      env: {},
      isAutoModeAvailable: true,
    },
  ])(
    "same-mode auto normalizes authority when $label",
    async ({ env, isAutoModeAvailable }) => {
      const {
        runner,
        permissionModeRegistry,
        permissionUpdates,
        forcePermissionContextForTesting,
      } = makeTopLevelRunner({
        conversationId: `parent-session-auto-revoked-${String(isAutoModeAvailable)}`,
        argv: ["node", "agenc"],
        canonicalRuntimeSettings: true,
        env,
      });
      const agentId = `parent-session-auto-revoked-${String(isAutoModeAvailable)}`;
      await runner.startAgent({ objective: "work", cwd: process.cwd() });
      forcePermissionContextForTesting(
        createEmptyToolPermissionContext({
          mode: "auto",
          autoModeActive: true,
          isAutoModeAvailable,
          alwaysAllowRules: { userSettings: ["FileRead"] },
          strippedDangerousRules: {
            userSettings: ["system.bash(python:*)"],
          },
        }),
      );
      permissionUpdates.length = 0;

      const result = await runner.setAgentPermissionMode(agentId, {
        sessionId: "session_1",
        mode: "auto",
      });

      expect(result).toEqual({
        applied: true,
        previousMode: "auto",
        mode: "default",
      });
      expect(permissionModeRegistry.current()).toMatchObject({
        mode: "default",
        autoModeActive: false,
        isAutoModeAvailable: false,
        alwaysAllowRules: {
          userSettings: ["FileRead", "system.bash(python:*)"],
        },
      });
      expect(
        permissionModeRegistry.current().strippedDangerousRules,
      ).toBeUndefined();
      expect(permissionUpdates).toHaveLength(1);
      expect(permissionUpdates[0]?.mode).toBe("default");
    },
  );

  it("setAgentPermissionMode refuses ordinary bypass RPC without consent", async () => {
    const { runner, permissionUpdates } = makeTopLevelRunner({
      conversationId: "parent-session",
      argv: ["node", "agenc"],
      canonicalRuntimeSettings: true,
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });
    permissionUpdates.length = 0;

    await expect(
      runner.setAgentPermissionMode("parent-session", {
        sessionId: "session_1",
        mode: "bypassPermissions",
      }),
    ).rejects.toThrow(/explicit consent/u);
    expect(permissionUpdates).toEqual([]);
  });

  it("setAgentPermissionMode binds exact cwd for explicit tool approval", async () => {
    const { runner, permissionUpdates } = makeTopLevelRunner({
      conversationId: "parent-session-tool-approval",
      argv: ["node", "agenc"],
      canonicalRuntimeSettings: true,
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });
    permissionUpdates.length = 0;

    const result = await runner.setAgentPermissionMode(
      "parent-session-tool-approval",
      {
        sessionId: "session_1",
        mode: "bypassPermissions",
        bypassAuthority: "operator_tool_approval",
      },
    );

    expect(result).toMatchObject({ applied: true, mode: "bypassPermissions" });
    expect(permissionUpdates.at(-1)).toMatchObject({
      mode: "bypassPermissions",
      bypassPermissionsAcceptedIn: [process.cwd()],
    });
  });

  it("serializes a default request behind bypass durability without a stale no-op", async () => {
    let releaseBypass!: () => void;
    const bypassGate = new Promise<void>((resolve) => {
      releaseBypass = resolve;
    });
    let bypassReachedGate!: () => void;
    const bypassAtGate = new Promise<void>((resolve) => {
      bypassReachedGate = resolve;
    });
    const { runner, permissionModeRegistry } = makeTopLevelRunner({
      conversationId: "permission-serialized-transition",
      canonicalRuntimeSettings: true,
      permissionBeforeUpdateGate: async (next) => {
        if (next.mode !== "bypassPermissions") return;
        bypassReachedGate();
        await bypassGate;
      },
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });

    const bypass = runner.setAgentPermissionMode(
      "permission-serialized-transition",
      {
        sessionId: "session_1",
        mode: "bypassPermissions",
        bypassAuthority: "operator_tool_approval",
      },
    );
    await bypassAtGate;
    const toDefault = runner.setAgentPermissionMode(
      "permission-serialized-transition",
      { sessionId: "session_1", mode: "default" },
    );
    let defaultSettled = false;
    void toDefault.finally(() => {
      defaultSettled = true;
    });
    await Promise.resolve();
    expect(defaultSettled).toBe(false);

    releaseBypass();
    await expect(bypass).resolves.toMatchObject({
      applied: true,
      previousMode: "unattended",
      mode: "bypassPermissions",
    });
    await expect(toDefault).resolves.toMatchObject({
      applied: true,
      previousMode: "bypassPermissions",
      mode: "default",
    });
    expect(permissionModeRegistry.current().mode).toBe("default");
  });

  it("getAgentHooksStatus maps the daemon session's real hooks runtime snapshot", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "parent-session",
      argv: ["node", "agenc"],
    });
    // Augment the fake session.services with a hooks runtime exposing the
    // genuine ConfiguredHooksRuntime read API the runner consults.
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        hooksRuntime: {
          sourcePath: () => "/home/agent/.agenc/config.toml",
          isDisabled: () => false,
          isHardSuppressed: () => false,
          isExecutionSuppressed: () => false,
          issues: () => [{ level: "warning", message: "heads up" }],
          listHooks: () => [
            {
              event: "PreToolUse",
              matcher: "Read",
              command: {
                type: "command",
                command: "printf ok",
                timeout_ms: 5000,
              },
              source: "config",
              sourcePath: "/home/agent/.agenc/config.toml",
              enabled: true,
              index: 0,
            },
          ],
          latestDiagnostics: () => [],
          setDisabled: vi.fn(),
        },
      },
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    const status = await runner.getAgentHooksStatus("parent-session");
    expect(status.available).toBe(true);
    expect(status.sourcePath).toBe("/home/agent/.agenc/config.toml");
    expect(status).toMatchObject({
      disabled: false,
      hardSuppressed: false,
      effectiveDisabled: false,
      suppressionReason: null,
    });
    expect(status.issues).toEqual([{ level: "warning", message: "heads up" }]);
    expect(status.hooks).toHaveLength(1);
    expect(status.hooks[0]).toMatchObject({
      event: "PreToolUse",
      matcher: "Read",
      index: 0,
      command: { type: "command", command: "printf ok", timeout_ms: 5000 },
    });
  });

  it("getAgentHooksStatus reports available:false when no hooks runtime is present", async () => {
    const { runner } = makeTopLevelRunner({
      conversationId: "parent-session",
      argv: ["node", "agenc"],
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    const status = await runner.getAgentHooksStatus("parent-session");
    expect(status).toEqual({
      available: false,
      sourcePath: "",
      disabled: true,
      hardSuppressed: false,
      effectiveDisabled: true,
      suppressionReason: null,
      issues: [],
      hooks: [],
      diagnostics: [],
    });
  });

  it("setAgentHooksDisabled toggles the daemon session's real hooks runtime", async () => {
    let disabled = false;
    const setDisabled = vi.fn((next: boolean) => {
      disabled = next;
    });
    const { runner, session } = makeTopLevelRunner({
      conversationId: "parent-session",
      argv: ["node", "agenc"],
    });
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        hooksRuntime: {
          sourcePath: () => "/home/agent/.agenc/config.toml",
          isDisabled: () => disabled,
          isHardSuppressed: () => false,
          isExecutionSuppressed: () => disabled,
          issues: () => [],
          listHooks: () => [],
          latestDiagnostics: () => [],
          setDisabled,
        },
      },
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    const result = await runner.setAgentHooksDisabled("parent-session", {
      disabled: true,
    });
    expect(result).toEqual({
      applied: true,
      disabled: true,
      hardSuppressed: false,
      effectiveDisabled: true,
      suppressionReason: "session_disabled",
    });
    expect(setDisabled).toHaveBeenCalledWith(true);
  });

  it("publishes a hooks successor only after the live hook authority changes and keeps attach snapshots behind the mutation", async () => {
    const agentId = "hooks-publication-order";
    let disabled = false;
    const { runner, session } = makeTopLevelRunner({
      conversationId: agentId,
      canonicalRuntimeSettings: true,
    });
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        hooksRuntime: {
          sourcePath: () => "/home/agent/.agenc/config.toml",
          isDisabled: () => disabled,
          isHardSuppressed: () => false,
          isExecutionSuppressed: () => disabled,
          issues: () => [],
          listHooks: () => [],
          latestDiagnostics: () => [],
          setDisabled: (next: boolean) => {
            disabled = next;
          },
        },
      },
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });

    const observations: Array<{
      readonly disabled: boolean;
      readonly snapshotSettled: boolean;
    }> = [];
    let attachSnapshot: ReturnType<typeof runner.getAgentSnapshot> | undefined;
    let snapshotSettled = false;
    let attachBarrierHeld = false;
    let attachBarrierProbe: Promise<void> | undefined;
    const unsubscribe = session.eventLog.subscribe((event: unknown) => {
      if (
        (event as { msg?: { type?: unknown } }).msg?.type !==
        "run_runtime_settings_changed"
      ) {
        return;
      }
      attachSnapshot = runner.getAgentSnapshot(agentId);
      void attachSnapshot.then(() => {
        snapshotSettled = true;
      });
      attachBarrierProbe = Promise.resolve().then(() => {
        attachBarrierHeld = !snapshotSettled;
      });
      observations.push({ disabled, snapshotSettled });
    });

    await expect(
      runner.setAgentHooksDisabled(agentId, { disabled: true }),
    ).resolves.toMatchObject({ applied: true, disabled: true });
    unsubscribe();

    expect(observations).toEqual([{ disabled: true, snapshotSettled: false }]);
    await expect(attachSnapshot).resolves.toMatchObject({
      runtimeSettings: { hooksDisabled: true },
    });
    await attachBarrierProbe;
    expect(attachBarrierHeld).toBe(true);
    expect(snapshotSettled).toBe(true);
  });

  it("closes a failed prepared hooks successor with a durable compensation after restoring live state", async () => {
    const agentId = "hooks-mutation-compensation-order";
    let disabled = false;
    let failNextDisable = true;
    const { runner, session, rolloutItems, rolloutStore } = makeTopLevelRunner({
      conversationId: agentId,
      canonicalRuntimeSettings: true,
    });
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        hooksRuntime: {
          sourcePath: () => "/home/agent/.agenc/config.toml",
          isDisabled: () => disabled,
          isHardSuppressed: () => false,
          isExecutionSuppressed: () => disabled,
          issues: () => [],
          listHooks: () => [],
          latestDiagnostics: () => [],
          setDisabled: (next: boolean) => {
            disabled = next;
            if (next && failNextDisable) {
              failNextDisable = false;
              throw new Error("injected hooks mutation failure");
            }
          },
        },
      },
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });

    const published: Array<{
      readonly disabled: boolean;
      readonly payload: Record<string, unknown>;
    }> = [];
    const unsubscribe = session.eventLog.subscribe((event: unknown) => {
      const message = (
        event as {
          msg?: { type?: unknown; payload?: Record<string, unknown> };
        }
      ).msg;
      if (message?.type !== "run_runtime_settings_changed") return;
      published.push({
        disabled,
        payload: message.payload ?? {},
      });
    });

    await expect(
      runner.setAgentHooksDisabled(agentId, { disabled: true }),
    ).rejects.toThrow("injected hooks mutation failure");
    unsubscribe();

    expect(disabled).toBe(false);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      disabled: false,
      payload: {
        reason: "compensating_rollback",
        hooksDisabled: false,
      },
    });
    const settingsEvents = rolloutItems.flatMap((item) => {
      const event = item as {
        payload?: {
          eventId?: string;
          msg?: { type?: unknown; payload?: Record<string, unknown> };
        };
      };
      return event.payload?.msg?.type === "run_runtime_settings_changed"
        ? [event.payload]
        : [];
    });
    expect(settingsEvents).toHaveLength(3);
    expect(settingsEvents[2]?.msg?.payload).toMatchObject({
      previousSettingsEventId: settingsEvents[1]?.eventId,
      rollbackOfSettingsEventId: settingsEvents[1]?.eventId,
      reason: "compensating_rollback",
    });
    expect(rolloutStore.recordRunRuntimeSettingsEvent).toHaveBeenCalledTimes(3);
  });

  it("terminal-fences a hook change when its fsynced settings event cannot publish", async () => {
    const agentId = "hooks-settings-publish-failure";
    const publishError = new Error("injected settings publish failure");
    let disabled = false;
    const { runner, session, rolloutItems, sandboxExecutionBroker } =
      makeTopLevelRunner({
        conversationId: agentId,
        canonicalRuntimeSettings: true,
        runtimeSettingsFailpoint: {
          eventOrdinal: 2,
          phase: "publish",
          error: publishError,
        },
      });
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        hooksRuntime: {
          sourcePath: () => "/home/agent/.agenc/config.toml",
          isDisabled: () => disabled,
          isHardSuppressed: () => false,
          isExecutionSuppressed: () => disabled,
          issues: () => [],
          listHooks: () => [],
          latestDiagnostics: () => [],
          setDisabled: (next: boolean) => {
            disabled = next;
          },
        },
      },
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });

    await expect(
      runner.setAgentHooksDisabled(agentId, { disabled: true }),
    ).rejects.toBe(publishError);

    expect(disabled).toBe(true);
    const settingsEvents = recordedRuntimeSettingsEvents(rolloutItems);
    expect(settingsEvents).toHaveLength(2);
    expect(settingsEvents[1]?.msg?.payload).toMatchObject({
      reason: "hooks_changed",
      hooksDisabled: true,
    });
    await expect(runner.getAgentSnapshot(agentId)).resolves.toMatchObject({
      runtimeSettingsEventId: settingsEvents[1]?.eventId,
      runtimeSettings: { hooksDisabled: true },
    });
    expect(
      sandboxExecutionBroker.isClosedAfterLifecycleAuthorityFailure(),
    ).toBe(true);
    expect(session.abortTerminal).toHaveBeenCalledWith(
      "permission_authority_failure",
    );
  });

  it("terminal-fences a hook rollback when compensation cannot append", async () => {
    const agentId = "hooks-settings-compensation-append-failure";
    const compensationError = new Error(
      "injected settings compensation append failure",
    );
    let disabled = false;
    let failNextDisable = true;
    const { runner, session, rolloutItems, sandboxExecutionBroker } =
      makeTopLevelRunner({
        conversationId: agentId,
        canonicalRuntimeSettings: true,
        runtimeSettingsFailpoint: {
          eventOrdinal: 3,
          phase: "before_append",
          error: compensationError,
        },
      });
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        hooksRuntime: {
          sourcePath: () => "/home/agent/.agenc/config.toml",
          isDisabled: () => disabled,
          isHardSuppressed: () => false,
          isExecutionSuppressed: () => disabled,
          issues: () => [],
          listHooks: () => [],
          latestDiagnostics: () => [],
          setDisabled: (next: boolean) => {
            disabled = next;
            if (next && failNextDisable) {
              failNextDisable = false;
              throw new Error("injected hooks mutation failure");
            }
          },
        },
      },
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });

    await expect(
      runner.setAgentHooksDisabled(agentId, { disabled: true }),
    ).rejects.toThrow(`agent hooks rollback failed for ${agentId}`);

    expect(disabled).toBe(false);
    const settingsEvents = recordedRuntimeSettingsEvents(rolloutItems);
    expect(settingsEvents).toHaveLength(2);
    expect(settingsEvents[1]?.msg?.payload).toMatchObject({
      reason: "hooks_changed",
      hooksDisabled: true,
    });
    expect(
      sandboxExecutionBroker.isClosedAfterLifecycleAuthorityFailure(),
    ).toBe(true);
    expect(session.abortTerminal).toHaveBeenCalledWith(
      "permission_authority_failure",
    );
  });

  it("keeps the mutable hook switch separate when enabling under immutable bare mode", async () => {
    let disabled = false;
    const setDisabled = vi.fn((next: boolean) => {
      disabled = next;
    });
    const { runner, session } = makeTopLevelRunner({
      conversationId: "parent-session",
      argv: ["node", "agenc", "--bare"],
      runtimeSimpleMode: true,
    });
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        hooksRuntime: {
          sourcePath: () => "/home/agent/.agenc/config.toml",
          isDisabled: () => disabled,
          isHardSuppressed: () => true,
          isExecutionSuppressed: () => disabled || true,
          issues: () => [],
          listHooks: () => [],
          latestDiagnostics: () => [],
          setDisabled,
        },
      },
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    await expect(
      runner.getAgentHooksStatus("parent-session"),
    ).resolves.toMatchObject({
      disabled: false,
      hardSuppressed: true,
      effectiveDisabled: true,
      suppressionReason: "bare_mode",
    });
    await runner.setAgentHooksDisabled("parent-session", { disabled: true });
    const enabled = await runner.setAgentHooksDisabled("parent-session", {
      disabled: false,
    });

    expect(enabled).toEqual({
      applied: true,
      disabled: false,
      hardSuppressed: true,
      effectiveDisabled: true,
      suppressionReason: "bare_mode",
    });
    expect(setDisabled).toHaveBeenNthCalledWith(1, true);
    expect(setDisabled).toHaveBeenNthCalledWith(2, false);
  });

  it("applyAgentConfig applies reasoning effort and stages a profile switch", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "parent-session",
      argv: ["node", "agenc"],
    });

    // Augment the fake session with the config-apply surfaces the real
    // in-process Session exposes: a ConfigStore with a "fast" profile, a
    // mutable sessionConfiguration, and the typed switch mutator.
    const stateObject = {
      sessionConfiguration: {
        collaborationMode: { model: "base-model", reasoningEffort: "medium" },
      },
    };
    const stagedSwitches: Array<{
      provider: string;
      model: string;
      profile?: string;
    }> = [];
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        configStore: {
          current: () => ({
            model: "base-model",
            model_provider: "openai",
            profiles: {
              fast: {
                model: "fast-model",
                model_provider: "openai",
                reasoning_effort: "high",
              },
            },
          }),
        },
      },
      setPendingProviderSwitch: (spec: {
        provider: string;
        model: string;
        profile?: string;
      }) => {
        stagedSwitches.push(spec);
      },
      stagePreparedProviderSwitch: (prepared: {
        pending: {
          provider: string;
          model: string;
          profile?: string;
        };
      }) => {
        stagedSwitches.push(prepared.pending);
        session.pendingProviderSwitch = prepared.pending;
      },
      state: {
        with: async (fn: (state: unknown) => void) => {
          fn(stateObject);
        },
      },
    });

    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    const result = await runner.applyAgentConfig("parent-session", {
      sessionId: "session_1",
      profile: "fast",
    });

    expect(result.applied).toBe(true);
    expect(result.summary).toContain("profile fast");
    expect(result.summary).toContain("reasoning effort ->high");
    // Model/provider delta staged through the genuine switch seam, with the
    // profile threaded so consumePendingProviderSwitch re-resolves it.
    expect(stagedSwitches).toEqual([
      { provider: "openai", model: "fast-model", profile: "fast" },
    ]);
    // Reasoning effort written onto the live sessionConfiguration — the piece
    // the model-switch seam alone cannot do.
    expect(
      stateObject.sessionConfiguration.collaborationMode.reasoningEffort,
    ).toBe("high");
  });

  it("publishes a config successor only after provider and session configuration mutation", async () => {
    const agentId = "config-publication-order";
    const { runner, session } = makeTopLevelRunner({
      conversationId: agentId,
      canonicalRuntimeSettings: true,
    });
    const liveState = session.state.unsafePeek();
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        configStore: {
          current: () => ({
            model: "base-model",
            model_provider: "grok",
            profiles: {
              fast: {
                model: "fast-model",
                model_provider: "openai",
                reasoning_effort: "high",
              },
            },
          }),
        },
      },
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });

    const observations: Array<{
      readonly pending: unknown;
      readonly reasoningEffort: unknown;
    }> = [];
    const unsubscribe = session.eventLog.subscribe((event: unknown) => {
      if (
        (event as { msg?: { type?: unknown } }).msg?.type !==
        "run_runtime_settings_changed"
      ) {
        return;
      }
      observations.push({
        pending: session.pendingProviderSwitch,
        reasoningEffort:
          liveState.sessionConfiguration.collaborationMode.reasoningEffort,
      });
    });

    await expect(
      runner.applyAgentConfig(agentId, {
        sessionId: "session_1",
        profile: "fast",
      }),
    ).resolves.toMatchObject({ applied: true });
    unsubscribe();

    expect(observations).toEqual([
      {
        pending: {
          provider: "openai",
          model: "fast-model",
          profile: "fast",
        },
        reasoningEffort: "high",
      },
    ]);
  });

  it("does not publish config settings when provider preparation fails", async () => {
    const agentId = "config-provider-preparation-failure";
    const { runner, session, rolloutItems } = makeTopLevelRunner({
      conversationId: agentId,
      canonicalRuntimeSettings: true,
    });
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        configStore: {
          current: () => ({
            model: "gpt-5",
            model_provider: "openai",
          }),
        },
      },
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });
    const before = recordedRuntimeSettingsEvents(rolloutItems);
    vi.mocked(session.prepareProviderSwitch).mockRejectedValueOnce(
      new Error("injected config provider preparation failure"),
    );

    await expect(
      runner.applyAgentConfig(agentId, { sessionId: agentId }),
    ).rejects.toThrow("injected config provider preparation failure");

    expect(session.pendingProviderSwitch).toBeNull();
    expect(recordedRuntimeSettingsEvents(rolloutItems)).toEqual(before);
    await expect(runner.getAgentSnapshot(agentId)).resolves.toMatchObject({
      runtimeSettings: { provider: "grok", model: "base-model" },
    });
  });

  it("restores provider and session configuration before publishing config compensation", async () => {
    const agentId = "config-mutation-compensation-order";
    const { runner, session, rolloutItems, rolloutStore } = makeTopLevelRunner({
      conversationId: agentId,
      canonicalRuntimeSettings: true,
    });
    const liveState = session.state.unsafePeek();
    let failNextConfigurationWrite = false;
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        configStore: {
          current: () => ({
            model: "base-model",
            model_provider: "grok",
            profiles: {
              fast: {
                model: "fast-model",
                model_provider: "openai",
                reasoning_effort: "high",
              },
            },
          }),
        },
      },
      state: {
        unsafePeek: () => liveState,
        with: async (apply: (state: typeof liveState) => void) => {
          await apply(liveState);
          if (failNextConfigurationWrite) {
            failNextConfigurationWrite = false;
            throw new Error("injected session configuration failure");
          }
        },
      },
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });
    failNextConfigurationWrite = true;

    const published: Array<{
      readonly pending: unknown;
      readonly reasoningEffort: unknown;
      readonly payload: Record<string, unknown>;
    }> = [];
    const unsubscribe = session.eventLog.subscribe((event: unknown) => {
      const message = (
        event as {
          msg?: { type?: unknown; payload?: Record<string, unknown> };
        }
      ).msg;
      if (message?.type !== "run_runtime_settings_changed") return;
      published.push({
        pending: session.pendingProviderSwitch,
        reasoningEffort:
          liveState.sessionConfiguration.collaborationMode.reasoningEffort,
        payload: message.payload ?? {},
      });
    });

    await expect(
      runner.applyAgentConfig(agentId, {
        sessionId: "session_1",
        profile: "fast",
      }),
    ).rejects.toThrow("injected session configuration failure");
    unsubscribe();

    expect(session.pendingProviderSwitch).toBeNull();
    expect(
      liveState.sessionConfiguration.collaborationMode.reasoningEffort,
    ).toBeUndefined();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      pending: null,
      reasoningEffort: undefined,
      payload: {
        reason: "compensating_rollback",
        profile: null,
        reasoningEffort: null,
      },
    });
    const settingsEvents = rolloutItems.flatMap((item) => {
      const event = item as {
        payload?: {
          eventId?: string;
          msg?: { type?: unknown; payload?: Record<string, unknown> };
        };
      };
      return event.payload?.msg?.type === "run_runtime_settings_changed"
        ? [event.payload]
        : [];
    });
    expect(settingsEvents).toHaveLength(3);
    expect(settingsEvents[2]?.msg?.payload).toMatchObject({
      previousSettingsEventId: settingsEvents[1]?.eventId,
      rollbackOfSettingsEventId: settingsEvents[1]?.eventId,
      reason: "compensating_rollback",
    });
    expect(rolloutStore.recordRunRuntimeSettingsEvent).toHaveBeenCalledTimes(3);
  });

  it("terminal-fences a profile change when its fsynced settings event cannot publish", async () => {
    const agentId = "config-settings-publish-failure";
    const publishError = new Error("injected settings publish failure");
    const {
      runner,
      session,
      sessionState,
      rolloutItems,
      sandboxExecutionBroker,
    } = makeTopLevelRunner({
      conversationId: agentId,
      canonicalRuntimeSettings: true,
      runtimeSettingsFailpoint: {
        eventOrdinal: 2,
        phase: "publish",
        error: publishError,
      },
    });
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        configStore: {
          current: () => ({
            model: "base-model",
            model_provider: "grok",
            profiles: {
              fast: {
                model: "fast-model",
                model_provider: "openai",
                reasoning_effort: "high",
              },
            },
          }),
        },
      },
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });

    await expect(
      runner.applyAgentConfig(agentId, {
        sessionId: "session_1",
        profile: "fast",
      }),
    ).rejects.toBe(publishError);

    expect(session.pendingProviderSwitch).toEqual({
      provider: "openai",
      model: "fast-model",
      profile: "fast",
    });
    expect(
      sessionState.sessionConfiguration.collaborationMode.reasoningEffort,
    ).toBe("high");
    const settingsEvents = recordedRuntimeSettingsEvents(rolloutItems);
    expect(settingsEvents).toHaveLength(2);
    expect(settingsEvents[1]?.msg?.payload).toMatchObject({
      reason: "config_applied",
      provider: "openai",
      model: "fast-model",
      profile: "fast",
      reasoningEffort: "high",
    });
    await expect(runner.getAgentSnapshot(agentId)).resolves.toMatchObject({
      runtimeSettingsEventId: settingsEvents[1]?.eventId,
      runtimeSettings: {
        provider: "openai",
        model: "fast-model",
        profile: "fast",
        reasoningEffort: "high",
      },
    });
    expect(
      sandboxExecutionBroker.isClosedAfterLifecycleAuthorityFailure(),
    ).toBe(true);
    expect(session.abortTerminal).toHaveBeenCalledWith(
      "permission_authority_failure",
    );
  });

  it("terminal-fences a profile rollback when compensation cannot append", async () => {
    const agentId = "config-settings-compensation-append-failure";
    const compensationError = new Error(
      "injected settings compensation append failure",
    );
    const { runner, session, rolloutItems, sandboxExecutionBroker } =
      makeTopLevelRunner({
        conversationId: agentId,
        canonicalRuntimeSettings: true,
        runtimeSettingsFailpoint: {
          eventOrdinal: 3,
          phase: "before_append",
          error: compensationError,
        },
      });
    const liveState = session.state.unsafePeek();
    let failNextConfigurationWrite = false;
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        configStore: {
          current: () => ({
            model: "base-model",
            model_provider: "grok",
            profiles: {
              fast: {
                model: "fast-model",
                model_provider: "openai",
                reasoning_effort: "high",
              },
            },
          }),
        },
      },
      state: {
        unsafePeek: () => liveState,
        with: async (apply: (state: typeof liveState) => void) => {
          await apply(liveState);
          if (failNextConfigurationWrite) {
            failNextConfigurationWrite = false;
            throw new Error("injected session configuration failure");
          }
        },
      },
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });
    failNextConfigurationWrite = true;

    await expect(
      runner.applyAgentConfig(agentId, {
        sessionId: "session_1",
        profile: "fast",
      }),
    ).rejects.toThrow(`agent config rollback failed for ${agentId}`);

    expect(session.pendingProviderSwitch).toBeNull();
    expect(
      liveState.sessionConfiguration.collaborationMode.reasoningEffort,
    ).toBeUndefined();
    const settingsEvents = recordedRuntimeSettingsEvents(rolloutItems);
    expect(settingsEvents).toHaveLength(2);
    expect(settingsEvents[1]?.msg?.payload).toMatchObject({
      reason: "config_applied",
      provider: "openai",
      model: "fast-model",
      profile: "fast",
      reasoningEffort: "high",
    });
    expect(
      sandboxExecutionBroker.isClosedAfterLifecycleAuthorityFailure(),
    ).toBe(true);
    expect(session.abortTerminal).toHaveBeenCalledWith(
      "permission_authority_failure",
    );
  });

  it("applyAgentConfig reloads config from disk when requested", async () => {
    const { runner, session, sessionState } = makeTopLevelRunner({
      conversationId: "parent-session",
      argv: ["node", "agenc"],
    });
    const reload = vi.fn(async () => ({}));
    const refreshFromAuthority = vi.fn(
      async (options?: { readonly onSandboxRefreshDeferred?: () => void }) => {
        options?.onSandboxRefreshDeferred?.();
        return {
          configuredServers: ["github"],
          requiredServers: ["github"],
        };
      },
    );
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        configStore: {
          ...(
            session as {
              services: { configStore: Record<string, unknown> };
            }
          ).services.configStore,
          current: () => ({ model: "base-model", model_provider: "openai" }),
          reload,
        },
        mcpManager: { refreshFromAuthority },
      },
      setPendingProviderSwitch: () => {},
      state: {
        with: async (fn: (state: typeof sessionState) => void) =>
          fn(sessionState),
      },
    });

    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    const result = await runner.applyAgentConfig("parent-session", {
      sessionId: "session_1",
      reload: true,
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(refreshFromAuthority).toHaveBeenCalledTimes(1);
    expect(reload.mock.invocationCallOrder[0]).toBeLessThan(
      refreshFromAuthority.mock.invocationCallOrder[0]!,
    );
    expect(result.applied).toBe(true);
    expect(result.summary).toContain("config reloaded from disk");
    expect(result.summary).toContain(
      "MCP refreshed (1 configured, 1 required)",
    );
  });

  it("serializes a blocked prepared config reload after a permission-mode publication without mixed authority", async () => {
    const agentId = "config-reload-permission-race";
    const {
      runner,
      session,
      configStore,
      configPublicationOptions,
      permissionModeRegistry,
      permissionUpdates,
      rolloutItems,
      sandboxExecutionBroker,
      sessionState,
    } = makeTopLevelRunner({
      conversationId: agentId,
      canonicalRuntimeSettings: true,
    });
    const originalPrepareReload = (
      configStore as {
        prepareReload(): Promise<unknown>;
      }
    ).prepareReload.bind(configStore);
    let markPreparedReload!: () => void;
    const preparedReload = new Promise<void>((resolve) => {
      markPreparedReload = resolve;
    });
    let releasePreparedReload!: () => void;
    const preparedReloadReleased = new Promise<void>((resolve) => {
      releasePreparedReload = resolve;
    });
    const configPublications: Array<{
      readonly registryMode: string;
      readonly brokerMode: string;
      readonly configurationMode: string;
    }> = [];
    Object.assign(configStore, {
      reload: vi.fn(async () => ({ sandbox_mode: "read-only" })),
      prepareReload: vi.fn(async () => {
        const prepared = (await originalPrepareReload()) as {
          publish(options?: CoordinatedConfigStorePublishOptions): void;
        };
        const publish = prepared.publish.bind(prepared);
        prepared.publish = (options?: CoordinatedConfigStorePublishOptions) => {
          publish(options);
          configPublications.push({
            registryMode: permissionModeRegistry.current().mode,
            brokerMode: sandboxExecutionBroker.mode,
            configurationMode:
              sessionState.sessionConfiguration.sandboxPolicy.value,
          });
        };
        markPreparedReload();
        await preparedReloadReleased;
        return prepared;
      }),
    });
    await runner.startAgent({ objective: "work", cwd: process.cwd() });
    permissionUpdates.length = 0;
    const publications: Array<{
      readonly reason: string;
      readonly settingsMode: string;
      readonly registryMode: string;
      readonly brokerMode: string;
      readonly configurationMode: string;
    }> = [];
    const unsubscribe = session.eventLog.subscribe((event: unknown) => {
      const message = (
        event as {
          readonly msg?: {
            readonly type?: unknown;
            readonly payload?: {
              readonly reason?: unknown;
              readonly permissionMode?: unknown;
            };
          };
        }
      ).msg;
      if (message?.type !== "run_runtime_settings_changed") return;
      publications.push({
        reason: String(message.payload?.reason),
        settingsMode: String(message.payload?.permissionMode),
        registryMode: permissionModeRegistry.current().mode,
        brokerMode: sandboxExecutionBroker.mode,
        configurationMode:
          sessionState.sessionConfiguration.sandboxPolicy.value,
      });
    });

    try {
      const reload = runner.applyAgentConfig(agentId, {
        sessionId: agentId,
        reload: true,
      });
      await preparedReload;
      let reloadSettled = false;
      void reload.then(
        () => {
          reloadSettled = true;
        },
        () => {
          reloadSettled = true;
        },
      );

      await expect(
        runner.setAgentPermissionMode(agentId, {
          sessionId: agentId,
          mode: "plan",
        }),
      ).resolves.toEqual({
        applied: true,
        previousMode: "unattended",
        mode: "plan",
      });
      expect(reloadSettled).toBe(false);
      expect(permissionModeRegistry.current().mode).toBe("plan");
      expect(sandboxExecutionBroker.mode).toBe("workspace_write");

      releasePreparedReload();
      await expect(reload).resolves.toMatchObject({
        applied: true,
        summary: expect.stringContaining("config reloaded from disk"),
      });

      expect(permissionUpdates.map(({ mode }) => mode)).toEqual([
        "plan",
        "plan",
      ]);
      expect(permissionModeRegistry.current().mode).toBe("plan");
      expect(sandboxExecutionBroker.mode).toBe("read_only");
      expect(sessionState.sessionConfiguration.sandboxPolicy.value).toBe(
        "read_only",
      );
      expect(publications).toEqual([
        {
          reason: "permission_mode_changed",
          settingsMode: "plan",
          registryMode: "plan",
          brokerMode: "workspace_write",
          configurationMode: "workspace_write",
        },
      ]);
      expect(configPublications).toEqual([
        {
          registryMode: "plan",
          brokerMode: "read_only",
          configurationMode: "read_only",
        },
      ]);
      expect(configPublicationOptions).toEqual([
        COORDINATED_CONFIG_STORE_PUBLICATION,
      ]);
      expect(
        recordedRuntimeSettingsEvents(rolloutItems).map(
          (event) => event.msg?.payload?.permissionMode,
        ),
      ).toEqual(["default", "plan"]);
    } finally {
      releasePreparedReload();
      unsubscribe();
    }
  });

  it("keeps the old MCP tool surface revoked until a coordinated config refresh is deferred and settled", async () => {
    const { runner, session, sessionState, sandboxExecutionBroker } =
      makeTopLevelRunner({
        conversationId: "config-mcp-refresh-quiesced",
        argv: ["node", "agenc"],
      });
    const reload = vi.fn(async () => ({}));
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    let releaseDeferral!: () => void;
    const deferralReleased = new Promise<void>((resolve) => {
      releaseDeferral = resolve;
    });
    let markResumeStarted!: () => void;
    const resumeStarted = new Promise<void>((resolve) => {
      markResumeStarted = resolve;
    });
    let releaseRefreshSettlement!: () => void;
    const refreshSettlementReleased = new Promise<void>((resolve) => {
      releaseRefreshSettlement = resolve;
    });
    let mcpSurface: "old" | "none" | "current" = "old";
    const oldToolExecution = vi.fn();
    const currentToolExecution = vi.fn();
    const callTool = vi.fn(async () => {
      if (mcpSurface === "old") {
        oldToolExecution();
        return { content: "old" };
      }
      if (mcpSurface === "current") {
        currentToolExecution();
        return { content: "current" };
      }
      return { content: "MCP authority is quiesced", isError: true };
    });
    const refreshFromAuthority = vi.fn(
      async (options?: { readonly onSandboxRefreshDeferred?: () => void }) => {
        markRefreshStarted();
        await deferralReleased;
        options?.onSandboxRefreshDeferred?.();
        await resumeStarted;
        await refreshSettlementReleased;
        mcpSurface = "current";
        return {
          configuredServers: ["current"],
          requiredServers: [],
        };
      },
    );
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        configStore: {
          ...(
            session as {
              services: { configStore: Record<string, unknown> };
            }
          ).services.configStore,
          current: () => ({}),
          reload,
        },
        mcpManager: { refreshFromAuthority, callTool },
      },
      state: {
        with: async (fn: (state: typeof sessionState) => void) =>
          fn(sessionState),
      },
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });
    const unregisterMcpLifecycle = registerSandboxExecutionLifecycleParticipant(
      sandboxExecutionBroker,
      {
        name: "test-runner-mcp-surface",
        quiesce: async () => {
          mcpSurface = "none";
        },
        resume: async () => {
          markResumeStarted();
        },
      },
    );

    try {
      let applySettled = false;
      const apply = runner.applyAgentConfig("config-mcp-refresh-quiesced", {
        sessionId: "session_1",
        reload: true,
      });
      void apply.then(
        () => {
          applySettled = true;
        },
        () => {
          applySettled = true;
        },
      );
      await refreshStarted;

      expect(applySettled).toBe(false);
      expect(mcpSurface).toBe("none");
      await expect(callTool()).resolves.toEqual({
        content: "MCP authority is quiesced",
        isError: true,
      });
      expect(oldToolExecution).not.toHaveBeenCalled();

      releaseDeferral();
      await resumeStarted;
      expect(applySettled).toBe(false);
      expect(mcpSurface).toBe("none");
      await expect(callTool()).resolves.toEqual({
        content: "MCP authority is quiesced",
        isError: true,
      });
      expect(oldToolExecution).not.toHaveBeenCalled();

      releaseRefreshSettlement();
      await expect(apply).resolves.toMatchObject({
        applied: true,
        summary: expect.stringContaining(
          "MCP refreshed (1 configured, 0 required)",
        ),
      });
      await expect(callTool()).resolves.toEqual({ content: "current" });
      expect(currentToolExecution).toHaveBeenCalledOnce();
      expect(oldToolExecution).not.toHaveBeenCalled();
    } finally {
      releaseDeferral();
      markResumeStarted();
      releaseRefreshSettlement();
      unregisterMcpLifecycle();
    }
  });

  it("closes daemon authority when MCP refresh fails after config publication", async () => {
    const { runner, session, sessionState, sandboxExecutionBroker } =
      makeTopLevelRunner({
        conversationId: "config-mcp-refresh-failure",
        argv: ["node", "agenc"],
      });
    const refreshFailure = new Error("injected MCP refresh failure");
    const reload = vi.fn(async () => ({}));
    const refreshFromAuthority = vi.fn(async () => {
      throw refreshFailure;
    });
    Object.assign(session, {
      services: {
        ...(session as { services: Record<string, unknown> }).services,
        configStore: {
          ...(
            session as {
              services: { configStore: Record<string, unknown> };
            }
          ).services.configStore,
          current: () => ({}),
          reload,
        },
        mcpManager: { refreshFromAuthority },
      },
      state: {
        with: async (fn: (state: typeof sessionState) => void) =>
          fn(sessionState),
      },
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    await expect(
      runner.applyAgentConfig("config-mcp-refresh-failure", {
        sessionId: "session_1",
        reload: true,
      }),
    ).rejects.toBe(refreshFailure);

    expect(refreshFromAuthority).toHaveBeenCalledTimes(1);
    expect(
      sandboxExecutionBroker.isClosedAfterLifecycleAuthorityFailure(),
    ).toBe(true);
    expect(session.abortTerminal).toHaveBeenCalledWith(
      "permission_authority_failure",
    );
    expect(() =>
      sandboxExecutionBroker.prepareSpawn("tool", {
        program: "git",
        args: ["status"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        trustedExecutable: true,
      }),
    ).toThrow(
      /daemon permission authority failed after canonical publication/u,
    );
  });

  it("setAgentPermissionMode rejects internal-only modes", async () => {
    const { runner } = makeTopLevelRunner({
      conversationId: "parent-session",
      argv: ["node", "agenc"],
    });
    await runner.startAgent({ objective: "work", cwd: "/workspace" });

    await expect(
      runner.setAgentPermissionMode("parent-session", {
        sessionId: "session_1",
        mode: "unattended",
      }),
    ).rejects.toThrow(/internal-only/);
  });

  it("passes the daemon AuthBackend into delegate bootstrap", async () => {
    const authBackend = makeAuthBackend("local", "managed-key");
    const { runner, bootstrap } = makeTopLevelRunner({
      conversationId: "parent-session",
      authBackend,
      argv: ["node", "agenc"],
    });

    await runner.startAgent({
      objective: "compile the daemon",
      unattendedAllow: [],
      unattendedDeny: [],
    });

    const bootstrapOptions = vi.mocked(bootstrap).mock.calls[0]?.[0];
    expect(bootstrapOptions).toMatchObject({
      argv: ["node", "agenc"],
      executionAdmissionAutonomous: true,
    });
    expect(bootstrapOptions?.authBackend).not.toBe(authBackend);
    await expect(
      bootstrapOptions?.authBackend?.vendKey("grok", "daemon-session"),
    ).resolves.toMatchObject({
      provider: "grok",
      sessionId: "daemon-session",
      apiKey: "managed-key",
    });
    expect(authBackend.vendKey).toHaveBeenCalledWith("grok", "daemon-session");
  });

  it("updateRuntimeConfig resets active daemon runtime provider-key cache after auth reload", async () => {
    const initialAuthBackend = makeAuthBackend("local", "managed-key-before");
    const reloadedAuthBackend = makeAuthBackend("remote", "managed-key-after");
    const { runner, bootstrap } = makeTopLevelRunner({
      conversationId: "parent-session",
      authBackend: initialAuthBackend,
      argv: ["node", "agenc"],
    });

    await runner.startAgent({
      objective: "before auth reload",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    const firstRuntimeAuthBackend =
      vi.mocked(bootstrap).mock.calls[0]?.[0].authBackend;
    if (firstRuntimeAuthBackend === undefined) {
      throw new Error("expected first daemon runtime auth backend");
    }
    expect(firstRuntimeAuthBackend.kind).toBe("local");
    await expect(
      firstRuntimeAuthBackend.vendKey("grok", "daemon-session"),
    ).resolves.toMatchObject({ apiKey: "managed-key-before" });

    runner.updateRuntimeConfig({ authBackend: reloadedAuthBackend });

    await expect(
      firstRuntimeAuthBackend.vendKey("grok", "daemon-session"),
    ).resolves.toMatchObject({ apiKey: "managed-key-after" });

    await runner.stopAgent("parent-session");

    await runner.startAgent({
      objective: "after auth reload",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    const secondRuntimeAuthBackend =
      vi.mocked(bootstrap).mock.calls[1]?.[0].authBackend;
    expect(secondRuntimeAuthBackend?.kind).toBe("remote");
    await expect(
      secondRuntimeAuthBackend?.vendKey("grok", "daemon-session"),
    ).resolves.toMatchObject({ apiKey: "managed-key-after" });
  });

  it("[managed-thread] returns conversationId as agentId with no delegate fork", async () => {
    const { runner, stub } = makeTopLevelRunner({
      conversationId: "session-storm-fix",
    });

    const result = await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });

    expect(result.agentId).toBe("session-storm-fix");
    expect(result.status).toBe("running");
    expect(stub.thread.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "user_input",
        input: "hi",
        submitOptions: expect.objectContaining({
          displayUserMessage: "hi",
        }),
      }),
    );
    const submittedInput = stub.thread.submit.mock.calls[0]?.[0];
    expect(JSON.stringify(submittedInput)).not.toContain(
      "You are a subagent spawned",
    );
  });

  it("[managed-thread] passes multimodal initialContent through submit verbatim", async () => {
    const { runner, stub } = makeTopLevelRunner({
      conversationId: "session-multimodal",
    });

    await runner.startAgent({
      objective: "ignored when initialContent is set",
      initialContent: [
        { type: "text", text: "hello" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,iVBOR" },
        },
      ],
      unattendedAllow: [],
      unattendedDeny: [],
    });

    expect(stub.thread.submit).toHaveBeenCalledTimes(1);
    expect(stub.thread.submit.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        type: "user_input",
        input: [
          { type: "text", text: "hello" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,iVBOR" },
          },
        ],
        submitOptions: expect.objectContaining({
          displayUserMessage: "hello\n[image]",
        }),
      }),
    );
  });

  it("[managed-thread] runs initial prompt hooks against initialContent rather than the objective", async () => {
    const inspectHook = vi.fn(() => ({}));
    const { runner, stub } = makeTopLevelRunner({
      conversationId: "session-initial-content-hook-authority",
      userPromptSubmitHooks: [inspectHook],
    });

    await runner.startAgent({
      objective: "benign routing label",
      initialContent: "actual raw initial model input",
      unattendedAllow: [],
      unattendedDeny: [],
    });

    expect(inspectHook).toHaveBeenCalledOnce();
    expect(inspectHook).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "actual raw initial model input",
        sessionId: "session-initial-content-hook-authority",
      }),
    );
    expect(inspectHook).not.toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "benign routing label" }),
    );
    expect(stub.thread.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "user_input",
        input: [{ type: "text", text: "actual raw initial model input" }],
      }),
    );
  });

  it("[managed-thread] carries validated Editor policy into the atomic first turn", async () => {
    const { runner, stub, session, bootstrap } = makeTopLevelRunner({
      conversationId: "session-editor-first-turn",
    });
    const initialEditorInteraction = {
      interactionId: "interaction-first-fix",
      kind: "fix" as const,
      policy: "proposal_only" as const,
      editorInstanceId: "editor-first-turn",
      bufferHandle: 7,
      changedtick: 12,
      contentSha256: "a".repeat(64),
      path: "/workspace/src/main.ts",
      range: {
        start: { line: 2, column: 3 },
        end: { line: 4, column: 0 },
      },
      selectionMode: "character" as const,
    };

    await runner.startAgent({
      objective: "internal editor prompt",
      initialContent: "internal editor prompt",
      initialDisplayUserMessage: "Fix the selected code",
      initialEditorInteraction,
      unattendedAllow: [],
      unattendedDeny: [],
    });

    expect(stub.thread.submit).toHaveBeenCalledWith({
      type: "user_input",
      input: [{ type: "text", text: "internal editor prompt" }],
      submitOptions: {
        displayUserMessage: "Fix the selected code",
        editorInteraction: initialEditorInteraction,
      },
    });
    expect(bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        deferSessionStartHooks: true,
        deferAgentStartupSideEffects: true,
      }),
    );
    expect(session.emit).toHaveBeenCalledWith({
      id: "user-initial-session-editor-first-turn",
      msg: {
        type: "user_message",
        payload: {
          message: "internal editor prompt",
          displayText: "Fix the selected code",
        },
      },
    });
  });

  it("[managed-thread] empty initialContent provisions a passive agent with no turn-1 submit", async () => {
    // The channel gateway (task 34) relies on this contract: agent.create
    // with `initialContent: []` bootstraps a live, runnable agent WITHOUT
    // submitting the objective as a first turn — zero LLM calls until the
    // first real message arrives via message.send.
    const { runner, stub } = makeTopLevelRunner({
      conversationId: "session-passive-gateway",
    });

    const result = await runner.startAgent({
      objective: "gateway session",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });

    expect(result.agentId).toBe("session-passive-gateway");
    expect(result.status).toBe("running");
    expect(stub.thread.submit).not.toHaveBeenCalled();
  });

  it("[managed-thread] rejects blocked initial prompt ingress before durable turn activation", async () => {
    const blockHook = vi.fn(() => ({
      blockingError: { blockingError: "initial prompt denied" },
    }));
    const { runner, session, control, stub, rolloutStore, shutdown } =
      makeTopLevelRunner({
        conversationId: "session-initial-prompt-blocked",
        userPromptSubmitHooks: [blockHook],
      });

    await expect(
      runner.startAgent({
        objective: "blocked initial prompt",
        unattendedAllow: [],
        unattendedDeny: [],
      }),
    ).rejects.toMatchObject({
      code: "PROMPT_BLOCKED",
      message: expect.stringContaining("initial prompt denied"),
    });

    expect(blockHook).toHaveBeenCalledOnce();
    expect(blockHook).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "blocked initial prompt",
        sessionId: "session-initial-prompt-blocked",
      }),
    );
    const emittedTypes = vi
      .mocked(session.emit)
      .mock.calls.map(
        ([event]) => (event as { msg?: { type?: unknown } }).msg?.type,
      );
    expect(emittedTypes).not.toContain("user_message");
    expect(rolloutStore.recordRunStartupActivationEvent).not.toHaveBeenCalled();
    expect(stub.thread.submit).not.toHaveBeenCalled();
    expect(control.sendInput).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("[managed-thread] buffers initial prompt warnings for canonical delivery after attach", async () => {
    const throwingHook = vi.fn(() => {
      throw new Error("startup prompt hook exploded");
    });
    const { runner, stub } = makeTopLevelRunner({
      conversationId: "session-initial-prompt-warning",
      userPromptSubmitHooks: [throwingHook],
    });
    const emitted: JsonObject[] = [];

    await runner.startAgent({
      objective: "continue after non-blocking hook failure",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-initial-prompt-warning", {
      sessionId: "session_1",
      emit: async (notification) => {
        emitted.push(notification);
      },
    });

    expect(throwingHook).toHaveBeenCalledOnce();
    expect(stub.thread.submit).toHaveBeenCalledOnce();
    expect(emitted).toContainEqual(
      expect.objectContaining({
        jsonrpc: JSON_RPC_VERSION,
        method: "event.session_event",
        params: expect.objectContaining({
          sessionId: "session_1",
          agentId: "session-initial-prompt-warning",
          event: expect.objectContaining({
            type: "warning",
            payload: expect.objectContaining({
              cause: "user_prompt_submit_hook_threw",
              message: expect.stringContaining("startup prompt hook exploded"),
            }),
          }),
        }),
      }),
    );
  });

  it("[managed-thread] defers a cold Editor session without a model turn or Agent startup side effects", async () => {
    const { runner, stub, bootstrap } = makeTopLevelRunner({
      conversationId: "session-cold-editor-prediction",
    });

    const result = await runner.startAgent({
      objective: "AgenC Editor workspace",
      deferInitialTurn: true,
      unattendedAllow: [],
      unattendedDeny: [],
    });

    expect(result.agentId).toBe("session-cold-editor-prediction");
    expect(stub.thread.submit).not.toHaveBeenCalled();
    expect(bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        deferSessionStartHooks: true,
        deferAgentStartupSideEffects: true,
      }),
    );
  });

  it("[managed-thread] emits visible user message before routing attached input", async () => {
    const { runner, control } = makeTopLevelRunner({
      conversationId: "session-user-order",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-user-order", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;
    control.sendInput.mockImplementation(async () => {
      expect(emitted[0]).toMatchObject({
        jsonrpc: JSON_RPC_VERSION,
        method: "event.session_event",
        params: {
          sessionId: "session_1",
          agentId: "session-user-order",
          eventId: "event:3",
          acceptedAt: "2026-05-01T12:00:01.000Z",
          event: {
            id: "message_1",
            type: "user_message",
            messageId: "message_1",
            streamId: "stream_1",
            acceptedAt: "2026-05-01T12:00:01.000Z",
            payload: {
              message: "continue",
              displayText: "continue",
            },
          },
        },
      });
    });

    await runner.submitAgentMessage("session-user-order", {
      sessionId: "session_1",
      content: "continue",
      originalContent: "continue",
      messageId: "message_1",
      streamId: "stream_1",
      acceptedAt: "2026-05-01T12:00:01.000Z",
    });

    expect(control.sendInput).toHaveBeenCalledWith(
      "session-user-order",
      "continue",
      expect.objectContaining({ displayUserMessage: "continue" }),
    );
    expect(emitted).toHaveLength(1);
  });

  it("[managed-thread] rejects blocked follow-up ingress before durable user-message and run activation", async () => {
    const blockHook = vi.fn(() => ({
      blockingError: { blockingError: "follow-up prompt denied" },
    }));
    const { runner, session, control, stub, rolloutStore } = makeTopLevelRunner(
      {
        conversationId: "session-follow-up-prompt-blocked",
        userPromptSubmitHooks: [blockHook],
      },
    );
    await runner.startAgent({
      objective: "passive hook test",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });
    vi.mocked(session.emit).mockClear();
    rolloutStore.recordRunStartupActivationEvent.mockClear();

    await expect(
      runner.submitAgentMessage("session-follow-up-prompt-blocked", {
        sessionId: "session_1",
        content: "blocked follow-up prompt",
        originalContent: "blocked follow-up prompt",
        messageId: "blocked-follow-up-message",
        streamId: "blocked-follow-up-stream",
        acceptedAt: "2026-08-25T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      code: "PROMPT_BLOCKED",
      message: expect.stringContaining("follow-up prompt denied"),
    });

    expect(blockHook).toHaveBeenCalledOnce();
    expect(blockHook).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "blocked follow-up prompt",
        sessionId: "session-follow-up-prompt-blocked",
      }),
    );
    const emittedTypes = vi
      .mocked(session.emit)
      .mock.calls.map(
        ([event]) => (event as { msg?: { type?: unknown } }).msg?.type,
      );
    expect(emittedTypes).not.toContain("user_message");
    expect(rolloutStore.recordRunStartupActivationEvent).not.toHaveBeenCalled();
    expect(stub.thread.submit).not.toHaveBeenCalled();
    expect(control.sendInput).not.toHaveBeenCalled();
    const snapshot = await runner.getAgentSnapshot(
      "session-follow-up-prompt-blocked",
    );
    expect(snapshot?.status).not.toBe("error");
  });

  it("[managed-thread] keeps the run alive after a blocked follow-up so a later allowed prompt can run", async () => {
    const blockHook = vi.fn((input: { readonly prompt: string }) =>
      input.prompt === "blocked follow-up prompt"
        ? { blockingError: { blockingError: "follow-up prompt denied" } }
        : {},
    );
    const { runner, control, stub } = makeTopLevelRunner({
      conversationId: "session-follow-up-prompt-survives-block",
      userPromptSubmitHooks: [blockHook],
    });
    await runner.startAgent({
      objective: "passive hook test",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });

    await expect(
      runner.submitAgentMessage("session-follow-up-prompt-survives-block", {
        sessionId: "session_1",
        content: "blocked follow-up prompt",
        originalContent: "blocked follow-up prompt",
        messageId: "blocked-follow-up-message",
        streamId: "blocked-follow-up-stream",
        acceptedAt: "2026-08-25T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      code: "PROMPT_BLOCKED",
    });
    const snapshot = await runner.getAgentSnapshot(
      "session-follow-up-prompt-survives-block",
    );
    expect(snapshot?.status).not.toBe("error");

    await expect(
      runner.submitAgentMessage("session-follow-up-prompt-survives-block", {
        sessionId: "session_1",
        content: "allowed follow-up prompt",
        originalContent: "allowed follow-up prompt",
        messageId: "allowed-follow-up-after-block",
        streamId: "allowed-follow-up-after-block-stream",
        acceptedAt: "2026-08-25T00:00:01.000Z",
      }),
    ).resolves.toMatchObject({ disposition: "started" });
    expect(control.sendInput).toHaveBeenCalledTimes(1);
    expect(stub.thread.submit).not.toHaveBeenCalled();
  });

  it("[managed-thread] replays a legacy hook-block error as session-only after attach", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-hook-block-legacy-error",
    });
    const started = await runner.startAgent({
      objective: "passive hook test",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });

    session.emit({
      id: "legacy-hook-block",
      msg: {
        type: "error",
        payload: {
          cause: "user_prompt_submit_hook_blocked",
          message: "policy denied",
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    const snapshot = await runner.getAgentSnapshot(
      "session-hook-block-legacy-error",
    );
    expect(snapshot?.status).not.toBe("error");

    const emitted: JsonObject[] = [];
    await runner.attachAgentSessionEvents(started.agentId, {
      sessionId: "session_1",
      emit: async (notification) => {
        emitted.push(notification);
      },
    });
    expect(emitted).toContainEqual(
      expect.objectContaining({
        jsonrpc: JSON_RPC_VERSION,
        method: "event.session_event",
        params: expect.objectContaining({
          sessionId: "session_1",
          agentId: "session-hook-block-legacy-error",
          event: expect.objectContaining({
            id: "legacy-hook-block",
            type: "error",
            payload: expect.objectContaining({
              cause: "user_prompt_submit_hook_blocked",
              message: "policy denied",
            }),
          }),
        }),
      }),
    );
    expect(emitted).not.toContainEqual(
      expect.objectContaining({
        method: "event.agent_status",
        params: expect.objectContaining({ message: "policy denied" }),
      }),
    );
  });

  it("[managed-thread] does not latch run status on a mid-turn stream_disconnected error", async () => {
    const { runner, session, control } = makeTopLevelRunner({
      conversationId: "session-stream-disconnected-telemetry",
    });
    const started = await runner.startAgent({
      objective: "keep-alive after reconnect",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });
    const emitted: JsonObject[] = [];
    await runner.attachAgentSessionEvents(started.agentId, {
      sessionId: "session_1",
      emit: async (notification) => {
        emitted.push(notification);
      },
    });

    session.emit({
      id: "stream-retry",
      msg: {
        type: "error",
        payload: {
          cause: "stream_disconnected",
          message: "Reconnecting after stream interruption (attempt 1): socket hang up",
          streamError: true,
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    const reconnectSnapshot = await runner.getAgentSnapshot(
      "session-stream-disconnected-telemetry",
    );
    expect(reconnectSnapshot?.status).not.toBe("error");
    expect(emitted).not.toContainEqual(
      expect.objectContaining({
        method: "event.agent_status",
        params: expect.objectContaining({
          status: "error",
          message: expect.stringContaining("Reconnecting after stream interruption"),
        }),
      }),
    );

    await expect(
      runner.submitAgentMessage("session-stream-disconnected-telemetry", {
        sessionId: "session_1",
        content: "continue after reconnect",
        originalContent: "continue after reconnect",
        messageId: "message-after-reconnect",
        streamId: "stream-after-reconnect",
        acceptedAt: "2026-09-01T00:00:01.000Z",
      }),
    ).resolves.toMatchObject({ disposition: "started" });
    expect(control.sendInput).toHaveBeenCalled();
  });

  it("[managed-thread] does not latch run status on a mid-turn stop_hook_threw error", async () => {
    const { runner, session, control } = makeTopLevelRunner({
      conversationId: "session-stop-hook-threw-telemetry",
    });
    await runner.startAgent({
      objective: "keep-alive after stop hook throw",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });

    session.emit({
      id: "stop-hook-threw",
      msg: {
        type: "error",
        payload: {
          cause: "stop_hook_threw",
          message: "lint threw",
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    const hookSnapshot = await runner.getAgentSnapshot(
      "session-stop-hook-threw-telemetry",
    );
    expect(hookSnapshot?.status).not.toBe("error");

    await expect(
      runner.submitAgentMessage("session-stop-hook-threw-telemetry", {
        sessionId: "session_1",
        content: "continue after stop hook throw",
        originalContent: "continue after stop hook throw",
        messageId: "message-after-stop-hook-throw",
        streamId: "stream-after-stop-hook-throw",
        acceptedAt: "2026-09-01T00:00:02.000Z",
      }),
    ).resolves.toMatchObject({ disposition: "started" });
    expect(control.sendInput).toHaveBeenCalled();
  });

  it("[managed-thread] treats new session error causes as diagnostics", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-future-error-diagnostic",
    });
    await runner.startAgent({
      objective: "keep-alive after a diagnostic",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });

    session.emit({
      id: "future-diagnostic",
      msg: {
        type: "error",
        payload: {
          cause: "future_mid_turn_diagnostic",
          message: "diagnostic event",
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    await expect(
      runner.getAgentSnapshot("session-future-error-diagnostic"),
    ).resolves.toMatchObject({ status: expect.not.stringMatching(/^error$/u) });
  });

  it("[managed-thread] keeps the run alive after a mid-turn compact skip", async () => {
    const { runner, session, control, stub } = makeTopLevelRunner({
      conversationId: "session-survives-mid-turn-compact-skip",
    });
    await runner.startAgent({
      objective: "passive compact test",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });

    session.emit({
      id: "legacy-mid-turn-compact-skip",
      msg: {
        type: "error",
        payload: {
          cause: "mid_turn_compact_failed",
          message:
            "mid_turn_compact_skipped: lastSamplePromptTokens=200000 limit=180000",
        },
      },
    });
    session.emitPhaseEvent({
      type: "turn_complete",
      content: "need a tool",
      usage: {
        promptTokens: 200_000,
        completionTokens: 10,
        totalTokens: 200_010,
      },
      stopReason: "compact_failed",
      error: new Error(
        "mid_turn_compact_skipped: lastSamplePromptTokens=200000 limit=180000",
      ),
    });
    await new Promise((resolve) => setImmediate(resolve));

    const snapshot = await runner.getAgentSnapshot(
      "session-survives-mid-turn-compact-skip",
    );
    expect(snapshot?.status).not.toBe("error");

    await expect(
      runner.submitAgentMessage("session-survives-mid-turn-compact-skip", {
        sessionId: "session_1",
        content: "continue after compact skip",
        originalContent: "continue after compact skip",
        messageId: "after-compact-skip",
        streamId: "after-compact-skip-stream",
        acceptedAt: "2026-08-31T00:00:01.000Z",
      }),
    ).resolves.toMatchObject({ disposition: "started" });
    expect(control.sendInput).toHaveBeenCalledTimes(1);
    expect(stub.thread.submit).not.toHaveBeenCalled();
  });

  it("[managed-thread] applies owning-session hook context to follow-up model input exactly once", async () => {
    const contextHook = vi.fn(() => ({
      additionalContexts: ["session-owned daemon context"],
    }));
    const { runner, session, control } = makeTopLevelRunner({
      conversationId: "session-follow-up-hook-context",
      userPromptSubmitHooks: [contextHook],
    });
    await runner.startAgent({
      objective: "passive hook test",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });

    await expect(
      runner.submitAgentMessage("session-follow-up-hook-context", {
        sessionId: "session_1",
        content: "allowed follow-up prompt",
        originalContent: "allowed follow-up prompt",
        messageId: "allowed-follow-up-message",
        streamId: "allowed-follow-up-stream",
        acceptedAt: "2026-08-25T00:00:01.000Z",
      }),
    ).resolves.toMatchObject({ disposition: "started" });

    expect(contextHook).toHaveBeenCalledOnce();
    expect(contextHook).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "allowed follow-up prompt" }),
    );
    expect(control.sendInput).toHaveBeenCalledTimes(1);
    expect(control.sendInput).toHaveBeenCalledWith(
      "session-follow-up-hook-context",
      expect.stringContaining("session-owned daemon context"),
      expect.objectContaining({
        displayUserMessage: "allowed follow-up prompt",
      }),
    );
    const sendInputCalls = control.sendInput.mock
      .calls as unknown as ReadonlyArray<readonly unknown[]>;
    const modelInput = sendInputCalls[0]?.[1];
    expect(typeof modelInput).toBe("string");
    expect(
      String(modelInput).match(/session-owned daemon context/g),
    ).toHaveLength(1);
    expect(session.emit).toHaveBeenCalledWith({
      id: "allowed-follow-up-message",
      msg: {
        type: "user_message",
        payload: {
          message: "allowed follow-up prompt",
          displayText: "allowed follow-up prompt",
          messageId: "allowed-follow-up-message",
          streamId: "allowed-follow-up-stream",
          acceptedAt: "2026-08-25T00:00:01.000Z",
        },
      },
    });
  });

  it("[managed-thread] correlates every live turn surface to one admitted message", async () => {
    const { runner, control, session } = makeTopLevelRunner({
      conversationId: "session-correlated-events",
    });
    const emitted: JsonObject[] = [];
    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-correlated-events", {
      sessionId: "session_1",
      emit: (notification) => emitted.push(notification),
    });
    emitted.length = 0;
    control.sendInput.mockImplementationOnce(async () => {
      session.emit({
        id: "stale-complete",
        msg: {
          type: "turn_complete",
          payload: { turnId: "turn-before", lastAgentMessage: "older answer" },
        },
      });
      session.emit({
        id: "turn-correlated",
        msg: {
          type: "turn_started",
          payload: { turnId: "turn-correlated" },
        },
      });
      session.emit({
        id: "delta-correlated",
        msg: { type: "agent_message_delta", payload: { delta: "hello" } },
      });
      session.emit({
        id: "permission-correlated",
        msg: {
          type: "request_permissions",
          payload: {
            callId: "permission-correlated",
            toolName: "Read",
            turnId: "turn-correlated",
            permissions: ["read"],
          },
        },
      });
      session.emit({
        id: "input-correlated",
        msg: {
          type: "request_user_input",
          payload: {
            callId: "input-correlated",
            turnId: "turn-correlated",
            questions: [],
          },
        },
      });
      session.emit({
        id: "elicitation-correlated",
        msg: {
          type: "mcp_elicitation_request",
          payload: {
            serverName: "server",
            requestId: "elicitation-correlated",
            turnId: "turn-correlated",
            request: {},
          },
        },
      });
      session.emit({
        id: "empty-committed-correlated",
        msg: {
          type: "agent_message",
          payload: { message: "" },
        },
      });
      session.emit({
        id: "committed-correlated",
        msg: {
          type: "agent_message",
          payload: { message: "hello" },
        },
      });
      session.emit({
        id: "complete-correlated",
        msg: {
          type: "turn_complete",
          payload: { turnId: "turn-correlated", lastAgentMessage: "hello" },
        },
      });
    });

    await runner.submitAgentMessage("session-correlated-events", {
      sessionId: "session_1",
      content: "correlate me",
      originalContent: "correlate me",
      messageId: "client-correlated",
      streamId: "client-correlated",
      acceptedAt: "2026-08-17T00:00:00.000Z",
    });

    expect(
      emitted.find((notification) => {
        const params = notification.params as JsonObject | undefined;
        const event = params?.event as JsonObject | undefined;
        return event?.type === "user_message";
      })?.params,
    ).toMatchObject({
      clientMessageId: "client-correlated",
      messageId: "client-correlated",
      event: {
        messageId: "client-correlated",
        payload: { messageId: "client-correlated" },
      },
    });
    expect(
      (
        emitted.find((notification) => {
          const params = notification.params as JsonObject | undefined;
          return params?.eventId === "stale-complete";
        })?.params as JsonObject | undefined
      )?.clientMessageId,
    ).toBeUndefined();

    const turnNotifications = emitted.filter((notification) => {
      const params = notification.params as JsonObject | undefined;
      return params?.turnId === "turn-correlated";
    });
    expect(turnNotifications).toHaveLength(8);
    for (const notification of turnNotifications) {
      expect(notification.params).toMatchObject({
        runId: "session-correlated-events",
        historyEpoch: "history:session-correlated-events:initial",
        turnId: "turn-correlated",
        clientMessageId: "client-correlated",
      });
    }
    expect(
      turnNotifications.find(
        (notification) => notification.method === "event.message_chunk",
      )?.params,
    ).toMatchObject({ messageId: "assistant:turn-correlated:0" });
    expect(
      turnNotifications.find(
        (notification) =>
          notification.method === "event.session_event" &&
          (
            (notification.params as JsonObject | undefined)?.event as
              JsonObject | undefined
          )?.id === "committed-correlated",
      )?.params,
    ).toMatchObject({ messageId: "assistant:turn-correlated:1" });

    await expect(
      runner.getAgentSessionTranscriptV2("session-correlated-events", {
        sessionId: "session_1",
      }),
    ).resolves.toMatchObject({
      runId: "session-correlated-events",
      historyEpoch: "history:session-correlated-events:initial",
      messages: expect.arrayContaining([
        expect.objectContaining({
          messageId: "client-correlated",
          clientMessageId: "client-correlated",
          turnId: "turn-correlated",
        }),
        expect.objectContaining({
          messageId: "assistant:turn-correlated:1",
          clientMessageId: "client-correlated",
          turnId: "turn-correlated",
        }),
      ]),
    });
  });

  it("[managed-thread] gives an uncorrelated committed message the same live and snapshot id", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-background-commit-id",
    });
    const emitted: JsonObject[] = [];
    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-background-commit-id", {
      sessionId: "session_1",
      emit: (notification) => emitted.push(notification),
    });
    emitted.length = 0;

    session.emit({
      id: "background-commit",
      msg: {
        type: "agent_message",
        payload: { message: "background answer" },
      },
    });
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    const liveParams = emitted[0]?.params as JsonObject | undefined;
    const liveMessageId = liveParams?.messageId;
    const snapshot = await runner.getAgentSessionTranscriptV2(
      "session-background-commit-id",
      { sessionId: "session_1" },
    );
    const committed = snapshot.messages.find(
      (message) => message.text === "background answer",
    );
    expect(liveMessageId).toBe(`assistant:${String(liveParams?.eventId)}`);
    expect(committed?.messageId).toBe(liveMessageId);
  });

  it("[managed-thread] retains turn identity for a hidden-user assistant commit", async () => {
    const { runner, control, session, rolloutItems } = makeTopLevelRunner({
      conversationId: "session-hidden-user-id",
    });
    const emitted: JsonObject[] = [];
    await runner.startAgent({
      objective: "passive",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-hidden-user-id", {
      sessionId: "session_1",
      emit: (notification) => emitted.push(notification),
    });
    emitted.length = 0;
    control.sendInput.mockImplementationOnce(async () => {
      session.emit({
        id: "turn-hidden",
        msg: {
          type: "turn_started",
          payload: { turnId: "turn-hidden" },
        },
      });
      session.emit({
        id: "assistant-hidden",
        msg: {
          type: "agent_message",
          payload: { message: "hidden answer" },
        },
      });
      session.emit({
        id: "complete-hidden",
        msg: {
          type: "turn_complete",
          payload: {
            turnId: "turn-hidden",
            lastAgentMessage: "hidden answer",
          },
        },
      });
    });

    await runner.submitAgentMessage("session-hidden-user-id", {
      sessionId: "session_1",
      content: "internal prompt",
      originalContent: "internal prompt",
      displayUserMessage: null,
      messageId: "client-hidden",
      streamId: "client-hidden",
      acceptedAt: "2026-08-18T00:00:00.000Z",
    });

    expect(
      emitted.some((notification) => {
        const params = notification.params as JsonObject | undefined;
        const event = params?.event as JsonObject | undefined;
        return event?.type === "user_message";
      }),
    ).toBe(false);
    const liveCommit = emitted.find((notification) => {
      const params = notification.params as JsonObject | undefined;
      const event = params?.event as JsonObject | undefined;
      return event?.id === "assistant-hidden";
    });
    expect(liveCommit?.params).toMatchObject({
      turnId: "turn-hidden",
      clientMessageId: "client-hidden",
      messageId: "assistant:turn-hidden:0",
    });

    const snapshot = await runner.getAgentSessionTranscriptV2(
      "session-hidden-user-id",
      { sessionId: "session_1" },
    );
    expect(snapshot.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        text: "hidden answer",
        turnId: "turn-hidden",
        clientMessageId: "client-hidden",
        messageId: "assistant:turn-hidden:0",
      }),
    ]);
    expect(snapshot.messages[0]?.messageId).toBe(
      (liveCommit?.params as JsonObject | undefined)?.messageId,
    );
    expect(
      rolloutItems.some((item) => {
        const event = item as {
          type?: unknown;
          payload?: { msg?: { type?: unknown } };
        };
        return (
          event.type === "event_msg" &&
          event.payload?.msg?.type === "message_submission"
        );
      }),
    ).toBe(true);
  });

  it("[managed-thread] keeps a hidden submission idempotent across a crash", async () => {
    const rolloutItems: unknown[] = [];
    const firstRuntime = makeTopLevelRunner({
      conversationId: "session-hidden-crash-retry",
      rolloutItems,
    });
    let releaseFirst!: () => void;
    firstRuntime.control.sendInput.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    await firstRuntime.runner.startAgent({
      objective: "passive",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });

    const acceptedThenCrashed = firstRuntime.runner.submitAgentMessage(
      "session-hidden-crash-retry",
      {
        sessionId: "session_1",
        content: "internal crash prompt",
        originalContent: "internal crash prompt",
        displayUserMessage: null,
        messageId: "client-hidden-crash",
        streamId: "client-hidden-crash",
        acceptedAt: "2026-08-18T00:00:00.000Z",
      },
    );
    await vi.waitFor(() => {
      expect(
        rolloutItems.some((item) => {
          const event = item as {
            type?: unknown;
            payload?: {
              msg?: { type?: unknown; payload?: Record<string, unknown> };
            };
          };
          return (
            event.type === "event_msg" &&
            event.payload?.msg?.type === "message_submission" &&
            event.payload.msg.payload?.messageId === "client-hidden-crash"
          );
        }),
      ).toBe(true);
    });

    const restarted = makeTopLevelRunner({
      conversationId: "session-hidden-crash-retry",
      rolloutItems,
    });
    await restarted.runner.startAgent({
      objective: "passive",
      initialContent: [],
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await expect(
      restarted.runner.submitAgentMessage("session-hidden-crash-retry", {
        sessionId: "session_1",
        content: "different internal prompt",
        originalContent: "different internal prompt",
        displayUserMessage: null,
        messageId: "client-hidden-crash",
        streamId: "client-hidden-crash",
        acceptedAt: "2026-08-18T00:30:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "CLIENT_MESSAGE_ID_CONFLICT" });
    await expect(
      restarted.runner.submitAgentMessage("session-hidden-crash-retry", {
        sessionId: "session_1",
        content: "internal crash prompt",
        originalContent: "internal crash prompt",
        displayUserMessage: null,
        messageId: "client-hidden-crash",
        streamId: "client-hidden-crash",
        acceptedAt: "2026-08-18T01:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      disposition: "duplicate",
      duplicateState: "incomplete",
      acceptedAt: "2026-08-18T00:00:00.000Z",
    });
    expect(restarted.control.sendInput).not.toHaveBeenCalled();
    await expect(
      restarted.runner.getAgentSessionTranscriptV2(
        "session-hidden-crash-retry",
        { sessionId: "session_1" },
      ),
    ).resolves.toMatchObject({ messages: [] });

    releaseFirst();
    await acceptedThenCrashed;
  });

  it("[managed-thread] joins a concurrent idempotent retry and rejects conflicting content", async () => {
    const { runner, control } = makeTopLevelRunner({
      conversationId: "session-idempotent-submit",
    });
    let releaseSend!: () => void;
    control.sendInput.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseSend = resolve;
        }),
    );
    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });

    const first = runner.submitAgentMessage("session-idempotent-submit", {
      sessionId: "session_1",
      content: "same prompt",
      originalContent: "same prompt",
      messageId: "client-message-1",
      streamId: "client-message-1",
      acceptedAt: "2026-08-17T00:00:00.000Z",
    });
    const retry = runner.submitAgentMessage("session-idempotent-submit", {
      sessionId: "session_1",
      content: "same prompt",
      originalContent: "same prompt",
      messageId: "client-message-1",
      streamId: "client-message-1",
      acceptedAt: "2026-08-17T00:00:01.000Z",
    });
    await expect(
      runner.submitAgentMessage("session-idempotent-submit", {
        sessionId: "session_1",
        content: "different prompt",
        originalContent: "different prompt",
        messageId: "client-message-1",
        streamId: "client-message-1",
        acceptedAt: "2026-08-17T00:00:02.000Z",
      }),
    ).rejects.toMatchObject({
      name: AgenCBackgroundAgentMessageError.name,
      code: "CLIENT_MESSAGE_ID_CONFLICT",
    });

    await vi.waitFor(() => expect(control.sendInput).toHaveBeenCalledOnce());
    releaseSend();
    await expect(first).resolves.toMatchObject({
      disposition: "started",
      terminal: { code: 0 },
    });
    await expect(retry).resolves.toMatchObject({
      disposition: "duplicate",
      duplicateState: "completed",
      terminal: { code: 0 },
    });
    expect(control.sendInput).toHaveBeenCalledOnce();
  });

  it("[managed-thread] rejects opt-in admission during the initial turn without changing legacy FIFO", async () => {
    const initialSubmissionStarted = Promise.withResolvers<void>();
    const releaseInitialSubmission = Promise.withResolvers<void>();
    const { runner, control, stub } = makeTopLevelRunner({
      conversationId: "session-strict-busy",
      threadInitialStatus: { status: "pending_init" } as AgentStatus,
    });
    stub.thread.submit.mockImplementationOnce(async () => {
      initialSubmissionStarted.resolve();
      await releaseInitialSubmission.promise;
      return "session-strict-busy";
    });
    await runner.startAgent({
      objective: "initial turn is running",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await initialSubmissionStarted.promise;

    await expect(
      runner.submitAgentMessage("session-strict-busy", {
        sessionId: "session_1",
        content: "strict second turn",
        originalContent: "strict second turn",
        messageId: "strict-message",
        streamId: "strict-message",
        acceptedAt: "2026-08-17T00:00:00.000Z",
        ifBusy: "reject",
      }),
    ).rejects.toMatchObject({ code: "TURN_IN_PROGRESS" });

    const legacySubmission = runner.submitAgentMessage("session-strict-busy", {
      sessionId: "session_1",
      content: "legacy queued turn",
      originalContent: "legacy queued turn",
      messageId: "legacy-message",
      streamId: "legacy-message",
      acceptedAt: "2026-08-17T00:00:01.000Z",
    });
    expect(control.sendInput).not.toHaveBeenCalled();
    releaseInitialSubmission.resolve();
    await expect(legacySubmission).resolves.toMatchObject({
      disposition: "started",
    });
    expect(control.sendInput).toHaveBeenCalledWith(
      "session-strict-busy",
      "legacy queued turn",
      expect.objectContaining({ displayUserMessage: "legacy queued turn" }),
    );
  });

  it("[managed-thread] accepts the first opt-in-admission message on a deferred spawn still in pending_init", async () => {
    const { runner, control } = makeTopLevelRunner({
      conversationId: "session-deferred-first-send",
      threadInitialStatus: { status: "pending_init" } as AgentStatus,
    });
    await runner.startAgent({
      objective: "Interactive session",
      deferInitialTurn: true,
      unattendedAllow: [],
      unattendedDeny: [],
    });

    // Nothing was submitted at spawn; the first message is what
    // initializes the thread, so ifBusy=reject must admit it.
    await expect(
      runner.submitAgentMessage("session-deferred-first-send", {
        sessionId: "session_1",
        content: "first user message",
        originalContent: "first user message",
        messageId: "deferred-first",
        streamId: "deferred-first",
        acceptedAt: "2026-08-20T00:00:00.000Z",
        ifBusy: "reject",
      }),
    ).resolves.toMatchObject({ disposition: "started" });
    expect(control.sendInput).toHaveBeenCalledWith(
      "session-deferred-first-send",
      "first user message",
      expect.objectContaining({ displayUserMessage: "first user message" }),
    );
  });

  it("[managed-thread] serializes direct shell behind a spawn-submitted initial turn without consulting thread status", async () => {
    const initialSubmissionStarted = Promise.withResolvers<void>();
    const releaseInitialSubmission = Promise.withResolvers<void>();
    const harness = makeTopLevelRunner({
      conversationId: "session-initial-pending-init",
      threadInitialStatus: { status: "pending_init" } as AgentStatus,
    });
    const shell = configureSessionShellHarness(harness);
    harness.stub.thread.submit.mockImplementationOnce(async () => {
      initialSubmissionStarted.resolve();
      await releaseInitialSubmission.promise;
      return "session-initial-pending-init";
    });
    await harness.runner.startAgent({
      objective: "initial turn is starting",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await initialSubmissionStarted.promise;
    harness.forcePermissionContextForTesting(
      createEmptyToolPermissionContext({
        mode: "bypassPermissions",
        isBypassPermissionsModeAvailable: true,
      }),
    );

    const execution = harness.runner.executeAgentShell(
      "session-initial-pending-init",
      {
        sessionId: "session-initial-pending-init",
        commandId: "shell-after-initial-1",
        command: "printf serialized",
      },
    );
    expect(shell.bashExecute).not.toHaveBeenCalled();
    releaseInitialSubmission.resolve();
    await expect(execution).resolves.toMatchObject({
      commandId: "shell-after-initial-1",
      isError: false,
      stdout: "shell stdout",
    });
    expect(shell.bashExecute).toHaveBeenCalledOnce();
  });

  it("[managed-thread] reports a persisted crash-tail retry as incomplete", async () => {
    const { runner, control } = makeTopLevelRunner({
      conversationId: "session-crash-tail",
      rolloutItems: [
        {
          type: "event_msg",
          payload: {
            id: "persisted-user",
            eventId: "persisted-user",
            seq: 1,
            msg: {
              type: "user_message",
              payload: {
                message: "retry me",
                messageId: "crashed-message",
                acceptedAt: "2026-08-17T00:00:00.000Z",
              },
            },
          },
        },
        {
          type: "event_msg",
          payload: {
            id: "persisted-turn",
            eventId: "persisted-turn",
            seq: 2,
            msg: {
              type: "turn_started",
              payload: { turnId: "crashed-turn" },
            },
          },
        },
      ],
    });
    await runner.startAgent({
      objective: "restored",
      unattendedAllow: [],
      unattendedDeny: [],
    });

    await expect(
      runner.submitAgentMessage("session-crash-tail", {
        sessionId: "session_1",
        content: "retry me",
        originalContent: "retry me",
        messageId: "crashed-message",
        streamId: "crashed-message",
        acceptedAt: "2026-08-17T01:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      disposition: "duplicate",
      duplicateState: "incomplete",
      turnId: "crashed-turn",
    });
    expect(control.sendInput).not.toHaveBeenCalled();
  });

  it("[managed-thread] does not treat a mid-turn error as the persisted terminal", async () => {
    const event = (id: string, seq: number, msg: Record<string, unknown>) => ({
      type: "event_msg",
      payload: { id, eventId: id, seq, msg },
    });
    const { runner, control } = makeTopLevelRunner({
      conversationId: "session-error-then-complete",
      rolloutItems: [
        event("user-1", 1, {
          type: "user_message",
          payload: {
            message: "retry me",
            messageId: "error-then-complete",
            acceptedAt: "2026-08-17T00:00:00.000Z",
          },
        }),
        event("turn-1", 2, {
          type: "turn_started",
          payload: { turnId: "turn-1" },
        }),
        event("hook-threw", 3, {
          type: "error",
          payload: {
            cause: "stop_hook_threw",
            message: "lint threw",
            turnId: "turn-1",
          },
        }),
        event("complete-1", 4, {
          type: "turn_complete",
          payload: { turnId: "turn-1", lastAgentMessage: "done" },
        }),
      ],
    });
    await runner.startAgent({
      objective: "restored",
      unattendedAllow: [],
      unattendedDeny: [],
    });

    await expect(
      runner.submitAgentMessage("session-error-then-complete", {
        sessionId: "session_1",
        content: "retry me",
        originalContent: "retry me",
        messageId: "error-then-complete",
        streamId: "error-then-complete",
        acceptedAt: "2026-08-17T01:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      disposition: "duplicate",
      duplicateState: "completed",
      turnId: "turn-1",
      terminal: { code: 0, message: "done" },
    });
    expect(control.sendInput).not.toHaveBeenCalled();
  });

  it("[managed-thread] never attributes a later completed turn to a crashed submission", async () => {
    const event = (id: string, seq: number, msg: Record<string, unknown>) => ({
      type: "event_msg",
      payload: { id, eventId: id, seq, msg },
    });
    const { runner, control } = makeTopLevelRunner({
      conversationId: "session-crash-before-next-turn",
      rolloutItems: [
        event("user-a", 1, {
          type: "user_message",
          payload: {
            message: "prompt A",
            messageId: "message-A",
            acceptedAt: "2026-08-17T00:00:00.000Z",
          },
        }),
        event("user-b", 2, {
          type: "user_message",
          payload: {
            message: "prompt B",
            messageId: "message-B",
            acceptedAt: "2026-08-17T00:01:00.000Z",
          },
        }),
        event("turn-b", 3, {
          type: "turn_started",
          payload: { turnId: "turn-B" },
        }),
        event("complete-b", 4, {
          type: "turn_complete",
          payload: { turnId: "turn-B", lastAgentMessage: "answer B" },
        }),
      ],
    });
    await runner.startAgent({
      objective: "restored",
      unattendedAllow: [],
      unattendedDeny: [],
    });

    await expect(
      runner.submitAgentMessage("session-crash-before-next-turn", {
        sessionId: "session_1",
        content: "prompt A",
        originalContent: "prompt A",
        messageId: "message-A",
        streamId: "message-A",
        acceptedAt: "2026-08-17T01:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      disposition: "duplicate",
      duplicateState: "incomplete",
    });
    expect(control.sendInput).not.toHaveBeenCalled();
  });

  it("[managed-thread] persists daemon-visible user prompts without duplicate live rows", async () => {
    const { runner, control, session } = makeTopLevelRunner({
      conversationId: "session-user-durable",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "first visible prompt",
      unattendedAllow: [],
      unattendedDeny: [],
    });

    expect(session.emit).toHaveBeenCalledWith({
      id: "user-initial-session-user-durable",
      msg: {
        type: "user_message",
        payload: {
          message: "first visible prompt",
          displayText: "first visible prompt",
        },
      },
    });

    await runner.attachAgentSessionEvents("session-user-durable", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });

    expect(
      emitted.filter(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          (
            event as {
              readonly params?: { readonly event?: { type?: string } };
            }
          ).params?.event?.type === "user_message",
      ),
    ).toHaveLength(1);

    emitted.length = 0;
    control.sendInput.mockImplementationOnce(async () => {
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        method: "event.session_event",
        params: {
          sessionId: "session_1",
          agentId: "session-user-durable",
          eventId: "event:3",
          event: {
            id: "message_2",
            type: "user_message",
            messageId: "message_2",
            streamId: "stream_2",
            acceptedAt: "2026-05-01T12:00:02.000Z",
            payload: {
              message: "second visible prompt",
              displayText: "second visible prompt",
            },
          },
        },
      });
    });

    await runner.submitAgentMessage("session-user-durable", {
      sessionId: "session_1",
      content: "second visible prompt",
      originalContent: "second visible prompt",
      messageId: "message_2",
      streamId: "stream_2",
      acceptedAt: "2026-05-01T12:00:02.000Z",
    });

    expect(control.sendInput).toHaveBeenCalledWith(
      "session-user-durable",
      "second visible prompt",
      expect.objectContaining({ displayUserMessage: "second visible prompt" }),
    );
    expect(emitted).toHaveLength(1);
    expect(session.emit).toHaveBeenCalledWith({
      id: "message_2",
      msg: {
        type: "user_message",
        payload: {
          message: "second visible prompt",
          displayText: "second visible prompt",
          messageId: "message_2",
          streamId: "stream_2",
          acceptedAt: "2026-05-01T12:00:02.000Z",
        },
      },
    });
  });

  it("[managed-thread] forwards durable queued prompt events to attached clients", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-queued-user-event",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-queued-user-event", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    session.emitSessionEvent({
      id: "queued-1",
      msg: {
        type: "user_message",
        payload: {
          message: "<system-reminder>wrapped</system-reminder>",
          displayText: "visible queued prompt",
          queuedCommandUuid: "queued-1",
        },
      },
    });

    await vi.waitFor(() => {
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.session_event",
          params: expect.objectContaining({
            sessionId: "session_1",
            agentId: "session-queued-user-event",
            eventId: "queued-1",
            event: expect.objectContaining({
              id: "queued-1",
              type: "user_message",
              payload: expect.objectContaining({
                displayText: "visible queued prompt",
                queuedCommandUuid: "queued-1",
              }),
            }),
          }),
        }),
      );
    });
  });

  it("[managed-thread] replays objective-only first prompts to attached clients", async () => {
    const { runner, stub } = makeTopLevelRunner({
      conversationId: "session-objective-first-prompt",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "audit first prompt",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    expect(stub.thread.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "user_input",
        input: "audit first prompt",
        submitOptions: expect.objectContaining({
          displayUserMessage: "audit first prompt",
        }),
      }),
    );

    await runner.attachAgentSessionEvents("session-objective-first-prompt", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });

    expect(emitted).toContainEqual(
      expect.objectContaining({
        method: "event.session_event",
        params: expect.objectContaining({
          sessionId: "session_1",
          agentId: "session-objective-first-prompt",
          event: expect.objectContaining({
            type: "user_message",
            payload: expect.objectContaining({
              message: "audit first prompt",
              displayText: "audit first prompt",
            }),
          }),
        }),
      }),
    );
  });

  it("[managed-thread] keeps legacy max-turn error records session-only", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-max-turns",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-max-turns", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });

    session.emitPhaseEvent({
      type: "turn_complete",
      content: "partial output",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      stopReason: "max_turns",
    });
    session.emit({
      eventId: "max-turn-error",
      id: "max-turn-error",
      msg: {
        type: "error",
        payload: {
          cause: "max_turns",
          message: "Agent exceeded maxTurns",
        },
      },
    });

    await vi.waitFor(() => {
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.session_event",
          params: expect.objectContaining({
            eventId: "max-turn-error",
            sequence: expect.any(Number),
            event: expect.objectContaining({
              type: "error",
              payload: expect.objectContaining({
                cause: "max_turns",
                message: "Agent exceeded maxTurns",
              }),
            }),
          }),
        }),
      );
    });
    expect(emitted).not.toContainEqual(
      expect.objectContaining({
        method: "event.agent_status",
        params: expect.objectContaining({ eventId: "max-turn-error" }),
      }),
    );
    await expect(
      runner.getAgentSnapshot("session-max-turns"),
    ).resolves.toMatchObject({ status: expect.not.stringMatching(/^error$/u) });
  });

  it("[managed-thread] keeps interrupted status internal and publishes canonical abort", async () => {
    const { runner, stub, session } = makeTopLevelRunner({
      conversationId: "session-interrupted-status",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-interrupted-status", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    stub.pushStatus({
      status: "interrupted",
      turnId: "turn-interrupted",
      endedAtMs: 123,
      reason: "user_cancel",
    } as AgentStatus);
    session.emit({
      eventId: "turn-interrupted",
      id: "turn-interrupted",
      msg: {
        type: "turn_aborted",
        payload: { turnId: "turn-interrupted", reason: "user_cancel" },
      },
    });

    await vi.waitFor(() => {
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.agent_status",
          params: expect.objectContaining({
            status: "idle",
            runStatus: "completed",
            turnId: "turn-interrupted",
            message: "user_cancel",
            eventId: "turn-interrupted",
            sequence: expect.any(Number),
          }),
        }),
      );
    });
    await expect(
      runner.getAgentSnapshot("session-interrupted-status"),
    ).resolves.toMatchObject({ status: "idle" });
  });

  it("[managed-thread] records cancelled turn phases as idle and accepts follow-up messages", async () => {
    const { runner, session, control } = makeTopLevelRunner({
      conversationId: "session-cancelled-turn-status",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-cancelled-turn-status", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    session.emitPhaseEvent({
      type: "turn_complete",
      content: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stopReason: "cancelled",
    });
    session.emit({
      eventId: "turn-cancelled",
      id: "turn-cancelled",
      msg: {
        type: "turn_aborted",
        payload: { turnId: "turn-cancelled", reason: "cancelled" },
      },
    });

    await vi.waitFor(() => {
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.agent_status",
          params: expect.objectContaining({
            status: "idle",
            runStatus: "completed",
            message: "cancelled",
            eventId: "turn-cancelled",
            sequence: expect.any(Number),
          }),
        }),
      );
    });
    await expect(
      runner.getAgentSnapshot("session-cancelled-turn-status"),
    ).resolves.toMatchObject({ status: "idle" });

    await expect(
      runner.submitAgentMessage("session-cancelled-turn-status", {
        sessionId: "session_1",
        content: "continue after cancel",
        originalContent: "continue after cancel",
        messageId: "message-after-cancel",
        streamId: "stream-after-cancel",
        acceptedAt: "2026-05-09T00:00:01.000Z",
      }),
    ).resolves.toMatchObject({
      disposition: "started",
      terminal: { code: 0 },
    });
    expect(control.sendInput).toHaveBeenCalledWith(
      "session-cancelled-turn-status",
      "continue after cancel",
      expect.objectContaining({ displayUserMessage: "continue after cancel" }),
    );
  });

  it("[managed-thread] closes active tool rows when a turn is interrupted", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-interrupted-tool",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-interrupted-tool", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    session.emitPhaseEvent({
      type: "tool_call",
      toolCall: {
        id: "call_1",
        name: "exec_command",
        arguments: '{"cmd":"sleep 120"}',
      },
    });
    session.emitPhaseEvent({
      type: "turn_complete",
      content: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stopReason: "cancelled",
    });
    session.emit({
      eventId: "tool-call-1-interrupted",
      id: "tool-call-1-interrupted",
      msg: {
        type: "tool_call_completed",
        payload: {
          callId: "call_1",
          result: "cancelled",
          isError: true,
          metadata: { cause: "user_interrupted" },
        },
      },
    });
    session.emit({
      eventId: "turn-tool-interrupted",
      id: "turn-tool-interrupted",
      msg: {
        type: "turn_aborted",
        payload: { turnId: "turn-tool-interrupted", reason: "cancelled" },
      },
    });

    await vi.waitFor(() => {
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.session_event",
          params: expect.objectContaining({
            event: expect.objectContaining({
              type: "tool_call_completed",
              payload: expect.objectContaining({
                callId: "call_1",
                isError: true,
                metadata: { cause: "user_interrupted" },
              }),
            }),
          }),
        }),
      );
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.agent_status",
          params: expect.objectContaining({
            status: "idle",
            runStatus: "completed",
            message: "cancelled",
          }),
        }),
      );
    });
  });

  it("[managed-thread] records completed turn phases as idle snapshots", async () => {
    const { runner, session } = makeTopLevelRunner({
      conversationId: "session-completed-turn-status",
    });
    const emitted: unknown[] = [];

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    await runner.attachAgentSessionEvents("session-completed-turn-status", {
      sessionId: "session_1",
      emit: async (event) => {
        emitted.push(event);
      },
    });
    emitted.length = 0;

    session.emitPhaseEvent({
      type: "turn_complete",
      content: "done",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      stopReason: "completed",
    });
    session.emit({
      eventId: "turn-completed",
      id: "turn-completed",
      msg: {
        type: "turn_complete",
        payload: {
          turnId: "turn-completed",
          lastAgentMessage: "done",
          completedAt: Date.now(),
          durationMs: 1,
        },
      },
    });

    await vi.waitFor(() => {
      expect(emitted).toContainEqual(
        expect.objectContaining({
          method: "event.agent_status",
          params: expect.objectContaining({
            status: "idle",
            runStatus: "completed",
            message: "done",
            eventId: "turn-completed",
            sequence: expect.any(Number),
          }),
        }),
      );
    });
    await expect(
      runner.getAgentSnapshot("session-completed-turn-status"),
    ).resolves.toMatchObject({ status: "idle" });
  });

  it("[managed-thread] interruptAgentTurn aborts the active session and submits interrupt op on managed thread", async () => {
    const { runner, session, stub } = makeTopLevelRunner({
      conversationId: "session-interrupt",
    });

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    stub.thread.submit.mockClear();

    const interrupted = await runner.interruptAgentTurn(
      "session-interrupt",
      "user_cancel",
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(interrupted).toBe(true);
    expect(session.abortAllTasks).toHaveBeenCalledWith("interrupted");
    expect(stub.thread.submit).toHaveBeenCalledWith({
      type: "interrupt",
      reason: "user_cancel",
    });
  });

  it("[managed-thread] interruptAgentTurn cascades cancellation to live child agents", async () => {
    const { runner, stub, control } = makeTopLevelRunner({
      conversationId: "session-interrupt-subtree",
    });

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    control.openThreadSpawnChildren.mockReturnValue([
      [
        "child-agent",
        {
          agentId: "child-agent",
          agentPath: "/root/worker",
          depth: 1,
        },
      ],
    ]);
    stub.thread.submit.mockClear();

    const interrupted = await runner.interruptAgentTurn(
      "session-interrupt-subtree",
      "user_cancel",
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(interrupted).toBe(true);
    expect(stub.thread.submit).toHaveBeenCalledWith({
      type: "interrupt",
      reason: "user_cancel",
    });
    expect(control.openThreadSpawnChildren).toHaveBeenCalledWith(
      "session-interrupt-subtree",
    );
    expect(control.interrupt).toHaveBeenCalledWith(
      "child-agent",
      "user_cancel",
    );
  });

  it("[managed-thread] scoped cancellation cannot interrupt a replacement turn", async () => {
    const { runner, stub, setActiveTurn, abortTurnIfActive, activeTurn } =
      makeTopLevelRunner({
        conversationId: "session-scoped-interrupt",
        scopedTurnCancellation: true,
      });
    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    stub.thread.submit.mockClear();
    setActiveTurn("turn-old");
    abortTurnIfActive.mockImplementationOnce(async (turnId: string) => {
      expect(turnId).toBe("turn-old");
      // Simulate the exact TOCTOU boundary: the scoped session operation has
      // removed the old turn, then a new turn starts while abort cleanup awaits.
      setActiveTurn("turn-new");
      return true;
    });

    await expect(
      runner.interruptAgentTurnIfMatches(
        "session-scoped-interrupt",
        "cancel old only",
        "turn-old",
      ),
    ).resolves.toEqual({ cancelled: true, activeTurnId: "turn-old" });
    expect(abortTurnIfActive).toHaveBeenCalledWith("turn-old", "interrupted");
    expect(activeTurn.unsafePeek()).toEqual({ turnId: "turn-new" });
    expect(stub.thread.submit).not.toHaveBeenCalled();
  });

  it("[managed-thread] stopAgent uses bootstrap lifecycle shutdown", async () => {
    const { runner, stub, control, shutdown } = makeTopLevelRunner({
      conversationId: "session-stop",
    });

    await runner.startAgent({
      objective: "hi",
      unattendedAllow: [],
      unattendedDeny: [],
    });

    await runner.stopAgent("session-stop", "user_stopped");

    expect(shutdown).toHaveBeenCalledOnce();
    expect(stub.thread.shutdown).not.toHaveBeenCalled();
    expect(control.shutdown).not.toHaveBeenCalled();
  });
});

describe("managedTokenUsage shape bridging", () => {
  it("reads the daemon session accumulator's promptTokens/completionTokens shape", () => {
    // The cross-turn accumulator (stream-model.ts TokenUsageInfo port) uses
    // promptTokens/completionTokens. Reading only inputTokens/outputTokens
    // shipped {0, 0, N} in every session.snapshot — input/output zeroed while
    // totalTokens matched — so cost-per-fix was unreportable.
    expect(
      managedTokenUsage({
        totalTokenUsage: () => ({
          promptTokens: 64,
          completionTokens: 1,
          totalTokens: 65,
        }),
      }),
    ).toEqual({ inputTokens: 64, outputTokens: 1, totalTokens: 65 });
  });

  it("still reads the live-agent inputTokens/outputTokens shape", () => {
    expect(
      managedTokenUsage({
        totalTokenUsage: () => ({
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        }),
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it("derives totalTokens when the shape omits it", () => {
    expect(
      managedTokenUsage({
        totalTokenUsage: () => ({ promptTokens: 7, completionTokens: 3 }),
      }),
    ).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  });
});
