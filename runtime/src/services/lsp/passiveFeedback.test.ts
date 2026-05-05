import { describe, expect, test, beforeEach } from "vitest";

import {
  checkForLSPDiagnostics,
  resetAllLSPDiagnosticState,
} from "./LSPDiagnosticRegistry.js";
import type { LSPServerManager } from "./LSPServerManager.js";
import { formatDiagnosticsForAttachment, registerLSPNotificationHandlers } from "./passiveFeedback.js";
import type { LSPServerInstance } from "./LSPServerInstance.js";

describe("passive LSP feedback", () => {
  beforeEach(() => resetAllLSPDiagnosticState());

  test("formats LSP diagnostics for attachments", () => {
    const files = formatDiagnosticsForAttachment({
      uri: "file:///tmp/example.ts",
      diagnostics: [
        {
          message: "bad type",
          severity: 2,
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 3 },
          },
          source: "ts",
          code: 2322,
        },
      ],
    });

    expect(files).toEqual([
      {
        uri: "/tmp/example.ts",
        diagnostics: [
          {
            message: "bad type",
            severity: "Warning",
            range: {
              start: { line: 1, character: 0 },
              end: { line: 1, character: 3 },
            },
            source: "ts",
            code: "2322",
          },
        ],
      },
    ]);
  });

  test("filters malformed diagnostic entries without dropping valid ones", () => {
    const files = formatDiagnosticsForAttachment({
      uri: "/tmp/example.ts",
      diagnostics: [
        {
          message: "bad type",
          severity: 1,
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 3 },
          },
        },
        {
          message: "missing range",
        } as never,
      ],
    });

    expect(files[0]!.diagnostics).toHaveLength(1);
    expect(files[0]!.diagnostics[0]!.message).toBe("bad type");
  });

  test("registers notification handlers and isolates invalid payloads", () => {
    const handlers = new Map<string, (params: unknown) => void>();
    const server = {
      name: "ts",
      onNotification: (method: string, handler: (params: unknown) => void) => {
        handlers.set(method, handler);
      },
    } as LSPServerInstance;
    const manager = {
      getAllServers: () => new Map([["ts", server]]),
    } as LSPServerManager;

    const result = registerLSPNotificationHandlers(manager);
    expect(result.successCount).toBe(1);

    handlers.get("textDocument/publishDiagnostics")?.({ bad: true });
    expect(result.diagnosticFailures.get("ts")?.count).toBe(1);

    handlers.get("textDocument/publishDiagnostics")?.({
      uri: "/tmp/a.ts",
      diagnostics: [
        {
          message: "bad",
          severity: 1,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
        },
      ],
    });

    expect(result.diagnosticFailures.has("ts")).toBe(false);
    expect(checkForLSPDiagnostics()[0]!.files[0]!.diagnostics[0]!.message).toBe("bad");
  });
});
