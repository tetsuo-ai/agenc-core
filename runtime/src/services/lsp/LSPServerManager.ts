/**
 * Ports the donor multi-server LSP manager.
 *
 * The manager loads resolved server configs, maps file extensions to server
 * instances, lazily starts matching servers, and forwards file lifecycle
 * notifications.
 */

import { extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { getAllLspServers } from "./config.js";
import {
  createLSPServerInstance,
  type LSPServerInstance,
} from "./LSPServerInstance.js";
import type { LspServerConfigSource, ScopedLspServerConfig } from "./types.js";
import type { SandboxExecutionBrokerLike } from "../../sandbox/execution-broker.js";
import { errorMessage } from "../../utils/errors.js";

export interface LSPServerManager {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  getServerForFile(filePath: string): LSPServerInstance | undefined;
  ensureServerStarted(filePath: string): Promise<LSPServerInstance | undefined>;
  sendRequest<T>(
    filePath: string,
    method: string,
    params: unknown,
  ): Promise<T | undefined>;
  getAllServers(): Map<string, LSPServerInstance>;
  openFile(filePath: string, content: string): Promise<void>;
  changeFile(filePath: string, content: string): Promise<void>;
  saveFile(filePath: string): Promise<void>;
  closeFile(filePath: string): Promise<void>;
  isFileOpen(filePath: string): boolean;
}

export interface LSPServerManagerOptions {
  readonly configSource?: LspServerConfigSource;
  readonly workspaceRoot?: string;
  readonly sandboxExecutionBroker?: SandboxExecutionBrokerLike;
  readonly instanceFactory?: (
    name: string,
    config: ScopedLspServerConfig,
  ) => LSPServerInstance;
}

export function createLSPServerManager(
  options: LSPServerManagerOptions = {},
): LSPServerManager {
  const servers = new Map<string, LSPServerInstance>();
  const extensionMap = new Map<string, string[]>();
  const openedFiles = new Map<string, { serverName: string; version: number }>();
  // A rejected stop is an unverified process owner, even if the instance
  // happened to transition its public state to `stopped` before rejecting.
  // Keep that owner retryable until a later shutdown proves cleanup.
  const shutdownFailures = new Set<string>();
  const instanceFactory =
    options.instanceFactory ??
    ((name: string, config: ScopedLspServerConfig) =>
      createLSPServerInstance(name, config, {
        ...(options.workspaceRoot !== undefined
          ? { cwd: options.workspaceRoot }
          : {}),
        ...(options.sandboxExecutionBroker !== undefined
          ? { sandboxExecutionBroker: options.sandboxExecutionBroker }
          : {}),
      }));

  function resolveFilePath(filePath: string): string {
    if (isAbsolute(filePath)) return resolve(filePath);
    return resolve(options.workspaceRoot ?? process.cwd(), filePath);
  }

  function fileUri(filePath: string): string {
    return pathToFileURL(resolveFilePath(filePath)).href;
  }

  async function initialize(): Promise<void> {
    const { servers: configs } = await getAllLspServers(options.configSource);

    for (const [serverName, config] of Object.entries(configs)) {
      try {
        if (!config.command) {
          throw new Error(`Server ${serverName} missing required command`);
        }
        if (Object.keys(config.extensionToLanguage).length === 0) {
          throw new Error(
            `Server ${serverName} missing required extensionToLanguage`,
          );
        }

        const instance = instanceFactory(serverName, config);
        instance.onRequest(
          "workspace/configuration",
          (params: { readonly items?: readonly unknown[] }) =>
            (params.items ?? []).map(() => null),
        );
        servers.set(serverName, instance);

        for (const ext of Object.keys(config.extensionToLanguage)) {
          const normalized = ext.toLowerCase();
          const list = extensionMap.get(normalized) ?? [];
          list.push(serverName);
          extensionMap.set(normalized, list);
        }
      } catch {
        servers.delete(serverName);
      }
    }
  }

  async function shutdown(): Promise<void> {
    const toStop = Array.from(servers.entries()).filter(
      ([name, server]) =>
        shutdownFailures.has(name) ||
        server.state === "running" ||
        server.state === "starting" ||
        server.state === "error",
    );
    const results = await Promise.allSettled(
      toStop.map(([, server]) => server.stop()),
    );
    const attempted = new Set(toStop.map(([name]) => name));
    const errors: unknown[] = [];
    const errorMessages: string[] = [];
    results.forEach((result, index) => {
      const name = toStop[index]![0];
      if (result.status === "fulfilled") {
        shutdownFailures.delete(name);
        servers.delete(name);
        return;
      }
      shutdownFailures.add(name);
      errors.push(result.reason);
      errorMessages.push(`${name}: ${errorMessage(result.reason)}`);
    });

    // Instances that never started have no process ownership to retain.
    for (const name of [...servers.keys()]) {
      if (!attempted.has(name) && !shutdownFailures.has(name)) {
        servers.delete(name);
      }
    }
    rebuildRetainedRouting();

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Failed to stop ${errors.length} LSP server(s): ${errorMessages.join("; ")}`,
      );
    }
  }

  function rebuildRetainedRouting(): void {
    extensionMap.clear();
    for (const [serverName, server] of servers) {
      for (const ext of Object.keys(server.config.extensionToLanguage)) {
        const normalized = ext.toLowerCase();
        const names = extensionMap.get(normalized) ?? [];
        names.push(serverName);
        extensionMap.set(normalized, names);
      }
    }
    for (const [uri, opened] of openedFiles) {
      if (!servers.has(opened.serverName)) openedFiles.delete(uri);
    }
  }

  function getServerForFile(filePath: string): LSPServerInstance | undefined {
    const names = extensionMap.get(extname(filePath).toLowerCase());
    const name = names?.[0];
    return name ? servers.get(name) : undefined;
  }

  async function ensureServerStarted(
    filePath: string,
  ): Promise<LSPServerInstance | undefined> {
    const server = getServerForFile(filePath);
    if (!server) return undefined;
    if (
      server.state === "stopped" ||
      server.state === "starting" ||
      server.state === "error"
    ) {
      await server.start();
    }
    return server;
  }

  async function sendRequest<T>(
    filePath: string,
    method: string,
    params: unknown,
  ): Promise<T | undefined> {
    const server = await ensureServerStarted(filePath);
    return server ? server.sendRequest<T>(method, params) : undefined;
  }

  async function openFile(filePath: string, content: string): Promise<void> {
    const server = await ensureServerStarted(filePath);
    if (!server) return;
    const uri = fileUri(filePath);
    if (openedFiles.get(uri)?.serverName === server.name) return;
    const ext = extname(filePath).toLowerCase();
    const languageId = server.config.extensionToLanguage[ext] ?? "plaintext";
    await server.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content,
      },
    });
    openedFiles.set(uri, { serverName: server.name, version: 1 });
  }

  async function changeFile(filePath: string, content: string): Promise<void> {
    const server = getServerForFile(filePath);
    if (!server || server.state !== "running") {
      await openFile(filePath, content);
      return;
    }
    const uri = fileUri(filePath);
    const opened = openedFiles.get(uri);
    if (opened?.serverName !== server.name) {
      await openFile(filePath, content);
      return;
    }
    const version = opened.version + 1;
    await server.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text: content }],
    });
    openedFiles.set(uri, { serverName: server.name, version });
  }

  async function saveFile(filePath: string): Promise<void> {
    const server = getServerForFile(filePath);
    if (!server || server.state !== "running") return;
    await server.sendNotification("textDocument/didSave", {
      textDocument: { uri: fileUri(filePath) },
    });
  }

  async function closeFile(filePath: string): Promise<void> {
    const uri = fileUri(filePath);
    // Clear the local bookkeeping unconditionally — otherwise closing a file
    // while the server is crashed/stopped/starting leaks the openedFiles entry,
    // leaving isFileOpen() true and making a later openFile() skip didOpen for a
    // document the server never received.
    openedFiles.delete(uri);
    const server = getServerForFile(filePath);
    if (!server || server.state !== "running") return;
    await server.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  return {
    initialize,
    shutdown,
    getServerForFile,
    ensureServerStarted,
    sendRequest,
    getAllServers: () => servers,
    openFile,
    changeFile,
    saveFile,
    closeFile,
    isFileOpen: (filePath) => openedFiles.has(fileUri(filePath)),
  };
}
