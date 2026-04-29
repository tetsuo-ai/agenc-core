import path from "node:path";

export const DEFAULT_LOW_SIGNAL_SHELL_COMMANDS = new Set([
  "cat",
  "find",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "sed",
  "stat",
  "tail",
  "wc",
]);

function shellCommandTokens(command) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return [];
  }
  const tokens = command.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|[^\s]+/g) ?? [];
  return tokens
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function stripShellTokenQuotes(token) {
  if (typeof token !== "string" || token.length < 2) {
    return token;
  }
  const first = token[0];
  const last = token[token.length - 1];
  if ((first === `"` || first === "'" || first === "`") && last === first) {
    return token.slice(1, -1);
  }
  return token;
}

export function createWatchToolPresentationNormalizer(dependencies = {}) {
  const {
    sanitizeInlineText,
    sanitizeLargeText,
    truncate,
    stable,
    tryParseJson,
    tryPrettyJson,
    parseStructuredJson,
    lowSignalShellCommands = DEFAULT_LOW_SIGNAL_SHELL_COMMANDS,
  } = dependencies;

  function formatBytes(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
      return null;
    }
    if (numeric < 1024) return `${numeric} B`;
    if (numeric < 1024 * 1024) {
      return `${(numeric / 1024).toFixed(numeric >= 10 * 1024 ? 0 : 1)} KB`;
    }
    return `${(numeric / (1024 * 1024)).toFixed(1)} MB`;
  }

  function compactPathForDisplay(value, maxChars = 76) {
    const text = sanitizeInlineText(String(value ?? ""));
    if (text.length <= maxChars) {
      return text;
    }
    const parts = text.split("/");
    if (parts.length <= 3) {
      return truncate(text, maxChars);
    }
    return truncate(
      `${parts.slice(0, 2).join("/")}/…/${parts.slice(-2).join("/")}`,
      maxChars,
    );
  }

  function firstMeaningfulLine(value) {
    if (typeof value !== "string") return null;
    const line = sanitizeLargeText(value)
      .split("\n")
      .map((entry) => entry.trim())
      .find(Boolean);
    return line ? truncate(line, 160) : null;
  }

  function formatShellCommand(command, args) {
    const base = typeof command === "string" ? command.trim() : "";
    if (!base) return null;
    const argv = Array.isArray(args)
      ? args.filter((value) => typeof value === "string" && value.trim().length > 0)
      : [];
    if (argv.length === 0) {
      return truncate(base, 180);
    }
    return truncate(
      [base, ...argv.map((value) => (/\s/.test(value) ? JSON.stringify(value) : value))].join(" "),
      180,
    );
  }

  function editorCommandName(payload) {
    return sanitizeInlineText(payload?.command ?? payload?.action ?? "").toLowerCase();
  }

  function editorRawTargetPath(payload) {
    const value = payload?.path ?? payload?.filePath;
    return typeof value === "string" && value.trim().length > 0
      ? sanitizeInlineText(value)
      : null;
  }

  function editorTargetPath(payload) {
    return compactPathForDisplay(editorRawTargetPath(payload));
  }

  function editorBodyText(payload) {
    const candidates = [
      payload?.file_text,
      payload?.text,
      payload?.new_str,
      payload?.new_string,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate;
      }
    }
    return null;
  }

  function firstString(...values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
    return null;
  }

  function payloadPath(payload) {
    return firstString(
      payload?.path,
      payload?.file_path,
      payload?.filePath,
      payload?.filename,
    );
  }

  function rawDisplayPath(value) {
    return typeof value === "string" && value.trim().length > 0
      ? sanitizeInlineText(value)
      : null;
  }

  function payloadContent(payload) {
    return firstString(payload?.content, payload?.file_text, payload?.fileText);
  }

  function payloadOldText(payload) {
    return typeof payload?.old_string === "string"
      ? payload.old_string
      : typeof payload?.old_str === "string"
      ? payload.old_str
      : null;
  }

  function payloadNewText(payload) {
    return typeof payload?.new_string === "string"
      ? payload.new_string
      : typeof payload?.new_str === "string"
      ? payload.new_str
      : null;
  }

  function isPlanFilePath(value) {
    const text = String(value ?? "").replace(/\\/g, "/");
    return /(^|\/)(\.agenc|\.claude)\/plans\//i.test(text)
      || /(^|\/)plan(?:s)?\/[^/]+\.md$/i.test(text);
  }

  function lineRangeFromPayload(payload) {
    const startValue =
      payload?.startLine
      ?? payload?.start_line
      ?? payload?.offset
      ?? payload?.lineStart;
    const endValue =
      payload?.endLine
      ?? payload?.end_line
      ?? payload?.lineEnd;
    const limitValue = payload?.limit;
    const startLine = Number(startValue);
    const directEndLine = Number(endValue);
    const limit = Number(limitValue);
    if (!Number.isFinite(startLine)) {
      return normalizeRange(payload?.view_range);
    }
    const endLine = Number.isFinite(directEndLine)
      ? directEndLine
      : Number.isFinite(limit) && limit > 0
      ? startLine + limit - 1
      : null;
    return {
      startLine,
      ...(Number.isFinite(endLine) ? { endLine } : {}),
    };
  }

  function resultTextFromValue(value) {
    if (typeof value === "string") {
      return value;
    }
    if (value && typeof value === "object") {
      return firstString(
        value.output,
        value.stdout,
        value.content,
        value.text,
        value.message,
        value.result,
        value.error,
      ) ?? stable(value);
    }
    return stable(value);
  }

  function resultObjectFromValue(value, resultText) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
    const parsed = tryParseJson(resultText) ?? {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  }

  function countResultLines(resultObject, text) {
    const explicit = Number(
      resultObject.numLines
      ?? resultObject.lineCount
      ?? resultObject.linesRead
      ?? resultObject.lines,
    );
    if (Number.isFinite(explicit) && explicit >= 0) {
      return explicit;
    }
    const content = firstString(resultObject.content, resultObject.output, text);
    if (!content) return null;
    const normalized = content.replace(/\r\n/g, "\n");
    const segments = normalized.split("\n");
    return normalized.endsWith("\n") ? segments.length - 1 : segments.length;
  }

  function arrayLength(...values) {
    for (const value of values) {
      if (Array.isArray(value)) {
        return value.length;
      }
    }
    return null;
  }

  function finiteCount(value) {
    if (value == null) {
      return null;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function summarizeSearchCounts(resultObject, resultText) {
    const fileCount = finiteCount(
      resultObject.fileCount
      ?? resultObject.filesFound
      ?? arrayLength(resultObject.files, resultObject.filenames),
    );
    const matchCount = finiteCount(
      resultObject.matchCount
      ?? resultObject.matches
      ?? resultObject.count,
    );
    const lineCount = finiteCount(
      resultObject.lineCount
      ?? arrayLength(resultObject.lines, resultObject.results),
    );
    const text = typeof resultText === "string" ? resultText : "";
    const inferredFiles = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && /^[^:\s][^:]*:\d+[:\s]/.test(line))
      .map((line) => line.split(":")[0]);
    const uniqueInferredFiles = new Set(inferredFiles);
    return {
      fileCount: fileCount ?? (uniqueInferredFiles.size || null),
      matchCount,
      lineCount,
    };
  }

  function isExternalSurfaceTool(toolName) {
    return /^(WebFetch|WebSearch|TaskOutput|Remote|Browser|mcp\.|system\.web|system\.remote)/i.test(
      String(toolName ?? ""),
    );
  }

  function disabledExternalReason(resultObject, resultText) {
    const reason = firstString(
      resultObject.disabledReason,
      resultObject.reason,
      resultObject.error,
      resultObject.message,
      resultText,
    );
    if (!reason) return null;
    if (/disabled|unsupported|not enabled|not available|no[- ]?phone[- ]?home|phone home/i.test(reason)) {
      return sanitizeInlineText(reason);
    }
    return null;
  }

  function normalizeDelegatePayload(payload) {
    return {
      objective: sanitizeInlineText(
        payload.objective
          ?? payload.task
          ?? payload.prompt
          ?? payload.description
          ?? payload.inputContract
          ?? "",
      ),
      agentType: sanitizeInlineText(
        payload.agentType
          ?? payload.agent_type
          ?? payload.subagent_type
          ?? payload.subagentType
          ?? "",
      ),
      tools: Array.isArray(payload.tools)
        ? payload.tools.filter((value) => typeof value === "string")
        : [],
      workingDirectory:
        typeof payload.workingDirectory === "string"
          ? compactPathForDisplay(payload.workingDirectory)
          : typeof payload.cwd === "string"
          ? compactPathForDisplay(payload.cwd)
          : null,
      acceptanceCriteria: Array.isArray(payload.acceptanceCriteria)
        ? payload.acceptanceCriteria.filter((value) => typeof value === "string")
        : [],
    };
  }

  function normalizeRange(value) {
    if (Array.isArray(value) && value.length === 2) {
      return {
        startLine: Number(value[0]),
        endLine: Number(value[1]),
      };
    }
    return null;
  }

  function normalizePayload(args) {
    return args && typeof args === "object" && !Array.isArray(args)
      ? args
      : {};
  }

  function firstShellCommandToken(command) {
    const tokens = shellCommandTokens(command);
    for (const token of tokens) {
      const normalized = stripShellTokenQuotes(token);
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(normalized)) {
        continue;
      }
      return normalized;
    }
    return null;
  }

  function shellCommandBasename(payload) {
    const directCommand =
      typeof payload?.command === "string" && payload.command.trim().length > 0
        ? payload.command.trim()
        : "";
    const basenameSource =
      Array.isArray(payload?.args) && directCommand && !/\s/.test(directCommand)
        ? directCommand
        : firstShellCommandToken(directCommand);
    return basenameSource ? path.basename(basenameSource) : null;
  }

  function isLowSignalShellCommand(payload) {
    const basename = shellCommandBasename(payload);
    return Boolean(basename && lowSignalShellCommands.has(basename));
  }

  function isDesktopTextEditorReadCommand(payload) {
    return editorCommandName(payload) === "view";
  }

  function shouldSuppressToolTranscript(toolName, args, { isError = false } = {}) {
    if (isError) {
      return false;
    }
    switch (toolName) {
      case "FileRead":
      case "Read":
      case "system.readFile":
      case "system.readFileRange":
      case "Grep":
      case "Glob":
      case "system.grep":
      case "system.glob":
      case "system.searchFiles":
      case "system.listDir":
      case "TodoWrite":
        return true;
      case "Bash":
      case "system.bash":
      case "desktop.bash":
        return isLowSignalShellCommand(args);
      case "desktop.text_editor":
        return isDesktopTextEditorReadCommand(args);
      default:
        return false;
    }
  }

  function shouldSuppressToolActivity(toolName, args, options = {}) {
    return shouldSuppressToolTranscript(toolName, args, options);
  }

  function normalizeDesktopTextEditorStart(payload) {
    return {
      kind: "desktop-editor-start",
      command: editorCommandName(payload),
      filePathDisplay: editorTargetPath(payload),
      filePathRaw: editorRawTargetPath(payload),
      sourceText: editorBodyText(payload),
      oldText: typeof payload?.old_str === "string" ? payload.old_str : null,
      insertLine: Number.isFinite(Number(payload?.insert_line))
        ? Number(payload.insert_line)
        : null,
      viewRange: normalizeRange(payload?.view_range),
    };
  }

  function normalizeDesktopTextEditorResult(payload, resultObject, isError) {
    return {
      kind: "desktop-editor-result",
      isError,
      command: editorCommandName(payload),
      filePathDisplay: editorTargetPath(payload),
      filePathRaw: editorRawTargetPath(payload),
      sourceText: editorBodyText(payload),
      oldText: typeof payload?.old_str === "string" ? payload.old_str : null,
      insertLine: Number.isFinite(Number(payload?.insert_line))
        ? Number(payload.insert_line)
        : null,
      viewRange: normalizeRange(payload?.view_range),
      outputText:
        typeof resultObject?.output === "string" && resultObject.output.trim().length > 0
          ? resultObject.output
          : null,
    };
  }

  function normalizeToolStart(toolName, args) {
    const payload = normalizePayload(args);
    switch (toolName) {
      case "execute_with_agent":
      case "spawn_agent":
      case "Task":
        return {
          kind: "delegate-start",
          ...normalizeDelegatePayload(payload),
        };
      case "Write":
      case "system.writeFile":
      case "system.appendFile":
      case "NotebookEdit": {
        const filePathValue = payloadPath(payload);
        const action = toolName === "system.appendFile" ? "append" : "write";
        return {
          kind: "file-write-start",
          action,
          isPlanFile: isPlanFilePath(filePathValue),
          filePathDisplay: compactPathForDisplay(filePathValue),
          filePathRaw: rawDisplayPath(filePathValue),
          content: payloadContent(payload),
        };
      }
      case "Edit":
      case "MultiEdit":
      case "system.editFile":
      case "system.replaceInFile": {
        const filePathValue = payloadPath(payload);
        const oldText = payloadOldText(payload);
        return {
          kind: "file-edit-start",
          operation: oldText === "" ? "create" : "replace",
          isPlanFile: isPlanFilePath(filePathValue),
          filePathDisplay: compactPathForDisplay(filePathValue),
          filePathRaw: rawDisplayPath(filePathValue),
          oldText: oldText && oldText.length > 0 ? oldText : null,
          newText: payloadNewText(payload),
          replaceAll: payload.replace_all === true,
        };
      }
      case "FileRead":
      case "Read":
      case "system.readFile":
      case "system.readFileRange": {
        const filePathValue = payloadPath(payload);
        return {
          kind: "file-read-start",
          isPlanFile: isPlanFilePath(filePathValue),
          filePathDisplay: compactPathForDisplay(filePathValue),
          filePathRaw: rawDisplayPath(filePathValue),
          fileRange: lineRangeFromPayload(payload),
          pages: Array.isArray(payload.pages) ? payload.pages : null,
        };
      }
      case "Grep":
      case "Glob":
      case "system.grep":
      case "system.glob":
      case "system.searchFiles":
        return {
          kind: "search-start",
          toolName,
          searchKind: toolName === "Glob" || toolName === "system.glob" ? "glob" : "grep",
          pattern: sanitizeInlineText(payload.pattern ?? payload.query ?? payload.glob ?? ""),
          pathDisplay: compactPathForDisplay(payload.path ?? payload.dir ?? payload.directory),
          glob: sanitizeInlineText(payload.glob ?? ""),
          outputMode: sanitizeInlineText(payload.output_mode ?? payload.outputMode ?? ""),
        };
      case "TodoWrite":
        return {
          kind: "todo-start",
          total: Array.isArray(payload.todos) ? payload.todos.length : 0,
          completed: Array.isArray(payload.todos)
            ? payload.todos.filter((todo) => todo?.status === "completed").length
            : 0,
          inProgress: Array.isArray(payload.todos)
            ? payload.todos.filter((todo) => todo?.status === "in_progress").length
            : 0,
        };
      case "EnterPlanMode":
        return {
          kind: "plan-mode-start",
          reason: sanitizeInlineText(payload.reason ?? payload.prompt ?? ""),
        };
      case "ExitPlanMode":
        return {
          kind: "plan-exit-start",
          planText: firstString(payload.plan, payload.content),
          filePathDisplay: compactPathForDisplay(payloadPath(payload)),
          filePathRaw: rawDisplayPath(payloadPath(payload)),
        };
      case "VerifyPlanExecution":
      case "verify_plan_execution":
        return {
          kind: "verification-start",
          objective: sanitizeInlineText(payload.objective ?? payload.prompt ?? payload.description ?? ""),
        };
      case "AskUserQuestion":
        return {
          kind: "question-start",
          question: sanitizeInlineText(payload.question ?? payload.prompt ?? payload.text ?? ""),
        };
      case "WebFetch":
      case "WebSearch":
        return {
          kind: "external-start",
          toolName,
          target: sanitizeInlineText(payload.url ?? payload.query ?? payload.prompt ?? ""),
        };
      case "system.listDir":
        return {
          kind: "list-dir-start",
          dirPathDisplay: compactPathForDisplay(payload.path ?? payload.dir ?? payload.directory),
        };
      case "system.mkdir": {
        const dirPathValue = payload.path ?? payload.dir ?? payload.directory;
        return {
          kind: "mkdir-start",
          dirPathDisplay: compactPathForDisplay(dirPathValue),
          dirPathRaw:
            typeof dirPathValue === "string" && String(dirPathValue).trim().length > 0
              ? sanitizeInlineText(String(dirPathValue))
              : null,
        };
      }
      case "Bash":
      case "system.bash":
      case "desktop.bash":
        return {
          kind: "shell-start",
          commandText: formatShellCommand(payload.command, payload.args),
          cwdDisplay: compactPathForDisplay(payload.cwd),
        };
      case "desktop.text_editor":
        return normalizeDesktopTextEditorStart(payload);
      default:
        return {
          kind: "generic-start",
          toolName,
          payloadText: stable(payload),
        };
    }
  }

  function normalizeToolResult(toolName, args, isError, result) {
    const payload = normalizePayload(args);
    const resultText = resultTextFromValue(result);
    const resultObject = resultObjectFromValue(result, resultText);

    switch (toolName) {
      case "execute_with_agent":
      case "spawn_agent":
      case "Task":
        return {
          kind: "delegate-result",
          isError,
          agentType: sanitizeInlineText(
            payload.agentType
              ?? payload.agent_type
              ?? payload.subagent_type
              ?? payload.subagentType
              ?? resultObject.agentType
              ?? "",
          ),
          childToken: sanitizeInlineText(String(
            resultObject.subagentSessionId
              ?? resultObject.sessionId
              ?? resultObject.childSessionId
              ?? "",
          )).slice(-8),
          status: sanitizeInlineText(resultObject.status ?? ""),
          toolCalls: typeof resultObject.toolCalls === "number" ? resultObject.toolCalls : null,
          outputText:
            firstString(resultObject.output, resultObject.result, resultObject.content, resultText)
              ? firstString(resultObject.output, resultObject.result, resultObject.content, resultText)
              : null,
          errorText:
            typeof resultObject.error === "string" && resultObject.error.trim().length > 0
              ? resultObject.error
              : null,
          outputPreview: firstMeaningfulLine(
            typeof resultObject.output === "string" ? resultObject.output : "",
          ),
          errorPreview: firstMeaningfulLine(
            typeof resultObject.error === "string" ? resultObject.error : "",
          ),
        };
      case "Write":
      case "system.writeFile":
      case "system.appendFile":
      case "NotebookEdit": {
        const filePathValue = resultObject.path ?? resultObject.file_path ?? payloadPath(payload);
        return {
          kind: "file-write-result",
          isError,
          action: toolName === "system.appendFile" ? "append" : "write",
          isPlanFile: isPlanFilePath(filePathValue),
          filePathDisplay: compactPathForDisplay(filePathValue),
          filePathRaw: rawDisplayPath(filePathValue),
          bytesWrittenText: formatBytes(resultObject.bytesWritten ?? resultObject.size),
          content: payloadContent(payload),
        };
      }
      case "Edit":
      case "MultiEdit":
      case "system.replaceInFile":
      case "system.editFile": {
        const filePathValue = resultObject.path ?? resultObject.file_path ?? payloadPath(payload);
        const errorText =
          firstString(resultObject.error, resultObject.message, isError ? resultText : null);
        const oldText = payloadOldText(payload);
        return {
          kind: "file-edit-result",
          isError,
          operation: oldText === "" ? "create" : "replace",
          isPlanFile: isPlanFilePath(filePathValue),
          filePathDisplay: compactPathForDisplay(filePathValue),
          filePathRaw: rawDisplayPath(filePathValue),
          oldText: oldText && oldText.length > 0 ? oldText : null,
          newText: payloadNewText(payload),
          replaceAll: payload.replace_all === true,
          replacements:
            typeof resultObject.replacements === "number" && Number.isFinite(resultObject.replacements)
              ? resultObject.replacements
              : null,
          bytesWrittenText: formatBytes(resultObject.bytesWritten ?? resultObject.size),
          errorText,
          errorPreview: isError ? firstMeaningfulLine(errorText ?? resultText) : null,
        };
      }
      case "FileRead":
      case "Read":
      case "system.readFile":
      case "system.readFileRange": {
        const filePathValue = resultObject.path
          ?? resultObject.file_path
          ?? resultObject.filePath
          ?? payloadPath(payload);
        const lineCount = countResultLines(resultObject, resultText);
        const errorText =
          firstString(resultObject.error, resultObject.message, isError ? resultText : null);
        return {
          kind: "file-read-result",
          isError,
          isPlanFile: isPlanFilePath(filePathValue),
          filePathDisplay: compactPathForDisplay(filePathValue),
          filePathRaw: rawDisplayPath(filePathValue),
          fileRange: lineRangeFromPayload(payload),
          sizeText: formatBytes(resultObject.size ?? resultObject.bytes),
          lineCount,
          content:
            firstString(resultObject.content, resultObject.output, !isError ? resultText : null),
          errorText,
          errorPreview: isError ? firstMeaningfulLine(errorText ?? resultText) : null,
        };
      }
      case "Grep":
      case "Glob":
      case "system.grep":
      case "system.glob":
      case "system.searchFiles": {
        const counts = summarizeSearchCounts(resultObject, resultText);
        return {
          kind: "search-result",
          isError,
          toolName,
          searchKind: toolName === "Glob" || toolName === "system.glob" ? "glob" : "grep",
          pattern: sanitizeInlineText(payload.pattern ?? payload.query ?? payload.glob ?? ""),
          pathDisplay: compactPathForDisplay(payload.path ?? payload.dir ?? payload.directory),
          glob: sanitizeInlineText(payload.glob ?? ""),
          outputMode: sanitizeInlineText(payload.output_mode ?? payload.outputMode ?? ""),
          fileCount: counts.fileCount,
          matchCount: counts.matchCount,
          lineCount: counts.lineCount,
          outputPreview: firstMeaningfulLine(resultText),
          errorText: firstString(resultObject.error, resultObject.message, isError ? resultText : null),
        };
      }
      case "TodoWrite":
        return {
          kind: "todo-result",
          isError,
          total: Array.isArray(payload.todos) ? payload.todos.length : 0,
          completed: Array.isArray(payload.todos)
            ? payload.todos.filter((todo) => todo?.status === "completed").length
            : 0,
          inProgress: Array.isArray(payload.todos)
            ? payload.todos.filter((todo) => todo?.status === "in_progress").length
            : 0,
          outputPreview: firstMeaningfulLine(resultText),
        };
      case "EnterPlanMode":
        return {
          kind: "plan-mode-result",
          isError,
          declined: resultObject.declined === true || /declined|rejected/i.test(resultText),
          errorText: firstString(resultObject.error, resultObject.message, isError ? resultText : null),
        };
      case "ExitPlanMode":
        return {
          kind: "plan-exit-result",
          isError,
          approved: resultObject.approved === true || /approved/i.test(resultText),
          rejected: resultObject.rejected === true || /rejected|changes requested/i.test(resultText),
          awaitingLeaderApproval:
            resultObject.awaitingLeaderApproval === true
            || resultObject.awaitingApproval === true
            || /submitted.*approval|awaiting.*approval/i.test(resultText),
          planText: firstString(resultObject.plan, resultObject.content, payload.plan, resultText),
          filePathDisplay: compactPathForDisplay(
            resultObject.filePath ?? resultObject.file_path ?? payloadPath(payload),
          ),
          filePathRaw: rawDisplayPath(
            resultObject.filePath ?? resultObject.file_path ?? payloadPath(payload),
          ),
          errorText: firstString(resultObject.error, resultObject.message, isError ? resultText : null),
        };
      case "VerifyPlanExecution":
      case "verify_plan_execution":
        return {
          kind: "verification-result",
          isError,
          status: sanitizeInlineText(resultObject.status ?? ""),
          outputPreview: firstMeaningfulLine(resultText),
          errorText: firstString(resultObject.error, resultObject.message, isError ? resultText : null),
        };
      case "AskUserQuestion":
        return {
          kind: "question-result",
          isError,
          answerPreview: firstMeaningfulLine(
            firstString(resultObject.answer, resultObject.response, resultText) ?? "",
          ),
          errorText: firstString(resultObject.error, resultObject.message, isError ? resultText : null),
        };
      case "WebFetch":
      case "WebSearch": {
        const disabledReason = disabledExternalReason(resultObject, resultText);
        if (disabledReason) {
          return {
            kind: "external-disabled-result",
            isError,
            toolName,
            surface: toolName,
            target: sanitizeInlineText(payload.url ?? payload.query ?? payload.prompt ?? ""),
            reason: disabledReason,
          };
        }
        break;
      }
      default:
        if (isExternalSurfaceTool(toolName)) {
          const disabledReason = disabledExternalReason(resultObject, resultText);
          if (disabledReason) {
            return {
              kind: "external-disabled-result",
              isError,
              toolName,
              surface: toolName,
              target: sanitizeInlineText(payload.url ?? payload.query ?? payload.prompt ?? ""),
              reason: disabledReason,
            };
          }
        }
        break;
    }

    switch (toolName) {
      case "system.listDir":
        return {
          kind: "list-dir-result",
          isError,
          dirPathDisplay: compactPathForDisplay(payload.path ?? payload.dir ?? payload.directory),
          entries: Array.isArray(resultObject.entries)
            ? resultObject.entries
              .slice(0, 6)
              .map((entry) => (typeof entry?.name === "string" ? entry.name : null))
              .filter(Boolean)
            : [],
        };
      case "system.mkdir": {
        const dirPathValue = resultObject.path ?? payload.path ?? payload.dir ?? payload.directory;
        const errorText =
          typeof resultObject.error === "string" && resultObject.error.trim().length > 0
            ? resultObject.error
            : null;
        return {
          kind: "mkdir-result",
          isError,
          dirPathDisplay: compactPathForDisplay(dirPathValue),
          dirPathRaw:
            typeof dirPathValue === "string" && String(dirPathValue).trim().length > 0
              ? sanitizeInlineText(String(dirPathValue))
              : null,
          errorText,
          errorPreview: isError ? firstMeaningfulLine(errorText ?? tryPrettyJson(result)) : null,
        };
      }
      case "desktop.text_editor":
        return normalizeDesktopTextEditorResult(payload, resultObject, isError);
      case "Bash":
      case "system.bash":
      case "desktop.bash":
        return {
          kind: "shell-result",
          isError,
          commandText: formatShellCommand(payload.command, payload.args),
          cwdDisplay: compactPathForDisplay(payload.cwd),
          exitCode: resultObject.exitCode,
          stdoutPreview: firstMeaningfulLine(resultObject.stdout),
          stderrPreview: firstMeaningfulLine(resultObject.stderr),
        };
      default:
        return {
          kind: "generic-result",
          toolName,
          isError,
          summaryEntries: parseStructuredJson(result),
          prettyResult: tryPrettyJson(result),
        };
    }
  }

  return {
    compactPathForDisplay,
    formatShellCommand,
    normalizeToolResult,
    normalizeToolStart,
    shouldSuppressToolActivity,
    shouldSuppressToolTranscript,
  };
}
