import type { InputEvent } from "../ink/events/input-event.js";

export interface LineBounds {
  readonly cursor: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

export interface SlashDraft {
  readonly query: string;
  readonly replaceStart: number;
  readonly replaceEnd: number;
  readonly cursorInsideToken: boolean;
}

export interface MentionDraft {
  readonly query: string;
  readonly replaceStart: number;
  readonly replaceEnd: number;
  readonly cursorInsideToken: boolean;
}

export function isSingleAsciiPrintable(text: string): boolean {
  return text.length === 1 && text.charCodeAt(0) <= 0x7f;
}

export function getLineBounds(value: string, cursor: number): LineBounds {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const prevNewline = value.lastIndexOf("\n", Math.max(0, safeCursor - 1));
  const lineStart = prevNewline === -1 ? 0 : prevNewline + 1;
  const nextNewline = value.indexOf("\n", safeCursor);
  const lineEnd = nextNewline === -1 ? value.length : nextNewline;
  return { cursor: safeCursor, lineStart, lineEnd };
}

export function readSlashDraft(
  value: string,
  cursor: number,
): SlashDraft | null {
  const bounds = getLineBounds(value, cursor);
  const line = value.slice(bounds.lineStart, bounds.lineEnd);
  const leadingWhitespace = line.match(/^\s*/)?.[0].length ?? 0;
  if ((line[leadingWhitespace] ?? "") !== "/") return null;

  const replaceStart = bounds.lineStart + leadingWhitespace;
  let replaceEnd = replaceStart;
  while (replaceEnd < value.length) {
    const next = value[replaceEnd];
    if (next === undefined || next === "\n" || /\s/.test(next)) break;
    replaceEnd += 1;
  }

  return {
    query: value.slice(replaceStart + 1, replaceEnd),
    replaceStart,
    replaceEnd,
    cursorInsideToken:
      bounds.cursor >= replaceStart + 1 && bounds.cursor <= replaceEnd,
  };
}

function readPrefixedDraft(
  value: string,
  cursor: number,
  prefix: "@" | "$",
): MentionDraft | null {
  const bounds = getLineBounds(value, cursor);
  let replaceStart = bounds.cursor;
  while (replaceStart > bounds.lineStart) {
    const previous = value[replaceStart - 1];
    if (previous === undefined || /\s/.test(previous)) break;
    replaceStart -= 1;
  }

  if (value[replaceStart] !== prefix) return null;

  let replaceEnd = replaceStart;
  while (replaceEnd < bounds.lineEnd) {
    const next = value[replaceEnd];
    if (next === undefined || /\s/.test(next)) break;
    replaceEnd += 1;
  }

  return {
    query: value.slice(replaceStart + 1, replaceEnd),
    replaceStart,
    replaceEnd,
    cursorInsideToken:
      bounds.cursor >= replaceStart + 1 && bounds.cursor <= replaceEnd,
  };
}

export function readMentionDraft(
  value: string,
  cursor: number,
): MentionDraft | null {
  return readPrefixedDraft(value, cursor, "@");
}

export function readSkillMentionDraft(
  value: string,
  cursor: number,
): MentionDraft | null {
  return readPrefixedDraft(value, cursor, "$");
}

export function hasSlashMultilineConflict(value: string): boolean {
  const lines = value.split("\n");
  if (lines.length <= 1) return false;
  const first = lines[0]?.trimStart() ?? "";
  if (!first.startsWith("/")) return false;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim().length > 0) return true;
  }
  return false;
}

export function isPrintableInputEvent(event: InputEvent): boolean {
  if (typeof event.input !== "string" || event.input.length === 0) return false;
  if (event.key.return || event.key.escape || event.key.tab) return false;
  if (
    event.key.upArrow ||
    event.key.downArrow ||
    event.key.leftArrow ||
    event.key.rightArrow ||
    event.key.home ||
    event.key.end ||
    event.key.backspace ||
    event.key.delete
  ) {
    return false;
  }
  if (event.key.ctrl || event.key.super) return false;
  return true;
}
