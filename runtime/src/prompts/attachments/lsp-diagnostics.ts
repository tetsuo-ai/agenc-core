/**
 * Passive LSP diagnostics attachment producer.
 *
 * LSP servers publish diagnostics asynchronously. This producer drains the
 * pending registry once per turn and hands bounded rendering to messages.ts.
 */

import {
  checkForLSPDiagnostics,
} from "../../services/lsp/LSPDiagnosticRegistry.js";
import type { DiagnosticFile } from "../../services/lsp/types.js";
import type { AttachmentProducer } from "./orchestrator.js";
import type { Attachment } from "./types.js";

function cloneDiagnosticFiles(
  files: readonly DiagnosticFile[],
): DiagnosticFile[] {
  return files.map((file) => ({
    uri: file.uri,
    diagnostics: file.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      ...(diagnostic.range !== undefined
        ? {
            range: {
              start: { ...diagnostic.range.start },
              end: { ...diagnostic.range.end },
            },
          }
        : {}),
    })),
  }));
}

export const lspDiagnosticsProducer: AttachmentProducer = async (options) => {
  try {
    return checkForLSPDiagnostics(options.sandboxExecutionBroker).map(
      ({ serverName, files }): Attachment => ({
        kind: "lsp_diagnostics",
        serverName,
        files: cloneDiagnosticFiles(files),
      }),
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[attachments] failed to collect LSP diagnostics:", error);
    return [];
  }
};
