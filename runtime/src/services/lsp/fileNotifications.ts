/**
 * Best-effort file mutation notifications for the LSP service.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  clearDeliveredDiagnosticsForFile,
  consumePendingDiagnosticsForFile,
  waitForFileDiagnostics,
} from "./LSPDiagnosticRegistry.js";
import type { DiagnosticEntry, DiagnosticFile } from "./types.js";
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

const DEFAULT_EDIT_FEEDBACK_MS = 1500;
const MAX_EDIT_FEEDBACK_ENTRIES = 8;

/** How long a file mutation waits for the language server's verdict; 0 disables. */
export function editFeedbackTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENC_LSP_EDIT_FEEDBACK_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_EDIT_FEEDBACK_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_EDIT_FEEDBACK_MS;
  return Math.min(Math.floor(parsed), 30_000);
}

function severityRank(severity: DiagnosticEntry["severity"]): number {
  switch (severity) {
    case "Error":
      return 0;
    case "Warning":
      return 1;
    case "Info":
      return 2;
    default:
      return 3;
  }
}

/**
 * Render one file's diagnostics as the suffix a mutation tool appends to its
 * result: errors first, positions 1-based, bounded, one line each.
 */
export function formatEditFeedback(
  displayPath: string,
  file: DiagnosticFile,
): string {
  if (file.diagnostics.length === 0) {
    return "\n\nLanguage server: no diagnostics for this file after the edit.";
  }
  const sorted = [...file.diagnostics].sort(
    (left, right) => severityRank(left.severity) - severityRank(right.severity),
  );
  const errors = sorted.filter((diagnostic) => diagnostic.severity === "Error").length;
  const warnings = sorted.filter((diagnostic) => diagnostic.severity === "Warning").length;
  const counts = [
    errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : undefined,
    warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"}` : undefined,
    sorted.length - errors - warnings > 0 ? `${sorted.length - errors - warnings} other` : undefined,
  ].filter(Boolean).join(", ");
  const lines = sorted.slice(0, MAX_EDIT_FEEDBACK_ENTRIES).map((diagnostic) => {
    const position = diagnostic.range
      ? `:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`
      : "";
    const code = diagnostic.code ? ` ${diagnostic.source ?? ""}${diagnostic.source ? " " : ""}${diagnostic.code}` : diagnostic.source ? ` ${diagnostic.source}` : "";
    return `  ${displayPath}${position} ${(diagnostic.severity ?? "info").toLowerCase()}${code}: ${diagnostic.message.split("\n")[0]}`;
  });
  const more = sorted.length > MAX_EDIT_FEEDBACK_ENTRIES
    ? `\n  ... ${sorted.length - MAX_EDIT_FEEDBACK_ENTRIES} more`
    : "";
  return `\n\nLanguage server diagnostics after this edit (${counts}):\n${lines.join("\n")}${more}`;
}

/**
 * Notify the language server of a mutation and wait, bounded, for its verdict
 * on that file. Returns the suffix to append to the tool result, or "" when
 * no server covers the file, nothing arrives in time, or feedback is off.
 * Diagnostics shown here are marked delivered so the next-turn attachment
 * does not repeat them. Never throws: the mutation already succeeded.
 */
export async function collectEditFeedback(
  filePath: string,
  content: string,
  options: {
    readonly displayPath?: string;
    readonly timeoutMs?: number;
    readonly scope?: SandboxExecutionBrokerLike;
  } = {},
): Promise<string> {
  const scope = options.scope ?? peekAmbientRuntimeSession()?.services.sandboxExecutionBroker;
  const timeoutMs = options.timeoutMs ?? editFeedbackTimeoutMs();
  const absolutePath = resolve(filePath);
  const manager = getLspServerManager(scope);
  const covered = manager !== undefined && timeoutMs > 0 && managerCoversFile(manager, absolutePath);
  if (!covered) {
    notifyLspFileChanged(filePath, content, scope);
    return "";
  }
  try {
    const verdict = waitForFileDiagnostics(absolutePath, timeoutMs, scope);
    notifyLspFileChanged(filePath, content, scope);
    const file = await verdict;
    if (file === undefined) return "";
    consumePendingDiagnosticsForFile(absolutePath, scope);
    return formatEditFeedback(options.displayPath ?? displayPathFor(absolutePath), file);
  } catch {
    return "";
  }
}

/** The path the model sees: relative to the working directory when inside it. */
function displayPathFor(absolutePath: string): string {
  const cwd = process.cwd();
  const rel = relative(cwd, absolutePath);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolutePath;
}

function managerCoversFile(
  manager: NonNullable<ReturnType<typeof getLspServerManager>>,
  absolutePath: string,
): boolean {
  const candidate = manager as { getServerForFile?: (path: string) => unknown };
  if (typeof candidate.getServerForFile !== "function") return true;
  try {
    return candidate.getServerForFile(absolutePath) !== undefined;
  } catch {
    return false;
  }
}
