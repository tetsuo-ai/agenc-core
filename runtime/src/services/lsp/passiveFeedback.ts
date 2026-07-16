/**
 * Ports donor passive LSP diagnostic feedback handlers.
 *
 * Each running LSP server can publish diagnostics asynchronously. These
 * handlers normalize the payload and register it for delivery through the
 * diagnostic registry on the next model turn.
 */

import { fileURLToPath } from "node:url";

import {
  registerPendingLSPDiagnostic,
  type LSPDiagnosticScope,
} from "./LSPDiagnosticRegistry.js";
import type { LSPServerManager } from "./LSPServerManager.js";
import type { PublishDiagnosticsParams } from "./protocol.js";
import type { DiagnosticEntry, DiagnosticFile } from "./types.js";
import { errorMessage } from "../../utils/errors.js";

function mapLSPSeverity(
  severity: number | undefined,
): DiagnosticEntry["severity"] {
  switch (severity) {
    case 1:
      return "Error";
    case 2:
      return "Warning";
    case 3:
      return "Info";
    case 4:
      return "Hint";
    default:
      return undefined;
  }
}

function uriToPath(uri: string): string {
  try {
    return uri.startsWith("file://") ? fileURLToPath(uri) : uri;
  } catch {
    return uri;
  }
}

function isPublishDiagnosticsParams(
  params: unknown,
): params is PublishDiagnosticsParams {
  return (
    typeof params === "object" &&
    params !== null &&
    "uri" in params &&
    typeof (params as { readonly uri?: unknown }).uri === "string" &&
    "diagnostics" in params &&
    Array.isArray((params as { readonly diagnostics?: unknown }).diagnostics)
  );
}

function isDiagnosticPayload(diagnostic: unknown): diagnostic is PublishDiagnosticsParams["diagnostics"][number] {
  if (typeof diagnostic !== "object" || diagnostic === null) return false;
  const candidate = diagnostic as {
    readonly message?: unknown;
    readonly range?: {
      readonly start?: { readonly line?: unknown; readonly character?: unknown };
      readonly end?: { readonly line?: unknown; readonly character?: unknown };
    };
  };
  return (
    typeof candidate.message === "string" &&
    typeof candidate.range?.start?.line === "number" &&
    typeof candidate.range.start.character === "number" &&
    typeof candidate.range?.end?.line === "number" &&
    typeof candidate.range.end.character === "number"
  );
}

export function formatDiagnosticsForAttachment(
  params: PublishDiagnosticsParams,
): DiagnosticFile[] {
  return [
    {
      uri: uriToPath(params.uri),
      diagnostics: params.diagnostics
        .filter(isDiagnosticPayload)
        .map((diagnostic) => {
          const severity = mapLSPSeverity(diagnostic.severity);
          return {
            message: diagnostic.message,
            ...(severity !== undefined ? { severity } : {}),
            range: diagnostic.range,
            source: diagnostic.source,
            ...(diagnostic.code !== undefined
              ? { code: String(diagnostic.code) }
              : {}),
          };
        }),
    },
  ];
}

export interface HandlerRegistrationResult {
  readonly totalServers: number;
  readonly successCount: number;
  readonly registrationErrors: Array<{ readonly serverName: string; readonly error: string }>;
  readonly diagnosticFailures: Map<string, { count: number; lastError: string }>;
}

export function registerLSPNotificationHandlers(
  manager: LSPServerManager,
  scope?: LSPDiagnosticScope,
): HandlerRegistrationResult {
  const servers = manager.getAllServers();
  const registrationErrors: Array<{ serverName: string; error: string }> = [];
  const diagnosticFailures = new Map<string, { count: number; lastError: string }>();
  let successCount = 0;

  for (const [serverName, server] of servers.entries()) {
    try {
      if (typeof server.onNotification !== "function") {
        registrationErrors.push({
          serverName,
          error: "Server instance has no onNotification method",
        });
        continue;
      }
      server.onNotification("textDocument/publishDiagnostics", (params) => {
        try {
          if (!isPublishDiagnosticsParams(params)) {
            throw new Error("missing uri or diagnostics");
          }
          const files = formatDiagnosticsForAttachment(params);
          const first = files[0];
          if (!first) return;
          registerPendingLSPDiagnostic({ serverName, files }, scope);
          diagnosticFailures.delete(serverName);
        } catch (error) {
          const message = errorMessage(error);
          const failures = diagnosticFailures.get(serverName) ?? {
            count: 0,
            lastError: "",
          };
          failures.count += 1;
          failures.lastError = message;
          diagnosticFailures.set(serverName, failures);
        }
      });
      successCount += 1;
    } catch (error) {
      registrationErrors.push({
        serverName,
        error: errorMessage(error),
      });
    }
  }

  return {
    totalServers: servers.size,
    successCount,
    registrationErrors,
    diagnosticFailures,
  };
}
