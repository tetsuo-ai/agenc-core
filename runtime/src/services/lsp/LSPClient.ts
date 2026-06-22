/**
 * Ports the donor LSP JSON-RPC client onto AgenC process primitives.
 *
 * Shape differences from the donor:
 *   - Uses AgenC-local minimal protocol types instead of adding the
 *     `vscode-languageserver-protocol` type package.
 *   - Keeps diagnostics local to the service; callers receive structured
 *     errors and may decide how to surface them.
 */

import { spawn, type ChildProcess } from "node:child_process";

import {
  createMessageConnection,
  type HandlerResult,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  Trace,
} from "vscode-jsonrpc/node";

import type {
  InitializeParams,
  InitializeResult,
  ServerCapabilities,
} from "./protocol.js";
import { errorMessage } from "../../utils/errors.js";
import { subprocessEnv } from "../../utils/subprocessEnv.js";

export interface LSPClient {
  readonly capabilities: ServerCapabilities | undefined;
  readonly isInitialized: boolean;
  start(
    command: string,
    args: readonly string[],
    options?: {
      readonly env?: Readonly<Record<string, string>>;
      readonly cwd?: string;
    },
  ): Promise<void>;
  initialize(params: InitializeParams): Promise<InitializeResult>;
  sendRequest<TResult>(method: string, params: unknown): Promise<TResult>;
  sendNotification(method: string, params: unknown): Promise<void>;
  onNotification(method: string, handler: (params: unknown) => void): void;
  onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): void;
  stop(): Promise<void>;
}

export interface LSPClientOptions {
  readonly onCrash?: (error: Error) => void;
  readonly onDiagnostic?: (message: string) => void;
  readonly baseEnv?: NodeJS.ProcessEnv;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000;
const CONNECTION_CLOSE_EXIT_GRACE_MS = 20;

function mergedEnv(
  baseEnv: NodeJS.ProcessEnv | undefined,
  extra?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  return {
    ...subprocessEnv(baseEnv),
    ...(extra ?? {}),
  };
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

export function createLSPClient(
  serverName: string,
  options: LSPClientOptions = {},
): LSPClient {
  let child: ChildProcess | undefined;
  let connection: MessageConnection | undefined;
  let capabilities: ServerCapabilities | undefined;
  let initialized = false;
  let startFailed = false;
  let startError: Error | undefined;
  let stopping = false;
  let terminalNotified = false;
  let connectionClosePending = false;
  const notificationHandlers: Array<{
    readonly method: string;
    readonly handler: (params: unknown) => void;
  }> = [];
  const requestHandlers: Array<{
    readonly method: string;
    readonly handler: (params: unknown) => HandlerResult<unknown, unknown>;
  }> = [];

  const diagnostic = (message: string): void => {
    options.onDiagnostic?.(`[lsp:${serverName}] ${message}`);
  };

  const disposeConnection = (): void => {
    if (!connection) return;
    const current = connection;
    connection = undefined;
    try {
      current.dispose();
    } catch (error) {
      diagnostic(`connection dispose failed: ${errorMessage(error)}`);
    }
  };

  const clearConnectionState = (): void => {
    disposeConnection();
    initialized = false;
    capabilities = undefined;
  };

  const removeChildListeners = (currentChild: ChildProcess): void => {
    currentChild.removeAllListeners("error");
    currentChild.removeAllListeners("exit");
    currentChild.stdin?.removeAllListeners("error");
    currentChild.stdout?.removeAllListeners("end");
    currentChild.stdout?.removeAllListeners("close");
    currentChild.stderr?.removeAllListeners("data");
  };

  const clearClosedRuntimeState = (opts: { readonly killChild?: boolean } = {}): void => {
    clearConnectionState();
    if (child) {
      const currentChild = child;
      removeChildListeners(currentChild);
      if (opts.killChild === true && !currentChild.killed) {
        currentChild.kill();
      }
      child = undefined;
    }
  };

  const notifyUnexpectedTerminal = (error: Error): void => {
    if (stopping || terminalNotified) return;
    terminalNotified = true;
    startFailed = false;
    startError = undefined;
    options.onCrash?.(error);
    diagnostic(error.message);
  };

  const scheduleUnexpectedConnectionClose = (): void => {
    if (stopping || terminalNotified || connectionClosePending) return;
    connectionClosePending = true;
    const closedChild = child;
    clearConnectionState();
    setTimeout(() => {
      connectionClosePending = false;
      if (stopping || terminalNotified) return;
      if (closedChild && child === closedChild) {
        removeChildListeners(closedChild);
        if (!closedChild.killed) closedChild.kill();
        child = undefined;
      }
      if (closedChild?.exitCode !== null && closedChild?.exitCode !== undefined) {
        notifyUnexpectedTerminal(
          closedChild.exitCode === 0
            ? new Error(`LSP server ${serverName} exited unexpectedly with code 0`)
            : new Error(
                `LSP server ${serverName} crashed with exit code ${closedChild.exitCode}`,
              ),
        );
        return;
      }
      if (closedChild?.signalCode) {
        notifyUnexpectedTerminal(
          new Error(`LSP server ${serverName} exited with signal ${closedChild.signalCode}`),
        );
        return;
      }
      notifyUnexpectedTerminal(
        new Error(`LSP server ${serverName} connection closed unexpectedly`),
      );
    }, CONNECTION_CLOSE_EXIT_GRACE_MS);
  };

  const assertStarted = (): void => {
    if (startFailed) {
      throw startError ?? new Error(`LSP server ${serverName} failed to start`);
    }
    if (!connection) {
      throw new Error("LSP client not started");
    }
  };

  const applyQueuedHandlers = (): void => {
    if (!connection) return;
    for (const { method, handler } of notificationHandlers) {
      connection.onNotification(method, handler);
    }
    for (const { method, handler } of requestHandlers) {
      connection.onRequest<unknown, unknown>(method, handler);
    }
  };

  function requestHandler<TParams, TResult>(
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): (params: unknown) => HandlerResult<TResult, unknown> {
    return (params: unknown) =>
      handler(params as TParams) as HandlerResult<TResult, unknown>;
  }

  return {
    get capabilities(): ServerCapabilities | undefined {
      return capabilities;
    },

    get isInitialized(): boolean {
      return initialized;
    },

    async start(command, args, runOptions): Promise<void> {
      if (connection) return;
      stopping = false;
      terminalNotified = false;
      connectionClosePending = false;
      startFailed = false;
      startError = undefined;

      try {
        child = spawn(command, [...args], {
          stdio: ["pipe", "pipe", "pipe"],
          env: mergedEnv(options.baseEnv, runOptions?.env),
          cwd: runOptions?.cwd,
          windowsHide: true,
        });

        if (!child.stdin || !child.stdout) {
          throw new Error("LSP server process stdio not available");
        }

        const spawnedChild = child;
        await new Promise<void>((resolve, reject) => {
          const cleanup = (): void => {
            spawnedChild.removeListener("spawn", onSpawn);
            spawnedChild.removeListener("error", onError);
          };
          const onSpawn = (): void => {
            cleanup();
            resolve();
          };
          const onError = (error: Error): void => {
            cleanup();
            reject(error);
          };
          spawnedChild.once("spawn", onSpawn);
          spawnedChild.once("error", onError);
        });

        child.stderr?.on("data", (data: Buffer) => {
          const output = data.toString().trim();
          if (output.length > 0) diagnostic(output);
        });

        child.on("error", (error) => {
          if (stopping) return;
          startFailed = true;
          startError = error;
          diagnostic(`process error: ${error.message}`);
        });

        child.on("exit", (code, signal) => {
          if (stopping) return;
          clearClosedRuntimeState();
          if (code !== 0 && code !== null) {
            notifyUnexpectedTerminal(
              new Error(`LSP server ${serverName} crashed with exit code ${code}`),
            );
            return;
          }
          if (signal) {
            notifyUnexpectedTerminal(
              new Error(`LSP server ${serverName} exited with signal ${signal}`),
            );
            return;
          }
          notifyUnexpectedTerminal(
            new Error(`LSP server ${serverName} exited unexpectedly with code 0`),
          );
        });

        child.stdin.on("error", (error: Error) => {
          if (!stopping) diagnostic(`stdin error: ${error.message}`);
        });
        child.stdout.once("end", scheduleUnexpectedConnectionClose);
        child.stdout.once("close", scheduleUnexpectedConnectionClose);

        const reader = new StreamMessageReader(child.stdout);
        const writer = new StreamMessageWriter(child.stdin);
        connection = createMessageConnection(reader, writer);

        connection.onError(([error]) => {
          if (stopping) return;
          startFailed = true;
          startError = error;
          diagnostic(`connection error: ${error.message}`);
        });

        connection.onClose(() => {
          scheduleUnexpectedConnectionClose();
        });

        connection.listen();
        void connection
          .trace(Trace.Verbose, {
            log: (message: string) => diagnostic(message),
          })
          .catch((error: Error) => {
            diagnostic(`trace setup failed: ${error.message}`);
          });
        applyQueuedHandlers();
      } catch (error) {
        startFailed = true;
        startError = error instanceof Error ? error : new Error(String(error));
        await this.stop().catch(() => {});
        throw startError;
      }
    },

    async initialize(params): Promise<InitializeResult> {
      assertStarted();
      try {
        const result = await connection!.sendRequest<InitializeResult>(
          "initialize",
          params,
        );
        capabilities = result.capabilities;
        await connection!.sendNotification("initialized", {});
        initialized = true;
        return result;
      } catch (error) {
        const wrapped = new Error(
          `LSP server ${serverName} initialize failed: ${errorMessage(error)}`,
        );
        startFailed = true;
        startError = wrapped;
        throw wrapped;
      }
    },

    async sendRequest<TResult>(
      method: string,
      params: unknown,
    ): Promise<TResult> {
      assertStarted();
      if (!initialized) throw new Error("LSP server not initialized");
      return connection!.sendRequest<TResult>(method, params);
    },

    async sendNotification(method: string, params: unknown): Promise<void> {
      assertStarted();
      await connection!.sendNotification(method, params).catch((error) => {
        diagnostic(`notification ${method} failed: ${errorMessage(error)}`);
      });
    },

    onNotification(method, handler): void {
      notificationHandlers.push({ method, handler });
      if (!connection) {
        return;
      }
      assertStarted();
      connection.onNotification(method, handler);
    },

    onRequest<TParams, TResult>(
      method: string,
      handler: (params: TParams) => TResult | Promise<TResult>,
    ): void {
      const wrapped = requestHandler(handler);
      requestHandlers.push({
        method,
        handler: wrapped as (params: unknown) => HandlerResult<unknown, unknown>,
      });
      if (!connection) {
        return;
      }
      assertStarted();
      connection.onRequest<TResult, unknown>(method, wrapped);
    },

    async stop(): Promise<void> {
      stopping = true;
      let shutdownError: Error | undefined;
      try {
        if (connection) {
          await withTimeout(
            connection.sendRequest("shutdown", {}),
            DEFAULT_SHUTDOWN_TIMEOUT_MS,
            `LSP server ${serverName} shutdown timed out`,
          );
          await connection.sendNotification("exit", {});
        }
      } catch (error) {
        shutdownError = error instanceof Error ? error : new Error(String(error));
      } finally {
        disposeConnection();
        if (child) {
          removeChildListeners(child);
          if (!child.killed) child.kill();
          child = undefined;
        }
        initialized = false;
        capabilities = undefined;
        stopping = false;
      }
      if (shutdownError) throw shutdownError;
    },
  };
}
