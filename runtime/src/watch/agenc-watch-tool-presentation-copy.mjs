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
    if (toolName === "system.grep" || toolName === "Grep" || toolName === "Glob") {
      return `Search failed: ${truncate(text, 180)}`;
    }
    if (
      toolName === "system.readFile"
      || toolName === "system.readFileRange"
      || toolName === "FileRead"
      || toolName === "Read"
    ) {
      return `Read failed: ${truncate(text, 180)}`;
    }
    if (toolName === "system.editFile" || toolName === "Edit" || toolName === "MultiEdit") {
      return `Edit failed: ${truncate(text, 180)}`;
    }
    return null;
  }

  function lineRangeCopy(fileRange) {
    if (!fileRange || typeof fileRange !== "object") {
      return null;
    }
    const start = Number(fileRange.startLine);
    const end = Number(fileRange.endLine);
    if (!Number.isFinite(start)) {
      return null;
    }
    return Number.isFinite(end) && end !== start
      ? `lines: ${start}-${end}`
      : `line: ${start}`;
  }

  function mutationVerb(data, { past = false } = {}) {
    if (data.isPlanFile) {
      return past ? "Updated plan" : "Update plan";
    }
    if (data.operation === "create") {
      return past ? "Created" : "Create";
    }
    return past ? "Updated" : "Update";
  }

  function compactPlanPreview(planText) {
    return compactBodyLines(planText, {
      sanitizeDisplayText,
      sanitizeInlineText,
      truncate,
      maxLines: Math.max(4, maxEventBodyLines),
    }).join("\n");
  }

  function describeToolStart(data) {
    switch (data.kind) {
      case "delegate-start":
        {
          const isVerification = /verif/i.test(data.agentType ?? "");
          return {
            title: `${isVerification ? "Verify" : "Delegate"} ${truncate(data.objective || "child task", 110)}`,
            body: joinDescriptorBody(
              [
                data.agentType ? `agent: ${data.agentType}` : null,
                data.tools.length > 0 ? `tools: ${data.tools.join(", ")}` : null,
                data.workingDirectory ? `cwd: ${data.workingDirectory}` : null,
                data.acceptanceCriteria.length > 0
                  ? `acceptance: ${truncate(data.acceptanceCriteria.join(" | "), 180)}`
                  : null,
              ],
              data.objective || "(delegated child task)",
            ),
            tone: isVerification ? "blue" : "magenta",
          };
        }
      case "file-write-start":
        {
          const lineCount = countTextLines(data.content);
          const preview = buildFileWritePreview(data.content);
          const titlePrefix = data.isPlanFile
            ? "Update plan"
            : data.action === "append"
            ? "Append"
            : "Write";
          return {
            title: data.isPlanFile
              ? titlePrefix
              : `${titlePrefix} ${data.filePathDisplay || "file"}`,
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
          title: data.isPlanFile
            ? mutationVerb(data)
            : `${mutationVerb(data)} ${data.filePathDisplay || "file"}`,
          body: data.filePathDisplay || "(pending edit)",
          tone: "yellow",
          previewMode: "source-write",
          ...buildSourceMetadata({
            filePath: data.filePathRaw,
            mutationKind: data.operation === "create" ? "create" : "replace",
            mutationBeforeText: data.oldText ?? undefined,
            mutationAfterText: data.newText ?? undefined,
          }),
        };
      case "file-read-start":
        return {
          title: data.isPlanFile
            ? "Reading plan"
            : `Read ${data.filePathDisplay || "file"}`,
          body: joinDescriptorBody(
            [
              data.filePathDisplay ? `path: ${data.filePathDisplay}` : null,
              lineRangeCopy(data.fileRange),
              Array.isArray(data.pages) && data.pages.length > 0
                ? `pages: ${data.pages.join(", ")}`
                : null,
            ],
            "(pending read)",
          ),
          tone: "slate",
          previewMode: "source-read",
          ...buildSourceMetadata({
            filePath: data.filePathRaw,
            fileRange: data.fileRange,
          }),
        };
      case "search-start":
        return {
          title: data.searchKind === "glob"
            ? `Find files ${data.pattern || "pattern"}`
            : `Search ${data.pattern ? `"${data.pattern}"` : "files"}`,
          body: joinDescriptorBody(
            [
              data.pattern ? `pattern: ${data.pattern}` : null,
              data.pathDisplay ? `path: ${data.pathDisplay}` : null,
              data.glob ? `glob: ${data.glob}` : null,
              data.outputMode ? `mode: ${data.outputMode}` : null,
            ],
            "(pending search)",
          ),
          tone: "slate",
        };
      case "todo-start":
        return {
          title: "Update tasks",
          body: joinDescriptorBody(
            [
              `tasks: ${data.total}`,
              data.completed > 0 ? `completed: ${data.completed}` : null,
              data.inProgress > 0 ? `in progress: ${data.inProgress}` : null,
            ],
            "(task list update)",
          ),
          tone: "slate",
        };
      case "plan-mode-start":
        return {
          title: "Enter plan mode",
          body: data.reason || "AgenC is preparing an implementation approach.",
          tone: "blue",
        };
      case "plan-exit-start":
        return {
          title: "Submit plan",
          body: joinDescriptorBody(
            [
              data.filePathDisplay ? `path: ${data.filePathDisplay}` : null,
              compactPlanPreview(data.planText),
            ],
            "(plan submitted)",
          ),
          tone: "blue",
          ...buildSourceMetadata({
            filePath: data.filePathRaw,
          }),
        };
      case "verification-start":
        return {
          title: "Verify plan execution",
          body: data.objective || "(verification requested)",
          tone: "blue",
        };
      case "question-start":
        return {
          title: "Ask user question",
          body: data.question || "(question pending)",
          tone: "amber",
        };
      case "external-start":
        return {
          title: `${data.toolName} ${data.target || "external surface"}`,
          body: data.target || "(external surface request)",
          tone: "slate",
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
        {
          const isVerification = /verif/i.test(data.agentType ?? "");
          return {
            title: `${data.isError
              ? isVerification ? "Verification failed" : "Delegation failed"
              : isVerification ? "Verified plan" : "Delegated"} ${
              data.childToken ? `child ${data.childToken}` : "child task"
            }`,
            body: joinDescriptorBody(
              [
                data.agentType ? `agent: ${data.agentType}` : null,
                data.status ? `status: ${data.status}` : null,
                typeof data.toolCalls === "number" ? `tool calls: ${data.toolCalls}` : null,
                "",
                data.errorText ?? data.outputText ?? data.errorPreview ?? data.outputPreview,
              ],
              "(delegation finished)",
            ),
            tone: data.isError ? "red" : isVerification ? "blue" : "magenta",
          };
        }
      case "file-write-result":
        {
          const lineCount = countTextLines(data.content);
          const preview = buildFileWritePreview(data.content);
          const titlePrefix = data.isPlanFile
            ? "Updated plan"
            : data.action === "append"
            ? "Appended"
            : "Wrote";
          return {
            title: data.isPlanFile
              ? titlePrefix
              : `${titlePrefix} ${data.filePathDisplay || "file"}`,
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
          title: data.isPlanFile
            ? mutationVerb(data, { past: !data.isError })
            : `${data.isError ? mutationVerb(data) : mutationVerb(data, { past: true })} ${data.filePathDisplay || "file"}`,
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
            mutationKind: data.operation === "create" ? "create" : "replace",
            mutationBeforeText: data.oldText ?? undefined,
            mutationAfterText: data.newText ?? undefined,
          }),
        };
      case "file-read-result":
        return {
          title: data.isError
            ? `Read failed ${data.filePathDisplay || "file"}`
            : data.isPlanFile
            ? "Read plan"
            : `Read ${data.filePathDisplay || "file"}`,
          body: data.isError
            ? (data.errorPreview || data.errorText || "Error reading file")
            : joinDescriptorBody(
                [
                  data.filePathDisplay ? `path: ${data.filePathDisplay}` : null,
                  lineRangeCopy(data.fileRange),
                  typeof data.lineCount === "number" ? `lines: ${data.lineCount}` : null,
                  data.sizeText,
                ],
                data.filePathDisplay || "(file read)",
              ),
          tone: data.isError ? "red" : "slate",
          previewMode: "source-read",
          ...buildSourceMetadata({
            filePath: data.filePathRaw,
            fileRange: data.fileRange,
          }),
        };
      case "search-result": {
        const resultSummary = data.isError
          ? data.errorText || data.outputPreview || "Search failed"
          : typeof data.matchCount === "number"
          ? `Found ${data.matchCount} ${data.matchCount === 1 ? "match" : "matches"}`
          : typeof data.lineCount === "number"
          ? `Found ${data.lineCount} ${data.lineCount === 1 ? "line" : "lines"}`
          : typeof data.fileCount === "number"
          ? `Found ${data.fileCount} ${data.fileCount === 1 ? "file" : "files"}`
          : data.outputPreview || "Search complete";
        return {
          title: data.isError ? "Search failed" : resultSummary,
          body: joinDescriptorBody(
            [
              data.pattern ? `pattern: ${data.pattern}` : null,
              data.pathDisplay ? `path: ${data.pathDisplay}` : null,
              data.glob ? `glob: ${data.glob}` : null,
              data.outputPreview && data.outputPreview !== resultSummary
                ? data.outputPreview
                : null,
            ],
            resultSummary,
          ),
          tone: data.isError ? "red" : "slate",
        };
      }
      case "todo-result":
        return {
          title: "Updated tasks",
          body: joinDescriptorBody(
            [
              `tasks: ${data.total}`,
              data.completed > 0 ? `completed: ${data.completed}` : null,
              data.inProgress > 0 ? `in progress: ${data.inProgress}` : null,
              data.outputPreview,
            ],
            "(task list updated)",
          ),
          tone: data.isError ? "red" : "slate",
        };
      case "plan-mode-result":
        return {
          title: data.isError
            ? "Plan mode failed"
            : data.declined
            ? "User declined plan mode"
            : "Entered plan mode",
          body: data.isError
            ? (data.errorText || "Plan mode failed")
            : "AgenC is now exploring and designing an implementation approach.",
          tone: data.isError || data.declined ? "amber" : "blue",
        };
      case "plan-exit-result": {
        const title = data.isError
          ? "Plan submission failed"
          : data.awaitingLeaderApproval
          ? "Plan submitted for review"
          : data.rejected
          ? "Plan changes requested"
          : data.approved
          ? "User approved AgenC plan"
          : "Exited plan mode";
        return {
          title,
          body: data.isError
            ? (data.errorText || "Plan submission failed")
            : joinDescriptorBody(
                [
                  data.filePathDisplay ? `path: ${data.filePathDisplay}` : null,
                  compactPlanPreview(data.planText),
                ],
                title,
              ),
          tone: data.isError || data.rejected ? "amber" : "blue",
          ...buildSourceMetadata({
            filePath: data.filePathRaw,
          }),
        };
      }
      case "verification-result":
        return {
          title: data.isError ? "Verification failed" : "Verified plan execution",
          body: joinDescriptorBody(
            [
              data.status ? `status: ${data.status}` : null,
              data.errorText ?? data.outputPreview,
            ],
            data.isError ? "Verification failed" : "Verification complete",
          ),
          tone: data.isError ? "red" : "blue",
        };
      case "question-result":
        return {
          title: data.isError ? "Question failed" : "Question answered",
          body: data.errorText ?? data.answerPreview ?? "(answer received)",
          tone: data.isError ? "red" : "amber",
        };
      case "external-disabled-result":
        return {
          title: `${data.surface || data.toolName} disabled locally`,
          body: joinDescriptorBody(
            [
              data.target ? `target: ${data.target}` : null,
              data.reason ? `reason: ${data.reason}` : null,
            ],
            "External surface disabled locally.",
          ),
          tone: "amber",
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
