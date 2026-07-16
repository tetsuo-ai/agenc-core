import { pathToFileURL, fileURLToPath } from "node:url";

import { clearDeliveredDiagnosticsForFile } from "../../../services/lsp/LSPDiagnosticRegistry.js";
import { getLspServerManager } from "../../../services/lsp/manager.js";
import { peekAmbientRuntimeSession } from "../../../session/current-session.js";
import { logError } from "../../../utils/log.js";

export type BufferLspPosition = {
  readonly line: number;
  readonly character: number;
};

export type BufferDefinitionTarget = {
  readonly path: string;
  readonly line: number;
  readonly character: number;
};

function bestEffort(run: () => Promise<void>): void {
  void run().catch(logError);
}

function currentLspManager() {
  return getLspServerManager(
    peekAmbientRuntimeSession()?.services.sandboxExecutionBroker,
  );
}

function currentLspScope() {
  return peekAmbientRuntimeSession()?.services.sandboxExecutionBroker;
}

export function notifyBufferLspOpened(filePath: string, content: string): void {
  bestEffort(async () => {
    await currentLspManager()?.openFile(filePath, content);
  });
}

export function notifyBufferLspChanged(filePath: string, content: string): void {
  clearDeliveredDiagnosticsForFile(filePath, currentLspScope());
  bestEffort(async () => {
    await currentLspManager()?.changeFile(filePath, content);
  });
}

export function notifyBufferLspSaved(filePath: string): void {
  bestEffort(async () => {
    await currentLspManager()?.saveFile(filePath);
  });
}

export function notifyBufferLspClosed(filePath: string): void {
  bestEffort(async () => {
    await currentLspManager()?.closeFile(filePath);
  });
}

export async function requestBufferHover(
  filePath: string,
  position: BufferLspPosition,
): Promise<string | null> {
  const result = await currentLspManager()?.sendRequest<{
    readonly contents?: unknown;
  }>(filePath, "textDocument/hover", {
    textDocument: { uri: pathToFileURL(filePath).href },
    position,
  });
  return parseBufferHoverText(result?.contents);
}

export async function requestBufferDefinition(
  filePath: string,
  position: BufferLspPosition,
): Promise<BufferDefinitionTarget | null> {
  const result = await currentLspManager()?.sendRequest<unknown>(
    filePath,
    "textDocument/definition",
    {
      textDocument: { uri: pathToFileURL(filePath).href },
      position,
    },
  );
  return parseBufferDefinitionTarget(result);
}

export function parseBufferHoverText(contents: unknown): string | null {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents.map(parseBufferHoverText).filter(Boolean).join("\n") || null;
  }
  if (contents && typeof contents === "object") {
    const value = (contents as { readonly value?: unknown }).value;
    if (typeof value === "string") return value;
  }
  return null;
}

export function parseBufferDefinitionTarget(result: unknown): BufferDefinitionTarget | null {
  const value = Array.isArray(result) ? result[0] : result;
  if (!value || typeof value !== "object") return null;
  const record = value as {
    readonly uri?: unknown;
    readonly targetUri?: unknown;
    readonly range?: { readonly start?: { readonly line?: number; readonly character?: number } };
    readonly targetSelectionRange?: { readonly start?: { readonly line?: number; readonly character?: number } };
  };
  const uri = typeof record.targetUri === "string"
    ? record.targetUri
    : typeof record.uri === "string"
      ? record.uri
      : null;
  if (!uri?.startsWith("file://")) return null;
  const start = record.targetSelectionRange?.start ?? record.range?.start;
  return {
    path: fileURLToPath(uri),
    line: (start?.line ?? 0) + 1,
    character: start?.character ?? 0,
  };
}
