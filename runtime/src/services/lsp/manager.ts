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
import { errorMessage, toError } from "../../utils/errors.js";
import type { SandboxExecutionBrokerLike } from "../../sandbox/execution-broker.js";

type InitializationState = "not-started" | "pending" | "success" | "failed";

interface LspManagerState {
  manager: LSPServerManager | undefined;
  initializationState: InitializationState;
  initializationError: Error | undefined;
  initializationGeneration: number;
  initializationPromise: Promise<void> | undefined;
  lastManagerOptions: LSPServerManagerOptions | undefined;
}

function createManagerState(): LspManagerState {
  return {
    manager: undefined,
    initializationState: "not-started",
    initializationError: undefined,
    initializationGeneration: 0,
    initializationPromise: undefined,
    lastManagerOptions: undefined,
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

export function initializeLspServerManager(
  options: LSPServerManagerOptions = {},
): void {
  if (lspDisabledByEnv()) return;
  const state = stateForScope(options.sandboxExecutionBroker, true)!;
  if (state.manager !== undefined && state.initializationState !== "failed") {
    return;
  }

  if (state.initializationState === "failed") {
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
        registerLSPNotificationHandlers(state.manager);
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
  const oldManager = state.manager;
  state.manager = undefined;
  state.initializationState = "pending";
  state.initializationError = undefined;
  state.lastManagerOptions = effectiveOptions;
  const generation = ++state.initializationGeneration;

  state.initializationPromise = (async () => {
    if (oldManager) {
      try {
        await oldManager.shutdown();
      } catch (error) {
        // Old server cleanup is best-effort during config reload; a stale
        // shutdown failure must not prevent the replacement config loading.
        // eslint-disable-next-line no-console
        console.warn(
          "[lsp] previous manager shutdown failed during reinitialize:",
          errorMessage(error),
        );
      }
    }
    if (generation !== state.initializationGeneration) return;
    state.manager = createLSPServerManager(effectiveOptions);
    await state.manager.initialize();
    if (generation !== state.initializationGeneration) return;
    state.initializationState = "success";
    if (state.manager) {
      registerLSPNotificationHandlers(state.manager);
    }
  })().catch((error: unknown) => {
    if (generation !== state.initializationGeneration) return;
    state.initializationState = "failed";
    state.initializationError = toError(error);
    state.manager = undefined;
  });
}

export async function shutdownLspServerManager(
  scope?: SandboxExecutionBrokerLike,
): Promise<void> {
  const state = stateForScope(scope, false);
  if (state === undefined) return;
  const manager = state.manager;
  const pending = state.initializationPromise;
  const generation = ++state.initializationGeneration;
  state.manager = undefined;
  state.initializationState = "not-started";
  state.initializationError = undefined;
  state.initializationPromise = undefined;
  state.lastManagerOptions = undefined;
  try {
    await pending?.catch(() => {});
    await manager?.shutdown();
  } finally {
    if (generation === state.initializationGeneration) {
      state.initializationState = "not-started";
    }
    if (scope !== undefined) {
      scopedManagerStates.delete(scope);
      activeManagerStates.delete(state);
    }
  }
}
