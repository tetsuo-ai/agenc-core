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
  const instanceFactory =
    options.instanceFactory ??
    ((name: string, config: ScopedLspServerConfig) =>
      createLSPServerInstance(name, config, { cwd: options.workspaceRoot }));

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
      ([, server]) =>
        server.state === "running" ||
        server.state === "starting" ||
        server.state === "error",
    );
    const results = await Promise.allSettled(
      toStop.map(([, server]) => server.stop()),
    );
    servers.clear();
    extensionMap.clear();
    openedFiles.clear();

    const errors = results
      .map((result, index) =>
        result.status === "rejected"
          ? `${toStop[index]![0]}: ${errorMessage(result.reason)}`
          : null,
      )
      .filter((value): value is string => value !== null);
    if (errors.length > 0) {
      throw new Error(
        `Failed to stop ${errors.length} LSP server(s): ${errors.join("; ")}`,
      );
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
