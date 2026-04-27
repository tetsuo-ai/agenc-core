import type { TranscriptMessage } from "./MessageList.js";
import { readStringField, toolRendererTone } from "./tool-renderers.js";

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
  return tone === "read" || tone === "search";
}

function readSearchLabel(group: readonly TranscriptMessage[]): string {
  let reads = 0;
  let searches = 0;
  for (const message of group) {
    const tone = toolRendererTone(message.toolName);
    if (tone === "read") reads += 1;
    if (tone === "search") searches += 1;
  }
  const parts: string[] = [];
  if (reads > 0) parts.push(`${reads} read${reads === 1 ? "" : "s"}`);
  if (searches > 0) {
    parts.push(`${searches} search${searches === 1 ? "" : "es"}`);
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
  if (options.verbose === true) return [...messages];
  return collapseTeammateShutdowns(
    collapseBackgroundShellNotifications(
      collapseHookSummaries(collapseReadSearchGroups(messages)),
    ),
  );
}
