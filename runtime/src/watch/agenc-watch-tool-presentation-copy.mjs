import { buildSourceMetadata } from "./agenc-watch-tool-presentation-core.mjs";
import { createWatchToolPresentationEditorDescriptors } from "./agenc-watch-tool-presentation-editor.mjs";
import {
  compactBodyLines,
  joinDescriptorBody,
} from "./agenc-watch-tool-presentation-utils.mjs";

export function createWatchToolPresentationCopyBuilder(dependencies = {}) {
  const {
    sanitizeInlineText,
    sanitizeDisplayText,
    truncate,
    buildToolSummary,
    maxEventBodyLines = 5,
  } = dependencies;

  const {
    describeDesktopTextEditorResult,
    describeDesktopTextEditorStart,
  } = createWatchToolPresentationEditorDescriptors({ truncate });

  const FILE_WRITE_PREVIEW_MAX_LINES = 10;
  const FILE_WRITE_PREVIEW_MAX_CHARS = 2400;

  function countTextLines(value) {
    if (typeof value !== "string" || value.length === 0) {
      return 0;
    }
    const segments = value.split("\n");
    return value.endsWith("\n") ? segments.length - 1 : segments.length;
  }

  function buildFileWritePreview(value) {
    if (typeof value !== "string" || value.length === 0) {
      return null;
    }
    const normalized = String(value).replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    const previewLines = lines.slice(0, FILE_WRITE_PREVIEW_MAX_LINES).join("\n");
    return truncate(previewLines, FILE_WRITE_PREVIEW_MAX_CHARS);
  }

  function summarizeEditFileErrorCopy(data) {
    const text = String(data.errorText ?? "").replace(/\s+/g, " ").trim();
    if (!text) return "Error editing file";
    if (/file has not been read yet|must be read first|call system\.readfile/i.test(text)) {
      return "File must be read first";
    }
    if (/file not found|path does not exist|enoent/i.test(text)) {
      return "File not found";
    }
    return "Error editing file";
  }

  function summarizeToolErrorCopy(toolName, prettyResult) {
    const text = String(prettyResult ?? "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    if (/old_string and new_string are identical/i.test(text)) {
      return "No-op edit rejected";
    }
    if (/must be read first|full-file read/i.test(text)) {
      return "File must be read first";
    }
    if (/path does not exist|file not found|enoent/i.test(text)) {
      return "File not found";
    }
    if (toolName === "system.grep" || toolName === "system.searchFiles") {
      return `Search failed: ${truncate(text, 180)}`;
    }
    if (toolName === "system.readFile" || toolName === "system.readFileRange") {
      return `Read failed: ${truncate(text, 180)}`;
    }
    if (toolName === "system.editFile" || toolName === "system.applyPatch") {
      return `Edit failed: ${truncate(text, 180)}`;
    }
    return null;
  }

  function describeToolStart(data) {
    switch (data.kind) {
      case "delegate-start":
        return {
          title: `Delegate ${truncate(data.objective || "child task", 110)}`,
          body: joinDescriptorBody(
            [
              data.tools.length > 0 ? `tools: ${data.tools.join(", ")}` : null,
              data.workingDirectory ? `cwd: ${data.workingDirectory}` : null,
              data.acceptanceCriteria.length > 0
                ? `acceptance: ${truncate(data.acceptanceCriteria.join(" | "), 180)}`
                : null,
            ],
            data.objective || "(delegated child task)",
          ),
          tone: "magenta",
        };
      case "file-write-start":
        {
          const lineCount = countTextLines(data.content);
          const preview = buildFileWritePreview(data.content);
          return {
            title: `${data.action === "append" ? "Append" : "Write"} ${data.filePathDisplay || "file"}`,
            body: joinDescriptorBody(
              [
                data.filePathDisplay ? `path: ${data.filePathDisplay}` : null,
                lineCount > 0 ? `lines: ${lineCount}` : null,
                preview ? "" : null,
                preview,
              ],
              data.filePathDisplay || "(pending file write)",
            ),
            tone: "yellow",
            previewMode: "source-write",
            ...buildSourceMetadata({
              filePath: data.filePathRaw,
              mutationKind: data.action,
              mutationAfterText: preview ?? undefined,
            }),
          };
        }
      case "file-edit-start":
        return {
          title: `Update ${data.filePathDisplay || "file"}`,
          body: data.filePathDisplay || "(pending edit)",
          tone: "yellow",
          previewMode: "source-write",
          ...buildSourceMetadata({
            filePath: data.filePathRaw,
            mutationKind: "replace",
            mutationBeforeText: data.oldText ?? undefined,
            mutationAfterText: data.newText ?? undefined,
          }),
        };
      case "file-read-start":
        return {
          title: `Read ${data.filePathDisplay || "file"}`,
          body: data.filePathDisplay ? `path: ${data.filePathDisplay}` : "(pending read)",
          tone: "slate",
          previewMode: "source-read",
          ...buildSourceMetadata({
            filePath: data.filePathRaw,
          }),
        };
      case "list-dir-start":
        return {
          title: `List ${data.dirPathDisplay || "directory"}`,
          body: data.dirPathDisplay || "(pending directory listing)",
          tone: "slate",
        };
      case "mkdir-start":
        return {
          title: `mkdir ${data.dirPathDisplay || "directory"}`,
          body: data.dirPathDisplay ? `path: ${data.dirPathDisplay}` : "(pending directory create)",
          tone: "yellow",
        };
      case "shell-start":
        return {
          title: `Run ${data.commandText || "command"}`,
          body: data.cwdDisplay ? `cwd: ${data.cwdDisplay}` : data.commandText || "(pending command)",
          tone: "yellow",
        };
      case "desktop-editor-start":
        return describeDesktopTextEditorStart(data);
      default:
        return {
          title: data.toolName,
          body: truncate(data.payloadText, 220),
          tone: "yellow",
        };
    }
  }

  function describeToolResult(data) {
    switch (data.kind) {
      case "delegate-result":
        return {
          title: `${data.isError ? "Delegation failed" : "Delegated"} ${
            data.childToken ? `child ${data.childToken}` : "child task"
          }`,
          body: joinDescriptorBody(
            [
              data.status ? `status: ${data.status}` : null,
              typeof data.toolCalls === "number" ? `tool calls: ${data.toolCalls}` : null,
              "",
              data.errorText ?? data.outputText ?? data.errorPreview ?? data.outputPreview,
            ],
            "(delegation finished)",
          ),
          tone: data.isError ? "red" : "magenta",
        };
      case "file-write-result":
        {
          const lineCount = countTextLines(data.content);
          const preview = buildFileWritePreview(data.content);
          return {
            title: `${data.action === "append" ? "Appended" : "Wrote"} ${data.filePathDisplay || "file"}`,
            body: joinDescriptorBody(
              [
                data.filePathDisplay ? `path: ${data.filePathDisplay}` : null,
                lineCount > 0 ? `lines: ${lineCount}` : null,
                data.bytesWrittenText ? `written: ${data.bytesWrittenText}` : null,
                preview ? "" : null,
                preview,
              ],
              data.filePathDisplay || "(file written)",
            ),
            tone: data.isError ? "red" : "green",
            previewMode: "source-write",
            ...buildSourceMetadata({
              filePath: data.filePathRaw,
              mutationKind: data.action,
              mutationAfterText: preview ?? undefined,
            }),
          };
        }
      case "file-edit-result":
        return {
          title: `${data.isError ? "Update" : "Updated"} ${data.filePathDisplay || "file"}`,
          body: data.isError
            ? summarizeEditFileErrorCopy(data)
            : joinDescriptorBody(
                [
                  data.filePathDisplay ? `path: ${data.filePathDisplay}` : null,
                  typeof data.replacements === "number"
                    ? `replacements: ${data.replacements}`
                    : null,
                  data.bytesWrittenText ? `written: ${data.bytesWrittenText}` : null,
                ],
                data.filePathDisplay || "(file updated)",
              ),
          tone: data.isError ? "red" : "green",
          previewMode: "source-write",
          ...buildSourceMetadata({
            filePath: data.filePathRaw,
            mutationKind: "replace",
            mutationBeforeText: data.oldText ?? undefined,
            mutationAfterText: data.newText ?? undefined,
          }),
        };
      case "file-read-result":
        return {
          title: `Read ${data.filePathDisplay || "file"}`,
          body: joinDescriptorBody(
            [data.filePathDisplay ? `path: ${data.filePathDisplay}` : null, data.sizeText],
            data.filePathDisplay || "(file read)",
          ),
          tone: data.isError ? "red" : "slate",
          previewMode: "source-read",
          ...buildSourceMetadata({
            filePath: data.filePathRaw,
          }),
        };
      case "list-dir-result":
        return {
          title: `Listed ${data.dirPathDisplay || "directory"}`,
          body:
            data.entries.length > 0
              ? data.entries.join("  ")
              : data.dirPathDisplay || "(directory listed)",
          tone: data.isError ? "red" : "slate",
        };
      case "mkdir-result":
        return {
          title: `mkdir ${data.dirPathDisplay || "directory"}`,
          body: data.isError
            ? (data.errorPreview || "(mkdir failed)")
            : "Done",
          tone: data.isError ? "red" : "green",
        };
      case "desktop-editor-result":
        return describeDesktopTextEditorResult(data);
      case "shell-result": {
        const shellPreview = data.isError
          ? (data.stderrPreview ?? data.stdoutPreview ?? "")
          : (data.stdoutPreview ?? data.stderrPreview ?? "");
        const shellLines = compactBodyLines(shellPreview, {
          sanitizeDisplayText,
          sanitizeInlineText,
          truncate,
          maxLines: data.isError ? Math.max(3, maxEventBodyLines) : 2,
        });
        const shellFirstLine = sanitizeInlineText(shellLines[0] ?? "");
        const shellBody = data.isError
          ? (shellLines.join("\n") || data.commandText || "(command failed)")
          : [
            data.exitCode !== undefined ? `exit ${data.exitCode}` : null,
            shellFirstLine,
          ].filter(Boolean).join(" · ") || data.commandText || "(command completed)";
        return {
          title: `${data.isError ? "Command failed" : "Ran"} ${data.commandText || "command"}`,
          body: shellBody,
          tone: data.isError ? "red" : "green",
        };
      }
      default: {
        const summary = buildToolSummary(data.summaryEntries);
        const commonErrorCopy = data.isError
          ? summarizeToolErrorCopy(data.toolName, data.prettyResult)
          : null;
        return {
          title: data.isError ? `${data.toolName} failed` : data.toolName,
          body:
            commonErrorCopy
              ? commonErrorCopy
              : summary.length > 0
              ? summary.join("\n")
              : compactBodyLines(data.prettyResult, {
                sanitizeDisplayText,
                sanitizeInlineText,
                truncate,
                maxLines: data.isError ? Math.max(4, maxEventBodyLines) : maxEventBodyLines,
              }).join("\n"),
          tone: data.isError ? "red" : "green",
        };
      }
    }
  }

  return {
    describeToolResult,
    describeToolStart,
  };
}
