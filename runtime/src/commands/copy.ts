/**
 * `/copy` — copy conversation text to the system clipboard.
 *
 * Produces stable plain text from `SessionState.history`, writes it through
 * AgenC's native/OSC clipboard path, and returns a compact confirmation.
 *
 * @module
 */

import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";
import {
  getClipboardPath,
  setClipboard,
  type ClipboardPath,
} from "../tui/ink/termio/osc.js";

type CopyTarget = "latest" | "all" | "assistant" | "user";

export interface CopyableMessage {
  readonly role: string;
  readonly text: string;
}

export interface CopyClipboardDeps {
  readonly getClipboardPath: () => ClipboardPath;
  readonly setClipboard: (text: string) => Promise<string>;
  readonly writeSequence: (sequence: string) => void;
}

const DEFAULT_CLIPBOARD_DEPS: CopyClipboardDeps = {
  getClipboardPath,
  setClipboard,
  writeSequence: (sequence) => {
    process.stdout.write(sequence);
  },
};

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

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function formatCopyConfirmation(
  text: string,
  path: ClipboardPath,
): string {
  const lines = lineCount(text);
  const characters = text.length === 1 ? "character" : "characters";
  const lineLabel = lines === 1 ? "line" : "lines";
  const size = `${text.length} ${characters}, ${lines} ${lineLabel}`;
  switch (path) {
    case "native":
      return `Copied to clipboard (${size}).`;
    case "tmux-buffer":
      return `Copied to tmux buffer (${size}); paste with tmux prefix + ].`;
    case "osc52":
      return `Sent to clipboard via OSC 52 (${size}); paste support depends on terminal settings.`;
  }
}

export async function copyTextToClipboard(
  text: string,
  deps: CopyClipboardDeps = DEFAULT_CLIPBOARD_DEPS,
): Promise<string> {
  const path = deps.getClipboardPath();
  const sequence = await deps.setClipboard(text);
  if (sequence.length > 0) deps.writeSequence(sequence);
  return formatCopyConfirmation(text, path);
}

export async function runCopy(
  ctx: SlashCommandContext,
  deps: CopyClipboardDeps = DEFAULT_CLIPBOARD_DEPS,
): Promise<SlashCommandResult> {
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

  const text = formatCopyExport(selected);
  return { kind: "text", text: await copyTextToClipboard(text, deps) };
}

export const copyCommand: SlashCommand = {
  name: "copy",
  description: "Copy the latest message or transcript text to the clipboard",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(() => runCopy(ctx)),
};

export default copyCommand;
