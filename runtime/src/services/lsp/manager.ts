/**
 * Ports the donor singleton LSP manager lifecycle.
 *
 * The service initializes in the background, tracks state transitions, supports
 * forced reinitialization when config changes, and registers passive diagnostic
 * handlers after a successful manager initialization.
 */

import {
  createLSPServerManager,
  type LSPServerManager,
  type LSPServerManagerOptions,
} from "./LSPServerManager.js";
import { registerLSPNotificationHandlers } from "./passiveFeedback.js";
import { toError } from "../../utils/errors.js";
import type { SandboxExecutionBrokerLike } from "../../sandbox/execution-broker.js";
import { clearLSPDiagnosticScope } from "./LSPDiagnosticRegistry.js";
import { registerSandboxExecutionLifecycleParticipant } from "../../sandbox/execution-lifecycle.js";

type InitializationState = "not-started" | "pending" | "success" | "failed";

interface LspManagerState {
  manager: LSPServerManager | undefined;
  /** Manager whose process ownership has not yet been verified as stopped. */
  cleanupManager: LSPServerManager | undefined;
  initializationState: InitializationState;
  initializationError: Error | undefined;
  initializationGeneration: number;
  initializationPromise: Promise<void> | undefined;
  lastManagerOptions: LSPServerManagerOptions | undefined;
  lifecycleUnregister: (() => void) | undefined;
}

function createManagerState(): LspManagerState {
  return {
    manager: undefined,
    cleanupManager: undefined,
    initializationState: "not-started",
    initializationError: undefined,
    initializationGeneration: 0,
    initializationPromise: undefined,
    lastManagerOptions: undefined,
    lifecycleUnregister: undefined,
  };
}

let defaultManagerState = createManagerState();
let scopedManagerStates = new WeakMap<SandboxExecutionBrokerLike, LspManagerState>();
let activeManagerStates = new Set<LspManagerState>([defaultManagerState]);

function stateForScope(
  scope: SandboxExecutionBrokerLike | undefined,
  create: boolean,
): LspManagerState | undefined {
  if (scope === undefined) return defaultManagerState;
  const existing = scopedManagerStates.get(scope);
  if (existing !== undefined || !create) return existing;
  const state = createManagerState();
  scopedManagerStates.set(scope, state);
  activeManagerStates.add(state);
  return state;
}

function isEnvTruthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function lspDisabledByEnv(): boolean {
  return (
    isEnvTruthy(process.env.AGENC_SIMPLE) ||
    isEnvTruthy(process.env.AGENC_BARE) ||
    isEnvTruthy(process.env.AGENC_DISABLE_LSP)
  );
}

export function _resetLspManagerForTesting(): void {
  for (const state of activeManagerStates) {
    state.initializationGeneration += 1;
    state.lifecycleUnregister?.();
  }
  defaultManagerState = createManagerState();
  scopedManagerStates = new WeakMap();
  activeManagerStates = new Set([defaultManagerState]);
}

export function getLspServerManager(
  scope?: SandboxExecutionBrokerLike,
): LSPServerManager | undefined {
  const state = stateForScope(scope, false);
  if (state === undefined || state.initializationState === "failed") {
    return undefined;
  }
  return state.manager;
}

export function getInitializationStatus(
  scope?: SandboxExecutionBrokerLike,
):
  | { readonly status: "not-started" }
  | { readonly status: "pending" }
  | { readonly status: "success" }
  | { readonly status: "failed"; readonly error: Error } {
  const state = stateForScope(scope, false);
  if (state === undefined) return { status: "not-started" };
  if (state.initializationState === "failed") {
    return {
      status: "failed",
      error: state.initializationError ?? new Error("Initialization failed"),
    };
  }
  return { status: state.initializationState };
}

export function isLspConnected(scope?: SandboxExecutionBrokerLike): boolean {
  const state = stateForScope(scope, false);
  if (state === undefined || state.initializationState === "failed") return false;
  const manager = getLspServerManager(scope);
  if (!manager) return false;
  for (const server of manager.getAllServers().values()) {
    if (server.state === "running" || server.state === "starting") return true;
  }
  return false;
}

export async function waitForInitialization(
  scope?: SandboxExecutionBrokerLike,
): Promise<void> {
  const state = stateForScope(scope, false);
  if (state === undefined) return;
  if (
    state.initializationState === "success" ||
    state.initializationState === "failed"
  ) {
    return;
  }
  if (state.initializationState === "pending" && state.initializationPromise) {
    await state.initializationPromise;
  }
}

export function initializeForkedLspServerManager(
  parentScope: SandboxExecutionBrokerLike | undefined,
  childScope: SandboxExecutionBrokerLike,
  workspaceRoot: string,
): void {
  const parentState = stateForScope(parentScope, false);
  const options = parentState?.lastManagerOptions;
  if (options === undefined) return;
  initializeLspServerManager({
    ...options,
    workspaceRoot,
    sandboxExecutionBroker: childScope,
  });
}

export function initializeLspServerManager(
  options: LSPServerManagerOptions = {},
): void {
  if (lspDisabledByEnv()) return;
  const state = stateForScope(options.sandboxExecutionBroker, true)!;
  ensureLspLifecycleRegistration(state, options.sandboxExecutionBroker);
  if (state.manager !== undefined && state.initializationState !== "failed") {
    return;
  }

  if (state.initializationState === "failed") {
    // A failed shutdown is a poisoned ownership boundary, not permission to
    // construct a replacement. Only reinitialize/shutdown may retry it.
    if (state.cleanupManager !== undefined) return;
    state.manager = undefined;
    state.initializationError = undefined;
  }

  state.lastManagerOptions = options;
  state.manager = createLSPServerManager(options);
  state.initializationState = "pending";
  const generation = ++state.initializationGeneration;

  state.initializationPromise = state.manager
    .initialize()
    .then(() => {
      if (generation !== state.initializationGeneration) return;
      state.initializationState = "success";
      if (state.manager) {
        registerLSPNotificationHandlers(
          state.manager,
          options.sandboxExecutionBroker,
        );
      }
    })
    .catch((error: unknown) => {
      if (generation !== state.initializationGeneration) return;
      state.initializationState = "failed";
      state.initializationError = toError(error);
      state.manager = undefined;
    });
}

export function reinitializeLspServerManager(
  options: LSPServerManagerOptions = {},
): void {
  const state = stateForScope(options.sandboxExecutionBroker, true)!;
  if (state.initializationState === "not-started") return;
  const effectiveOptions = Object.keys(options).length > 0
    ? options
    : (state.lastManagerOptions ?? {});
  const oldManager = state.cleanupManager ?? state.manager;
  state.manager = undefined;
  state.cleanupManager = oldManager;
  state.initializationState = "pending";
  state.initializationError = undefined;
  state.lastManagerOptions = effectiveOptions;
  const generation = ++state.initializationGeneration;

  state.initializationPromise = (async () => {
    if (oldManager) {
      await oldManager.shutdown();
      if (state.cleanupManager === oldManager) {
        state.cleanupManager = undefined;
      }
    }
    if (generation !== state.initializationGeneration) return;
    state.manager = createLSPServerManager(effectiveOptions);
    await state.manager.initialize();
    if (generation !== state.initializationGeneration) return;
    state.initializationState = "success";
    if (state.manager) {
      registerLSPNotificationHandlers(
        state.manager,
        effectiveOptions.sandboxExecutionBroker,
      );
    }
  })().catch((error: unknown) => {
    if (generation !== state.initializationGeneration) return;
    state.initializationState = "failed";
    state.initializationError = toError(error);
    if (state.cleanupManager === undefined && state.manager !== undefined) {
      state.cleanupManager = state.manager;
    }
    state.manager = undefined;
  });
}

export async function shutdownLspServerManager(
  scope?: SandboxExecutionBrokerLike,
): Promise<void> {
  const state = stateForScope(scope, false);
  if (state === undefined) return;
  const manager = state.cleanupManager ?? state.manager;
  const pending = state.initializationPromise;
  const generation = ++state.initializationGeneration;
  state.manager = undefined;
  state.cleanupManager = manager;
  state.initializationState = "pending";
  state.initializationError = undefined;
  state.initializationPromise = undefined;
  try {
    await pending?.catch(() => {});
    await manager?.shutdown();
    if (state.cleanupManager === manager) state.cleanupManager = undefined;
    if (generation === state.initializationGeneration) {
      state.initializationState = "not-started";
      state.lastManagerOptions = undefined;
    }
    if (scope !== undefined) {
      clearLSPDiagnosticScope(scope);
      state.lifecycleUnregister?.();
      state.lifecycleUnregister = undefined;
      scopedManagerStates.delete(scope);
      activeManagerStates.delete(state);
    }
  } catch (error) {
    if (generation === state.initializationGeneration) {
      state.initializationState = "failed";
      state.initializationError = toError(error);
      state.cleanupManager = manager;
    }
    throw error;
  }
}

function ensureLspLifecycleRegistration(
  state: LspManagerState,
  scope: SandboxExecutionBrokerLike | undefined,
): void {
  if (scope === undefined || state.lifecycleUnregister !== undefined) return;
  let resumeOptions: LSPServerManagerOptions | undefined;
  state.lifecycleUnregister = registerSandboxExecutionLifecycleParticipant(
    scope,
    {
      name: "lsp",
      quiesce: async () => {
        resumeOptions = state.lastManagerOptions;
        await quiesceLspManagerState(state, scope);
      },
      resume: async (cwd) => {
        if (resumeOptions === undefined) return;
        initializeLspServerManager({
          ...resumeOptions,
          workspaceRoot: cwd,
          sandboxExecutionBroker: scope,
        });
        await waitForInitialization(scope);
        const status = getInitializationStatus(scope);
        if (status.status === "failed") throw status.error;
      },
    },
  );
}

async function quiesceLspManagerState(
  state: LspManagerState,
  scope: SandboxExecutionBrokerLike,
): Promise<void> {
  const manager = state.manager;
  const pending = state.initializationPromise;
  state.initializationGeneration += 1;
  state.manager = undefined;
  state.cleanupManager ??= manager;
  state.initializationState = "pending";
  state.initializationError = undefined;
  state.initializationPromise = undefined;
  try {
    await pending?.catch(() => {});
    await state.cleanupManager?.shutdown();
    state.cleanupManager = undefined;
    state.initializationState = "not-started";
    clearLSPDiagnosticScope(scope);
  } catch (error) {
    state.initializationState = "failed";
    state.initializationError = toError(error);
    throw error;
  }
}
