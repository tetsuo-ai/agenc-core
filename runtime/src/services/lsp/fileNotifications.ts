/**
 * Best-effort file mutation notifications for the LSP service.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { clearDeliveredDiagnosticsForFile } from "./LSPDiagnosticRegistry.js";
import { getLspServerManager } from "./manager.js";

export function notifyLspFileChanged(filePath: string, content: string): void {
  clearDeliveredDiagnosticsForFile(pathToFileURL(resolve(filePath)).href);
  const manager = getLspServerManager();
  if (!manager) return;
  void manager.changeFile(filePath, content).catch(() => {});
  void manager.saveFile(filePath).catch(() => {});
}
