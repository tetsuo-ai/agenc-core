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

type InitializationState = "not-started" | "pending" | "success" | "failed";

let lspManagerInstance: LSPServerManager | undefined;
let initializationState: InitializationState = "not-started";
let initializationError: Error | undefined;
let initializationGeneration = 0;
let initializationPromise: Promise<void> | undefined;
let lastManagerOptions: LSPServerManagerOptions | undefined;

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
  lspManagerInstance = undefined;
  initializationState = "not-started";
  initializationError = undefined;
  initializationPromise = undefined;
  lastManagerOptions = undefined;
  initializationGeneration += 1;
}

export function getLspServerManager(): LSPServerManager | undefined {
  if (initializationState === "failed") return undefined;
  return lspManagerInstance;
}

export function getInitializationStatus():
  | { readonly status: "not-started" }
  | { readonly status: "pending" }
  | { readonly status: "success" }
  | { readonly status: "failed"; readonly error: Error } {
  if (initializationState === "failed") {
    return {
      status: "failed",
      error: initializationError ?? new Error("Initialization failed"),
    };
  }
  return { status: initializationState };
}

export function isLspConnected(): boolean {
  if (initializationState === "failed") return false;
  const manager = getLspServerManager();
  if (!manager) return false;
  for (const server of manager.getAllServers().values()) {
    if (server.state === "running" || server.state === "starting") return true;
  }
  return false;
}

export async function waitForInitialization(): Promise<void> {
  if (initializationState === "success" || initializationState === "failed") {
    return;
  }
  if (initializationState === "pending" && initializationPromise) {
    await initializationPromise;
  }
}

export function initializeLspServerManager(
  options: LSPServerManagerOptions = {},
): void {
  if (lspDisabledByEnv()) return;
  if (lspManagerInstance !== undefined && initializationState !== "failed") {
    return;
  }

  if (initializationState === "failed") {
    lspManagerInstance = undefined;
    initializationError = undefined;
  }

  lastManagerOptions = options;
  lspManagerInstance = createLSPServerManager(options);
  initializationState = "pending";
  const generation = ++initializationGeneration;

  initializationPromise = lspManagerInstance
    .initialize()
    .then(() => {
      if (generation !== initializationGeneration) return;
      initializationState = "success";
      if (lspManagerInstance) {
        registerLSPNotificationHandlers(lspManagerInstance);
      }
    })
    .catch((error: unknown) => {
      if (generation !== initializationGeneration) return;
      initializationState = "failed";
      initializationError = toError(error);
      lspManagerInstance = undefined;
    });
}

export function reinitializeLspServerManager(
  options: LSPServerManagerOptions = lastManagerOptions ?? {},
): void {
  if (initializationState === "not-started") return;
  const oldManager = lspManagerInstance;
  lspManagerInstance = undefined;
  initializationState = "pending";
  initializationError = undefined;
  lastManagerOptions = options;
  const generation = ++initializationGeneration;

  initializationPromise = (async () => {
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
    if (generation !== initializationGeneration) return;
    lspManagerInstance = createLSPServerManager(options);
    await lspManagerInstance.initialize();
    if (generation !== initializationGeneration) return;
    initializationState = "success";
    if (lspManagerInstance) {
      registerLSPNotificationHandlers(lspManagerInstance);
    }
  })().catch((error: unknown) => {
    if (generation !== initializationGeneration) return;
    initializationState = "failed";
    initializationError = toError(error);
    lspManagerInstance = undefined;
  });
}

export async function shutdownLspServerManager(): Promise<void> {
  const manager = lspManagerInstance;
  const pending = initializationPromise;
  const generation = ++initializationGeneration;
  lspManagerInstance = undefined;
  initializationState = "not-started";
  initializationError = undefined;
  initializationPromise = undefined;
  lastManagerOptions = undefined;
  try {
    await pending?.catch(() => {});
    await manager?.shutdown();
  } finally {
    if (generation === initializationGeneration) {
      initializationState = "not-started";
    }
  }
}
