import { renderUntrustedWorkspaceData } from "../../prompts/untrusted-workspace-content.js";
import type { PastedContent } from "../../utils/config.js";
import type { WorkbenchAttachment } from "./types.js";

export const MAX_CAPTURED_EDITOR_BYTES = 64 * 1024;
export const MAX_CAPTURED_EDITOR_LINES = 2_000;

export function isCapturedWorkbenchAttachment(
  attachment: WorkbenchAttachment,
): boolean {
  return (
    attachment.kind === "editor-selection" ||
    attachment.kind === "editor-diagnostic"
  );
}

export function capturedAttachmentsToPastedContents(
  attachments: readonly WorkbenchAttachment[],
  allocateId: () => number,
): Record<number, PastedContent> {
  const out: Record<number, PastedContent> = {};
  for (const attachment of attachments) {
    if (!isCapturedWorkbenchAttachment(attachment)) continue;
    const content = renderCapturedAttachment(attachment);
    const id = allocateId();
    out[id] = { id, type: "text", content };
  }
  return out;
}

export function renderCapturedAttachment(
  attachment: WorkbenchAttachment,
): string {
  if (!isCapturedWorkbenchAttachment(attachment)) {
    throw new Error(
      `Attachment ${attachment.id} is not a captured editor attachment.`,
    );
  }
  const content = attachment.content ?? "";
  assertCaptureBounds(content);
  const path = attachment.path ?? "(unnamed buffer)";
  const startLine = Math.max(1, attachment.line ?? 1);
  const endLine = Math.max(startLine, attachment.endLine ?? startLine);
  const startColumn = Math.max(0, attachment.startColumn ?? 0);
  const endColumn = Math.max(0, attachment.endColumn ?? startColumn);
  const exactRange = JSON.stringify({
    start: { line: startLine, column: startColumn },
    end: { line: endLine, column: endColumn },
    ...(attachment.selectionMode !== undefined
      ? { selection_mode: attachment.selectionMode }
      : {}),
    line_base: 1,
    column_base: 0,
    column_unit: "utf8_byte",
    end_exclusive: true,
  });
  const dirty = attachment.dirty
    ? "unsaved live-buffer snapshot"
    : "live-buffer snapshot";
  const diagnostic = attachment.diagnostic
    ? [
        "",
        `Diagnostic${attachment.diagnostic.source ? ` from ${attachment.diagnostic.source}` : ""}:`,
        attachment.diagnostic.message,
      ].join("\n")
    : "";
  return renderUntrustedWorkspaceData(
    `embedded editor ${attachment.kind}: ${path}`,
    [
      `${dirty} from ${path}. Exact editor range: ${exactRange}.`,
      content,
      diagnostic,
    ]
      .filter((part) => part.length > 0)
      .join("\n"),
  );
}

function assertCaptureBounds(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_CAPTURED_EDITOR_BYTES) {
    throw new Error(
      `Editor capture exceeds ${MAX_CAPTURED_EDITOR_BYTES} bytes; select a smaller range or save and attach the file.`,
    );
  }
  const lineCount = content.length === 0 ? 0 : content.split("\n").length;
  if (lineCount > MAX_CAPTURED_EDITOR_LINES) {
    throw new Error(
      `Editor capture exceeds ${MAX_CAPTURED_EDITOR_LINES} lines; select a smaller range or save and attach the file.`,
    );
  }
}
