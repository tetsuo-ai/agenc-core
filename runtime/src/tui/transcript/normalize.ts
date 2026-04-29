import type { TranscriptMessage } from "./MessageList.js";
import { readStringField, toolRendererTone } from "./tool-renderers.js";
import {
  compactRecoverableToolFailureMessage,
  isHiddenRecoverableToolFailure,
} from "../../tools/result-metadata.js";

export interface NormalizedTranscriptOptions {
  readonly verbose?: boolean;
}

function toolTarget(message: TranscriptMessage): string {
  return (
    readStringField(message.toolArgs, [
      "path",
      "file_path",
      "filePath",
      "cwd",
      "pattern",
      "query",
      "q",
      "glob",
      "url",
      "uri",
      "command",
      "cmd",
      "target",
      "id",
      "taskId",
      "agentId",
    ]) ?? ""
  );
}

function isReadSearchTool(message: TranscriptMessage): boolean {
  if (message.kind !== "tool_call") return false;
  if (message.isError === true) return false;
  const tone = toolRendererTone(message.toolName);
  return tone === "read" || tone === "search" || tone === "list";
}

function isEditFailure(message: TranscriptMessage): boolean {
  if (message.kind !== "tool_call") return false;
  if (message.isError !== true) return false;
  return toolRendererTone(message.toolName) === "edit";
}

function collapseRepeatedEditFailures(
  messages: readonly TranscriptMessage[],
): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    if (!isEditFailure(message)) {
      out.push(message);
      index += 1;
      continue;
    }

    const target = toolTarget(message);
    const group: TranscriptMessage[] = [];
    while (
      index < messages.length &&
      isEditFailure(messages[index]!) &&
      toolTarget(messages[index]!) === target
    ) {
      group.push(messages[index]!);
      index += 1;
    }

    out.push(group.at(-1) ?? message);
  }
  return out;
}

function readSearchLabel(group: readonly TranscriptMessage[]): string {
  let reads = 0;
  let searches = 0;
  let lists = 0;
  for (const message of group) {
    const tone = toolRendererTone(message.toolName);
    if (tone === "read") reads += 1;
    if (tone === "search") searches += 1;
    if (tone === "list") lists += 1;
  }
  const parts: string[] = [];
  if (reads > 0) parts.push(`${reads} read${reads === 1 ? "" : "s"}`);
  if (searches > 0) {
    parts.push(`${searches} search${searches === 1 ? "" : "es"}`);
  }
  if (lists > 0) {
    parts.push(`${lists} list${lists === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

function collapseReadSearchGroups(
  messages: readonly TranscriptMessage[],
): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    if (!isReadSearchTool(message)) {
      out.push(message);
      index += 1;
      continue;
    }

    const group: TranscriptMessage[] = [];
    while (index < messages.length && isReadSearchTool(messages[index]!)) {
      group.push(messages[index]!);
      index += 1;
    }

    if (group.length < 2) {
      out.push(...group);
      continue;
    }

    const first = group[0]!;
    out.push({
      id: `group:read-search:${group.map((entry) => entry.id).join(":")}`,
      turnId: first.turnId,
      kind: "tool_group",
      content: readSearchLabel(group),
      timestamp: first.timestamp,
      isComplete: group.every((entry) => entry.isComplete !== false),
      groupedTools: group.map((entry) => ({
        id: entry.id,
        toolName: entry.toolName ?? "Tool",
        target: toolTarget(entry),
        isError: entry.isError === true,
      })),
    });
  }
  return out;
}

function isHookSummary(message: TranscriptMessage): boolean {
  if (message.kind !== "meta" && message.kind !== "warning") return false;
  const label = message.label?.toLowerCase() ?? "";
  const content = message.content.toLowerCase();
  return label.includes("hook") || /\bhook[_ -]/u.test(content);
}

function isCompactBoundaryRow(message: TranscriptMessage): boolean {
  if (message.kind !== "meta") return false;
  return message.label?.toLowerCase() === "compact";
}

function collapseHookSummaries(
  messages: readonly TranscriptMessage[],
): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    if (!isHookSummary(message)) {
      out.push(message);
      index += 1;
      continue;
    }

    const group: TranscriptMessage[] = [];
    while (index < messages.length && isHookSummary(messages[index]!)) {
      group.push(messages[index]!);
      index += 1;
    }

    if (group.length < 2) {
      out.push(...group);
      continue;
    }

    const first = group[0]!;
    const errored = group.some((entry) => entry.kind === "warning");
    out.push({
      id: `group:hooks:${group.map((entry) => entry.id).join(":")}`,
      turnId: first.turnId,
      kind: errored ? "warning" : "meta",
      label: "hooks",
      content: `${group.length} hook events`,
      timestamp: first.timestamp,
      isError: errored,
    });
  }
  return out;
}

function isBackgroundShellNotification(message: TranscriptMessage): boolean {
  if (message.kind !== "activity" && message.kind !== "tool_call") return false;
  const label = message.label?.toLowerCase() ?? "";
  const name = message.toolName?.toLowerCase() ?? "";
  const content = message.content.toLowerCase();
  return (
    name === "monitor" ||
    name === "taskoutput" ||
    label.includes("background") ||
    label.includes("monitor") ||
    content.includes("background")
  );
}

function collapseBackgroundShellNotifications(
  messages: readonly TranscriptMessage[],
): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    if (!isBackgroundShellNotification(message)) {
      out.push(message);
      index += 1;
      continue;
    }

    const group: TranscriptMessage[] = [];
    while (
      index < messages.length &&
      isBackgroundShellNotification(messages[index]!)
    ) {
      group.push(messages[index]!);
      index += 1;
    }

    if (group.length < 2) {
      out.push(...group);
      continue;
    }

    const first = group[0]!;
    out.push({
      id: `group:background:${group.map((entry) => entry.id).join(":")}`,
      turnId: first.turnId,
      kind: "meta",
      label: "background",
      content: `${group.length} background updates`,
      timestamp: first.timestamp,
    });
  }
  return out;
}

function isTeammateShutdown(message: TranscriptMessage): boolean {
  if (message.kind !== "meta" && message.kind !== "warning") return false;
  const content = message.content.toLowerCase();
  return (
    /\b(teammate|agent|subagent|team)\b/u.test(content) &&
    /\b(shutdown|stopped|finished|completed|exited)\b/u.test(content)
  );
}

function collapseTeammateShutdowns(
  messages: readonly TranscriptMessage[],
): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    if (!isTeammateShutdown(message)) {
      out.push(message);
      index += 1;
      continue;
    }

    const group: TranscriptMessage[] = [];
    while (index < messages.length && isTeammateShutdown(messages[index]!)) {
      group.push(messages[index]!);
      index += 1;
    }

    if (group.length < 2) {
      out.push(...group);
      continue;
    }

    const first = group[0]!;
    out.push({
      id: `group:teammates:${group.map((entry) => entry.id).join(":")}`,
      turnId: first.turnId,
      kind: "meta",
      label: "teammates",
      content: `${group.length} teammate updates`,
      timestamp: first.timestamp,
    });
  }
  return out;
}

export function normalizeTranscriptMessages(
  messages: readonly TranscriptMessage[],
  options: NormalizedTranscriptOptions = {},
): TranscriptMessage[] {
  if (options.verbose === true) {
    return messages.map((message) => {
      const compact = compactRecoverableToolFailureMessage(
        message.toolResultMetadata,
      );
      if (compact === null) return message;
      const {
        execCommand: _execCommand,
        execStdout: _execStdout,
        execStderr: _execStderr,
        execExitCode: _execExitCode,
        execDurationMs: _execDurationMs,
        execTimedOut: _execTimedOut,
        toolArgs: _toolArgs,
        ...rest
      } = message;
      void _execCommand;
      void _execStdout;
      void _execStderr;
      void _execExitCode;
      void _execDurationMs;
      void _execTimedOut;
      void _toolArgs;
      return {
        ...rest,
        content: compact,
        toolResultContent: compact,
      };
    });
  }
  const visible = messages.filter(
    (message) =>
      !isHiddenRecoverableToolFailure(message.toolResultMetadata) &&
      !isCompactBoundaryRow(message),
  );
  return collapseTeammateShutdowns(
    collapseBackgroundShellNotifications(
      collapseHookSummaries(
        collapseReadSearchGroups(collapseRepeatedEditFailures(visible)),
      ),
    ),
  );
}
