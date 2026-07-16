/**
 * Best-effort file mutation notifications for the LSP service.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { clearDeliveredDiagnosticsForFile } from "./LSPDiagnosticRegistry.js";
import { getLspServerManager } from "./manager.js";
import { peekAmbientRuntimeSession } from "../../session/current-session.js";
import type { SandboxExecutionBrokerLike } from "../../sandbox/execution-broker.js";

export function notifyLspFileChanged(
  filePath: string,
  content: string,
  scope: SandboxExecutionBrokerLike | undefined =
    peekAmbientRuntimeSession()?.services.sandboxExecutionBroker,
): void {
  const absolutePath = resolve(filePath);
  clearDeliveredDiagnosticsForFile(absolutePath, scope);
  clearDeliveredDiagnosticsForFile(pathToFileURL(absolutePath).href, scope);
  const manager = getLspServerManager(scope);
  if (!manager) return;
  void (async () => {
    try {
      await manager.changeFile(filePath, content);
      await manager.saveFile(filePath);
    } catch {
      // LSP notifications are best-effort. File mutation tools must never fail
      // because an optional language server is unavailable.
    }
  })();
}
