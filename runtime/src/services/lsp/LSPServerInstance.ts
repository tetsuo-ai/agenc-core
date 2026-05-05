/**
 * Ports the donor per-server LSP lifecycle state machine.
 *
 * AgenC keeps the same stopped/starting/running/stopping/error transitions,
 * bounded startup, transient request retry, and crash-recovery cap while using
 * local protocol/config types.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import { createLSPClient, type LSPClient } from "./LSPClient.js";
import type { InitializeParams } from "./protocol.js";
import type { LspServerState, ScopedLspServerConfig } from "./types.js";

const LSP_ERROR_CONTENT_MODIFIED = -32801;
const MAX_RETRIES_FOR_TRANSIENT_ERRORS = 3;
const RETRY_BASE_DELAY_MS = 500;

export interface LSPServerInstance {
  readonly name: string;
  readonly config: ScopedLspServerConfig;
  readonly state: LspServerState;
  readonly startTime: Date | undefined;
  readonly lastError: Error | undefined;
  readonly restartCount: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  isHealthy(): boolean;
  sendRequest<T>(method: string, params: unknown): Promise<T>;
  sendNotification(method: string, params: unknown): Promise<void>;
  onNotification(method: string, handler: (params: unknown) => void): void;
  onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): void;
}

export interface LSPServerInstanceOptions {
  readonly client?: LSPClient;
  readonly createClient?: (
    name: string,
    onCrash: (error: Error) => void,
  ) => LSPClient;
  readonly cwd?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function isContentModifiedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === LSP_ERROR_CONTENT_MODIFIED
  );
}

export function createLSPServerInstance(
  name: string,
  config: ScopedLspServerConfig,
  options: LSPServerInstanceOptions = {},
): LSPServerInstance {
  if (config.restartOnCrash !== undefined) {
    throw new Error(
      `LSP server '${name}': restartOnCrash is not yet implemented. Remove this field from the configuration.`,
    );
  }
  if (config.shutdownTimeout !== undefined) {
    throw new Error(
      `LSP server '${name}': shutdownTimeout is not yet implemented. Remove this field from the configuration.`,
    );
  }

  let state: LspServerState = "stopped";
  let startTime: Date | undefined;
  let lastError: Error | undefined;
  let restartCount = 0;
  let crashRecoveryCount = 0;
  const makeClient =
    options.createClient ??
    ((serverName: string, onCrash: (error: Error) => void) =>
      createLSPClient(serverName, { onCrash }));
  const client =
    options.client ??
    makeClient(name, (error) => {
      state = "error";
      lastError = error;
      crashRecoveryCount += 1;
    });

  async function start(): Promise<void> {
    if (state === "running" || state === "starting") return;

    const maxRestarts = config.maxRestarts ?? 3;
    if (state === "error" && crashRecoveryCount > maxRestarts) {
      const error = new Error(
        `LSP server '${name}' exceeded max crash recovery attempts (${maxRestarts})`,
      );
      lastError = error;
      throw error;
    }

    let initPromise: Promise<unknown> | undefined;
    try {
      state = "starting";
      await client.start(config.command, config.args ?? [], {
        env: config.env,
        cwd: config.workspaceFolder,
      });

      const workspaceFolder = config.workspaceFolder ?? options.cwd ?? process.cwd();
      const workspaceUri = pathToFileURL(workspaceFolder).href;
      const initParams: InitializeParams = {
        processId: process.pid,
        initializationOptions: config.initializationOptions ?? {},
        workspaceFolders: [
          {
            uri: workspaceUri,
            name: basename(workspaceFolder),
          },
        ],
        rootPath: workspaceFolder,
        rootUri: workspaceUri,
        capabilities: {
          workspace: {
            configuration: false,
            workspaceFolders: false,
          },
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: true,
            },
            publishDiagnostics: {
              relatedInformation: true,
              tagSupport: { valueSet: [1, 2] },
              versionSupport: false,
              codeDescriptionSupport: true,
              dataSupport: false,
            },
            hover: {
              dynamicRegistration: false,
              contentFormat: ["markdown", "plaintext"],
            },
            definition: {
              dynamicRegistration: false,
              linkSupport: true,
            },
            references: { dynamicRegistration: false },
            documentSymbol: {
              dynamicRegistration: false,
              hierarchicalDocumentSymbolSupport: true,
            },
            callHierarchy: { dynamicRegistration: false },
          },
          general: { positionEncodings: ["utf-16"] },
        },
      };

      initPromise = client.initialize(initParams);
      if (config.startupTimeout !== undefined) {
        await withTimeout(
          initPromise,
          config.startupTimeout,
          `LSP server '${name}' timed out after ${config.startupTimeout}ms during initialization`,
        );
      } else {
        await initPromise;
      }

      state = "running";
      startTime = new Date();
      crashRecoveryCount = 0;
      lastError = undefined;
    } catch (error) {
      void client.stop().catch(() => {});
      void initPromise?.catch(() => {});
      state = "error";
      lastError = error instanceof Error ? error : new Error(String(error));
      throw lastError;
    }
  }

  async function stop(): Promise<void> {
    if (state === "stopped" || state === "stopping") return;
    try {
      state = "stopping";
      await client.stop();
      state = "stopped";
      startTime = undefined;
    } catch (error) {
      state = "error";
      lastError = error instanceof Error ? error : new Error(String(error));
      throw lastError;
    }
  }

  async function restart(): Promise<void> {
    try {
      await stop();
    } catch (error) {
      throw new Error(
        `Failed to stop LSP server '${name}' during restart: ${errorMessage(error)}`,
      );
    }
    restartCount += 1;
    const maxRestarts = config.maxRestarts ?? 3;
    if (restartCount > maxRestarts) {
      throw new Error(
        `Max restart attempts (${maxRestarts}) exceeded for server '${name}'`,
      );
    }
    await start().catch((error) => {
      throw new Error(
        `Failed to start LSP server '${name}' during restart (attempt ${restartCount}/${maxRestarts}): ${errorMessage(error)}`,
      );
    });
  }

  function isHealthy(): boolean {
    return state === "running" && client.isInitialized;
  }

  async function sendRequest<T>(method: string, params: unknown): Promise<T> {
    if (!isHealthy()) {
      throw new Error(
        `Cannot send request to LSP server '${name}': server is ${state}` +
          `${lastError ? `, last error: ${lastError.message}` : ""}`,
      );
    }

    let lastAttemptError: unknown;
    for (
      let attempt = 0;
      attempt <= MAX_RETRIES_FOR_TRANSIENT_ERRORS;
      attempt += 1
    ) {
      try {
        return await client.sendRequest<T>(method, params);
      } catch (error) {
        lastAttemptError = error;
        if (
          isContentModifiedError(error) &&
          attempt < MAX_RETRIES_FOR_TRANSIENT_ERRORS
        ) {
          await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        break;
      }
    }
    throw new Error(
      `LSP request '${method}' failed for server '${name}': ${errorMessage(lastAttemptError)}`,
    );
  }

  async function sendNotification(method: string, params: unknown): Promise<void> {
    if (!isHealthy()) {
      throw new Error(
        `Cannot send notification to LSP server '${name}': server is ${state}`,
      );
    }
    await client.sendNotification(method, params).catch((error) => {
      throw new Error(
        `LSP notification '${method}' failed for server '${name}': ${errorMessage(error)}`,
      );
    });
  }

  return {
    name,
    config,
    get state() {
      return state;
    },
    get startTime() {
      return startTime;
    },
    get lastError() {
      return lastError;
    },
    get restartCount() {
      return restartCount;
    },
    start,
    stop,
    restart,
    isHealthy,
    sendRequest,
    sendNotification,
    onNotification: (method, handler) => client.onNotification(method, handler),
    onRequest: (method, handler) => client.onRequest(method, handler),
  };
}
