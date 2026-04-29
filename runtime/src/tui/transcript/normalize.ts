import type { TranscriptMessage } from "./MessageList.js";
import {
  readSearchListToneForShellCommand,
  readStringField,
  toolRendererTone,
} from "./tool-renderers.js";
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

function readSearchTone(
  message: TranscriptMessage,
): "read" | "search" | "list" | null {
  if (message.kind !== "tool_call") return null;
  if (message.isError === true) return null;
  const tone = toolRendererTone(message.toolName);
  if (tone === "read" || tone === "search" || tone === "list") return tone;
  if (tone !== "exec") return null;
  return readSearchListToneForShellCommand(
    message.execCommand ??
      readStringField(message.toolArgs, ["command", "cmd", "script"]),
  );
}

function isReadSearchTool(message: TranscriptMessage): boolean {
  return readSearchTone(message) !== null;
}

function toolGroupCategory(
  message: TranscriptMessage,
): "read-search" | "exec" | null {
  if (message.kind !== "tool_call") return null;
  if (isReadSearchTool(message)) return "read-search";
  return toolRendererTone(message.toolName) === "exec" ? "exec" : null;
}

function groupedToolEntry(
  entry: TranscriptMessage,
): NonNullable<TranscriptMessage["groupedTools"]>[number] {
  const collapseTone = readSearchTone(entry);
  return {
    id: entry.id,
    toolName: entry.toolName ?? "Tool",
    target: toolTarget(entry) || entry.execCommand || "",
    ...(collapseTone !== null ? { collapseTone } : {}),
    content: entry.content,
    ...(entry.toolArgs !== undefined ? { toolArgs: entry.toolArgs } : {}),
    ...(entry.isError === true ? { isError: true } : {}),
    ...(entry.isComplete !== undefined ? { isComplete: entry.isComplete } : {}),
    ...(entry.toolProgressContent !== undefined
      ? { toolProgressContent: entry.toolProgressContent }
      : {}),
    ...(entry.toolResultContent !== undefined
      ? { toolResultContent: entry.toolResultContent }
      : {}),
    ...(entry.toolResultMetadata !== undefined
      ? { toolResultMetadata: entry.toolResultMetadata }
      : {}),
    ...(entry.execCommand !== undefined ? { execCommand: entry.execCommand } : {}),
    ...(entry.execStdout !== undefined ? { execStdout: entry.execStdout } : {}),
    ...(entry.execStderr !== undefined ? { execStderr: entry.execStderr } : {}),
    ...(entry.execExitCode !== undefined
      ? { execExitCode: entry.execExitCode }
      : {}),
    ...(entry.execDurationMs !== undefined
      ? { execDurationMs: entry.execDurationMs }
      : {}),
    ...(entry.execTimedOut !== undefined
      ? { execTimedOut: entry.execTimedOut }
      : {}),
    ...(entry.execTruncated !== undefined
      ? { execTruncated: entry.execTruncated }
      : {}),
    ...(entry.execCwdWasReset !== undefined
      ? { execCwdWasReset: entry.execCwdWasReset }
      : {}),
    ...(entry.execBackgroundTaskHint !== undefined
      ? { execBackgroundTaskHint: entry.execBackgroundTaskHint }
      : {}),
    ...(entry.execImagePaths !== undefined
      ? { execImagePaths: entry.execImagePaths }
      : {}),
    ...(entry.execNoOutputExpected !== undefined
      ? { execNoOutputExpected: entry.execNoOutputExpected }
      : {}),
    ...(entry.execReturnCodeInterpretation !== undefined
      ? { execReturnCodeInterpretation: entry.execReturnCodeInterpretation }
      : {}),
    ...(entry.execBackgroundTaskId !== undefined
      ? { execBackgroundTaskId: entry.execBackgroundTaskId }
      : {}),
  };
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
    const tone = readSearchTone(message);
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

function toolGroupLabel(group: readonly TranscriptMessage[]): string {
  const labels = new Map<string, { singular: string; plural: string }>([
    ["read", { singular: "read", plural: "reads" }],
    ["search", { singular: "search", plural: "searches" }],
    ["list", { singular: "list", plural: "lists" }],
    ["exec", { singular: "command", plural: "commands" }],
    ["write", { singular: "write", plural: "writes" }],
    ["edit", { singular: "edit", plural: "edits" }],
    ["agent", { singular: "agent action", plural: "agent actions" }],
    ["plan", { singular: "plan action", plural: "plan actions" }],
  ]);
  const counts = new Map<string, number>();
  let errorCount = 0;
  for (const message of group) {
    const tone = toolRendererTone(message.toolName);
    counts.set(tone, (counts.get(tone) ?? 0) + 1);
    if (message.isError === true) errorCount += 1;
  }
  const parts = Array.from(counts.entries()).map(([tone, count]) => {
    const label = labels.get(tone) ?? {
      singular: "tool",
      plural: "tools",
    };
    return `${count} ${count === 1 ? label.singular : label.plural}`;
  });
  if (errorCount > 0) {
    parts.push(`${errorCount} error${errorCount === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

function collapseToolBurstGroups(
  messages: readonly TranscriptMessage[],
): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    const category = toolGroupCategory(message);
    if (category === null) {
      out.push(message);
      index += 1;
      continue;
    }

    const group: TranscriptMessage[] = [];
    while (
      index < messages.length &&
      toolGroupCategory(messages[index]!) === category &&
      messages[index]!.turnId === message.turnId
    ) {
      group.push(messages[index]!);
      index += 1;
    }

    if (category !== "read-search" && group.length < 2) {
      out.push(...group);
      continue;
    }

    const first = group[0]!;
    out.push({
      id: `group:${category}:${group.map((entry) => entry.id).join(":")}`,
      turnId: first.turnId,
      kind: "tool_group",
      label: category,
      content: isReadSearchTool(first) && group.every(isReadSearchTool)
        ? readSearchLabel(group)
        : toolGroupLabel(group),
      timestamp: first.timestamp,
      isComplete: group.every((entry) => entry.isComplete !== false),
      groupedTools: group.map((entry) => ({
        ...groupedToolEntry(entry),
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
        collapseToolBurstGroups(collapseRepeatedEditFailures(visible)),
      ),
    ),
  );
}
