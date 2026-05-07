/**
 * `/copy` — export conversation text for copying.
 *
 * The command intentionally avoids owning platform clipboard behavior.
 * Its runtime contract is transcript export: produce stable plain text
 * from `SessionState.history` so CLI/TUI callers can render or copy it
 * without a second compatibility command path.
 *
 * @module
 */

import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

type CopyTarget = "latest" | "all" | "assistant" | "user";

export interface CopyableMessage {
  readonly role: string;
  readonly text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function stringifyContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => {
        if (!isRecord(part)) return null;
        if (part.type === "text" && typeof part.text === "string") {
          return part.text;
        }
        if (part.type === "image_url") return "[image]";
        return null;
      })
      .filter((part): part is string => part !== null && part.length > 0);
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

function messageRole(item: unknown): string | null {
  if (!isRecord(item)) return null;
  const role = item.role;
  if (typeof role !== "string") return null;
  const normalized = role.toLowerCase();
  return normalized === "user" ||
    normalized === "assistant" ||
    normalized === "tool"
    ? normalized
    : null;
}

function messageText(item: unknown): string | null {
  if (!isRecord(item)) return null;

  const directContent = stringifyContent(item.content);
  if (directContent !== null) return directContent;

  if (typeof item.text === "string") return item.text;

  const payload = item.payload;
  if (isRecord(payload)) {
    const payloadContent = stringifyContent(payload.content);
    if (payloadContent !== null) return payloadContent;
    if (typeof payload.text === "string") return payload.text;
  }

  return null;
}

export function collectCopyableMessages(
  history: ReadonlyArray<unknown>,
): CopyableMessage[] {
  const messages: CopyableMessage[] = [];
  for (const item of history) {
    const role = messageRole(item);
    const text = messageText(item);
    if (!role || text === null || text.trim().length === 0) continue;
    messages.push({ role, text });
  }
  return messages;
}

function parseTarget(argsRaw: string): CopyTarget | null {
  const first = argsRaw.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (first === "" || first === "last" || first === "latest") return "latest";
  if (first === "all" || first === "transcript") return "all";
  if (first === "assistant" || first === "assistants") return "assistant";
  if (first === "user" || first === "users") return "user";
  return null;
}

function selectMessages(
  messages: ReadonlyArray<CopyableMessage>,
  target: CopyTarget,
): CopyableMessage[] {
  switch (target) {
    case "latest": {
      const latestAssistant = messages
        .filter((message) => message.role === "assistant")
        .at(-1);
      const latest = latestAssistant ?? messages.at(-1);
      return latest ? [latest] : [];
    }
    case "all":
      return [...messages];
    case "assistant":
      return messages.filter((message) => message.role === "assistant");
    case "user":
      return messages.filter((message) => message.role === "user");
  }
}

export function formatCopyExport(
  selected: ReadonlyArray<CopyableMessage>,
): string {
  if (selected.length === 1) {
    return selected[0]!.text;
  }
  return selected
    .map((message) => `${message.role.toUpperCase()}:\n${message.text}`)
    .join("\n\n");
}

export const copyCommand: SlashCommand = {
  name: "copy",
  description: "Export the latest message or transcript text for copying",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const target = parseTarget(ctx.argsRaw);
      if (target === null) {
        return {
          kind: "error",
          message: "Usage: /copy [latest|all|assistant|user]",
        };
      }

      const state = ctx.session.state.unsafePeek() as { history?: unknown[] };
      const messages = collectCopyableMessages(state.history ?? []);
      const selected = selectMessages(messages, target);
      if (selected.length === 0) {
        return { kind: "error", message: "No copyable transcript text found." };
      }
      return { kind: "text", text: formatCopyExport(selected) };
    }),
};

export default copyCommand;
