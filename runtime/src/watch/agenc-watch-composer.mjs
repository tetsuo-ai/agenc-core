import { searchWorkspaceFileIndex } from "./agenc-watch-workspace-index.mjs";
import { matchModelNames } from "./agenc-watch-helpers.mjs";

const TOKEN_BOUNDARY_RE = /[\s([<{,;"']/;
const TOKEN_TERMINATOR_RE = /[\s)\]}>,;"']/;
const LINE_BREAK_RE = /\r\n|\n|\r/g;

function clampCursor(input, cursor) {
  const value = String(input ?? "");
  const normalizedCursor = Number.isFinite(Number(cursor)) ? Number(cursor) : value.length;
  return Math.max(0, Math.min(value.length, normalizedCursor));
}

function normalizeComposerPastedRanges(state, inputLength = currentComposerInput(state).length) {
  const ranges = Array.isArray(state?.composerPastedRanges)
    ? state.composerPastedRanges
        .filter((range) =>
          range &&
          Number.isInteger(range.start) &&
          Number.isInteger(range.end) &&
          typeof range.summary === "string" &&
          range.summary.length > 0 &&
          range.start >= 0 &&
          range.end > range.start &&
          range.end <= inputLength,
        )
        .sort((left, right) => left.start - right.start)
    : [];
  state.composerPastedRanges = ranges;
  return ranges;
}

function clearComposerPastedRanges(state, { resetSequence = false } = {}) {
  state.composerPastedRanges = [];
  if (resetSequence) {
    state.composerPasteSequence = 0;
  }
}

function findComposerPastedRangeAtCursor(
  ranges,
  cursor,
  { includeStart = false, includeEnd = false } = {},
) {
  return (
    ranges.find((range) => {
      const startsBeforeCursor = includeStart
        ? cursor >= range.start
        : cursor > range.start;
      const endsAfterCursor = includeEnd
        ? cursor <= range.end
        : cursor < range.end;
      return startsBeforeCursor && endsAfterCursor;
    }) ?? null
  );
}

function deleteComposerRange(
  state,
  start,
  end,
  { nextCursor = start } = {},
) {
  const input = currentComposerInput(state);
  const clampedStart = clampCursor(input, start);
  const clampedEnd = clampCursor(input, end);
  if (clampedEnd <= clampedStart) {
    return false;
  }

  const nextValue = input.slice(0, clampedStart) + input.slice(clampedEnd);
  const deletedLength = clampedEnd - clampedStart;
  const nextRanges = [];
  for (const range of normalizeComposerPastedRanges(state, input.length)) {
    if (range.end <= clampedStart) {
      nextRanges.push(range);
      continue;
    }
    if (range.start >= clampedEnd) {
      nextRanges.push({
        ...range,
        start: range.start - deletedLength,
        end: range.end - deletedLength,
      });
    }
  }

  state.composerInput = nextValue;
  state.composerCursor = clampCursor(nextValue, nextCursor);
  state.composerHistoryIndex = -1;
  state.composerPastedRanges = nextRanges;
  return true;
}

function countTextLines(value) {
  if (!value) return 1;
  return String(value).split(LINE_BREAK_RE).length;
}

function createComposerPasteSummary(pasteId, text) {
  const lineCount = countTextLines(text);
  if (lineCount > 1) {
    return `[Pasted text #${pasteId} +${lineCount - 1} lines]`;
  }
  return `[Pasted text #${pasteId}]`;
}

function mapComposerDisplayValue({ input, cursor, pastedRanges }) {
  const value = String(input ?? "");
  const clampedCursor = clampCursor(value, cursor);
  const ranges = Array.isArray(pastedRanges)
    ? pastedRanges
    : [];
  if (ranges.length === 0) {
    return {
      displayInput: value,
      displayCursor: clampedCursor,
    };
  }

  let displayInput = "";
  let rawIndex = 0;
  let displayCursor = null;

  for (const range of ranges) {
    const prefix = value.slice(rawIndex, range.start);
    displayInput += prefix;
    if (displayCursor === null && clampedCursor <= range.start) {
      displayCursor = displayInput.length - (range.start - clampedCursor);
    }
    displayInput += range.summary;
    if (displayCursor === null && clampedCursor <= range.end) {
      displayCursor = displayInput.length;
    }
    rawIndex = range.end;
  }

  displayInput += value.slice(rawIndex);
  if (displayCursor === null) {
    displayCursor = displayInput.length - (value.length - clampedCursor);
  }

  return {
    displayInput,
    displayCursor,
  };
}

function sliceActiveToken(input, cursor) {
  const value = String(input ?? "");
  const clampedCursor = clampCursor(value, cursor);
  let start = clampedCursor;
  while (start > 0 && !TOKEN_BOUNDARY_RE.test(value[start - 1])) {
    start -= 1;
  }
  let end = clampedCursor;
  while (end < value.length && !TOKEN_TERMINATOR_RE.test(value[end])) {
    end += 1;
  }
  return {
    value,
    cursor: clampedCursor,
    start,
    end,
    token: value.slice(start, end),
  };
}

function normalizeCompletionBoundary(value) {
  return typeof value === "string" && value.trimStart().startsWith("/");
}

function shouldAddTrailingSpace(value, end) {
  if (end >= value.length) {
    return true;
  }
  return /\s/.test(value[end]);
}

function applyTokenReplacement(input, { start, end }, replacement) {
  const value = String(input ?? "");
  let next = `${value.slice(0, start)}${replacement}${value.slice(end)}`;
  let cursor = start + replacement.length;
  if (shouldAddTrailingSpace(value, end)) {
    next = `${next.slice(0, cursor)} ${next.slice(cursor)}`;
    cursor += 1;
  }
  return {
    input: next,
    cursor,
  };
}

function completeSlashToken(input, commandName) {
  const value = String(input ?? "");
  const trimmed = value.trimStart();
  const [commandToken = "/"] = trimmed.split(/\s+/, 1);
  const remainder = trimmed.slice(commandToken.length);
  const leadingWhitespace = value.match(/^\s*/)?.[0] ?? "";
  const completed = `${leadingWhitespace}${commandName}${remainder}`;
  return {
    input: completed,
    cursor: completed.length,
  };
}

export function currentComposerInput(state) {
  return String(state?.composerInput ?? "");
}

export function isSlashComposerInput(input) {
  return normalizeCompletionBoundary(input);
}

export function resetComposerState(state) {
  state.composerInput = "";
  state.composerCursor = 0;
  state.composerHistoryIndex = -1;
  state.composerHistoryDraft = "";
  clearComposerPastedRanges(state, { resetSequence: true });
}

export function setComposerInputValue(state, nextValue) {
  state.composerInput = String(nextValue ?? "");
  state.composerCursor = clampCursor(state.composerInput, state.composerCursor);
  clearComposerPastedRanges(state);
}

export function insertComposerText(state, text, { markPasted = false } = {}) {
  if (!text) {
    return;
  }
  const value = currentComposerInput(state);
  const cursor = clampCursor(value, state.composerCursor);
  const nextValue =
    value.slice(0, cursor) +
    text +
    value.slice(cursor);
  const nextRanges = [];
  for (const range of normalizeComposerPastedRanges(state, value.length)) {
    if (cursor <= range.start) {
      nextRanges.push({
        ...range,
        start: range.start + text.length,
        end: range.end + text.length,
      });
      continue;
    }
    if (cursor >= range.end) {
      nextRanges.push(range);
      continue;
    }
  }
  state.composerInput =
    nextValue;
  state.composerCursor = cursor + text.length;
  if (markPasted) {
    const pasteId = Number.isInteger(state.composerPasteSequence)
      ? state.composerPasteSequence + 1
      : 1;
    state.composerPasteSequence = pasteId;
    nextRanges.push({
      id: pasteId,
      start: cursor,
      end: cursor + text.length,
      summary: createComposerPasteSummary(pasteId, text),
    });
    nextRanges.sort((left, right) => left.start - right.start);
  }
  state.composerPastedRanges = nextRanges;
}

export function moveComposerCursorByCharacter(state, direction) {
  const input = currentComposerInput(state);
  const cursor = clampCursor(input, state.composerCursor);
  const ranges = normalizeComposerPastedRanges(state, input.length);
  if (direction < 0) {
    if (cursor === 0) {
      return;
    }
    const activeRange = findComposerPastedRangeAtCursor(ranges, cursor, {
      includeEnd: true,
    });
    state.composerCursor = activeRange ? activeRange.start : cursor - 1;
    return;
  }

  if (cursor >= input.length) {
    return;
  }
  const activeRange = findComposerPastedRangeAtCursor(ranges, cursor, {
    includeStart: true,
  });
  state.composerCursor = activeRange ? activeRange.end : cursor + 1;
}

export function moveComposerCursorByWord(state, direction) {
  const input = currentComposerInput(state);
  const cursor = clampCursor(input, state.composerCursor);
  const ranges = normalizeComposerPastedRanges(state, input.length);
  if (direction < 0) {
    const activeRange = findComposerPastedRangeAtCursor(ranges, cursor, {
      includeEnd: true,
    });
    if (activeRange) {
      state.composerCursor = activeRange.start;
      return;
    }
    let next = cursor;
    while (next > 0 && /\s/.test(input[next - 1])) {
      next -= 1;
    }
    while (next > 0 && !/\s/.test(input[next - 1])) {
      next -= 1;
    }
    state.composerCursor = next;
    return;
  }

  const activeRange = findComposerPastedRangeAtCursor(ranges, cursor, {
    includeStart: true,
  });
  if (activeRange) {
    state.composerCursor = activeRange.end;
    return;
  }

  let next = cursor;
  while (next < input.length && !/\s/.test(input[next])) {
    next += 1;
  }
  while (next < input.length && /\s/.test(input[next])) {
    next += 1;
  }
  state.composerCursor = next;
}

export function deleteComposerToLineEnd(state) {
  const input = currentComposerInput(state);
  const cursor = clampCursor(input, state.composerCursor);
  if (cursor >= input.length) {
    return;
  }
  state.composerInput = input.slice(0, cursor);
  state.composerHistoryIndex = -1;
  clearComposerPastedRanges(state);
}

export function deleteComposerBackward(state) {
  const input = currentComposerInput(state);
  const cursor = clampCursor(input, state.composerCursor);
  if (cursor === 0) {
    return false;
  }
  const ranges = normalizeComposerPastedRanges(state, input.length);
  const activeRange = findComposerPastedRangeAtCursor(ranges, cursor, {
    includeEnd: true,
  });
  if (activeRange) {
    return deleteComposerRange(state, activeRange.start, activeRange.end, {
      nextCursor: activeRange.start,
    });
  }
  return deleteComposerRange(state, cursor - 1, cursor, {
    nextCursor: cursor - 1,
  });
}

export function deleteComposerForward(state) {
  const input = currentComposerInput(state);
  const cursor = clampCursor(input, state.composerCursor);
  if (cursor >= input.length) {
    return false;
  }
  const ranges = normalizeComposerPastedRanges(state, input.length);
  const activeRange = findComposerPastedRangeAtCursor(ranges, cursor, {
    includeStart: true,
  });
  if (activeRange) {
    return deleteComposerRange(state, activeRange.start, activeRange.end, {
      nextCursor: activeRange.start,
    });
  }
  return deleteComposerRange(state, cursor, cursor + 1, {
    nextCursor: cursor,
  });
}

export function navigateComposerHistory(state, direction) {
  const history = Array.isArray(state?.composerHistory) ? state.composerHistory : [];
  if (history.length === 0) {
    return;
  }
  if (direction < 0) {
    if (state.composerHistoryIndex === -1) {
      state.composerHistoryDraft = currentComposerInput(state);
      state.composerHistoryIndex = history.length - 1;
    } else if (state.composerHistoryIndex > 0) {
      state.composerHistoryIndex -= 1;
    }
    setComposerInputValue(state, history[state.composerHistoryIndex] ?? "");
    state.composerCursor = currentComposerInput(state).length;
    return;
  }
  if (state.composerHistoryIndex === -1) {
    return;
  }
  if (state.composerHistoryIndex < history.length - 1) {
    state.composerHistoryIndex += 1;
    setComposerInputValue(state, history[state.composerHistoryIndex] ?? "");
  } else {
    state.composerHistoryIndex = -1;
    setComposerInputValue(state, state.composerHistoryDraft);
  }
  state.composerCursor = currentComposerInput(state).length;
}

export function recordComposerHistory(state, value, { maxEntries = 200 } = {}) {
  const normalized = String(value ?? "");
  if (!normalized) {
    return;
  }
  const history = Array.isArray(state?.composerHistory) ? state.composerHistory : [];
  if (history[history.length - 1] !== normalized) {
    history.push(normalized);
    if (history.length > maxEntries) {
      state.composerHistory = history.slice(-maxEntries);
    }
  }
  state.composerHistoryIndex = -1;
  state.composerHistoryDraft = "";
}

export function autocompleteSlashComposerInput(state, matchCommands) {
  const input = currentComposerInput(state);
  if (!isSlashComposerInput(input) || typeof matchCommands !== "function") {
    return false;
  }
  const trimmed = input.trimStart();
  const parts = trimmed.split(/\s+/);
  const commandToken = parts[0] ?? "/";

  // If the command is already `/model` and there's a space after it,
  // complete the model argument instead of the command name.
  if ((commandToken === "/model" || commandToken === "/models") && trimmed.length > commandToken.length) {
    const argStart = trimmed.indexOf(commandToken) + commandToken.length;
    const argText = trimmed.slice(argStart).trimStart();
    const matches = matchModelNames(argText, { limit: 1 });
    if (matches.length === 0) return false;
    const leadingWhitespace = input.match(/^\s*/)?.[0] ?? "";
    const completed = `${leadingWhitespace}${commandToken} ${matches[0]}`;
    state.composerInput = completed;
    state.composerCursor = completed.length;
    clearComposerPastedRanges(state);
    return true;
  }

  const matches = matchCommands(commandToken, { limit: 1 });
  if (!Array.isArray(matches) || matches.length === 0) {
    return false;
  }
  const completed = completeSlashToken(input, matches[0].name);
  state.composerInput = completed.input;
  state.composerCursor = completed.cursor;
  clearComposerPastedRanges(state);
  return true;
}

export function applySlashCommandCompletion(state, commandName) {
  if (!isSlashComposerInput(currentComposerInput(state)) || !commandName) {
    return false;
  }
  const completed = completeSlashToken(currentComposerInput(state), commandName);
  state.composerInput = completed.input;
  state.composerCursor = completed.cursor;
  state.composerHistoryIndex = -1;
  clearComposerPastedRanges(state);
  return true;
}

export function applySlashModelCompletion(state, modelName) {
  const input = currentComposerInput(state);
  const trimmed = input.trimStart();
  const match = trimmed.match(/^(\/models?)\s*(.*)$/i);
  if (!match || !modelName) {
    return false;
  }
  const commandToken = match[1];
  const leadingWhitespace = input.match(/^\s*/)?.[0] ?? "";
  const completed = `${leadingWhitespace}${commandToken} ${modelName}`;
  state.composerInput = completed;
  state.composerCursor = completed.length;
  state.composerHistoryIndex = -1;
  clearComposerPastedRanges(state);
  return true;
}

export function buildComposerRenderLine({
  input,
  cursor,
  prompt,
  width,
  visibleLength,
  pastedRanges = [],
  maxWrappedLines = 4,
}) {
  const {
    displayInput: value,
    displayCursor,
  } = mapComposerDisplayValue({
    input,
    cursor,
    pastedRanges,
  });
  const promptText = String(prompt ?? "");
  const promptWidth =
    typeof visibleLength === "function" ? visibleLength(promptText) : promptText.length;
  const lineWidth = Math.max(1, Number(width));
  const firstLineAvailable = Math.max(1, lineWidth - promptWidth);
  const clampedCursor = clampCursor(value, displayCursor);

  // Short input — single line (common fast path)
  if (value.length <= firstLineAvailable) {
    return {
      line: `${promptText}${value}`,
      lines: [`${promptText}${value}`],
      cursorColumn: Math.max(1, promptWidth + clampedCursor + 1),
      cursorRow: 0,
    };
  }

  // Wrap: first line gets the prompt, continuation lines use full width.
  // Keep the cursor visible even when the composer must window the content.
  const wrappedLines = [];
  wrappedLines.push(`${promptText}${value.slice(0, firstLineAvailable)}`);
  let offset = firstLineAvailable;
  while (offset < value.length) {
    wrappedLines.push(value.slice(offset, offset + lineWidth));
    offset += lineWidth;
  }

  // Find cursor position in the wrapped lines
  let absoluteCursorRow = 0;
  let cursorCol = promptWidth + clampedCursor + 1;
  if (clampedCursor >= firstLineAvailable) {
    const remaining = clampedCursor - firstLineAvailable;
    absoluteCursorRow = Math.min(wrappedLines.length - 1, 1 + Math.floor(remaining / lineWidth));
    cursorCol = (remaining % lineWidth) + 1;
  }

  const visibleLineLimit = Number.isFinite(Number(maxWrappedLines))
    ? Math.max(1, Math.floor(Number(maxWrappedLines)))
    : wrappedLines.length;
  const windowStart = Math.max(
    0,
    Math.min(
      absoluteCursorRow,
      wrappedLines.length - visibleLineLimit,
    ),
  );
  const visibleLines = wrappedLines.slice(windowStart, windowStart + visibleLineLimit);
  const cursorRow = absoluteCursorRow - windowStart;

  return {
    line: visibleLines[0],
    lines: visibleLines,
    cursorColumn: Math.max(1, cursorCol),
    cursorRow,
  };
}

export function getActiveFileTagQuery({ input, cursor }) {
  const { token, start, end } = sliceActiveToken(input, cursor);
  if (!token.startsWith("@")) {
    return null;
  }
  return {
    start,
    end,
    token,
    query: token.slice(1),
  };
}

export function getComposerFileTagSuggestions(
  { input, cursor, fileIndex, limit = 8 } = {},
) {
  const activeTag = getActiveFileTagQuery({ input, cursor });
  if (!activeTag) {
    return [];
  }
  return searchWorkspaceFileIndex(fileIndex, activeTag.query, { limit });
}

export function autocompleteComposerFileTag(state, fileIndex, { limit = 8 } = {}) {
  const input = currentComposerInput(state);
  const activeTag = getActiveFileTagQuery({
    input,
    cursor: state?.composerCursor,
  });
  if (!activeTag) {
    return false;
  }
  const [match] = searchWorkspaceFileIndex(fileIndex, activeTag.query, { limit });
  if (!match) {
    return false;
  }
  const completed = applyTokenReplacement(
    input,
    activeTag,
    `@${match.path}`,
  );
  state.composerInput = completed.input;
  state.composerCursor = completed.cursor;
  state.composerHistoryIndex = -1;
  clearComposerPastedRanges(state);
  return true;
}

export function applyComposerFileTagSuggestion(state, suggestion) {
  const input = currentComposerInput(state);
  const activeTag = getActiveFileTagQuery({
    input,
    cursor: state?.composerCursor,
  });
  if (!activeTag || !suggestion?.path) {
    return false;
  }
  const completed = applyTokenReplacement(
    input,
    activeTag,
    `@${suggestion.path}`,
  );
  state.composerInput = completed.input;
  state.composerCursor = completed.cursor;
  state.composerHistoryIndex = -1;
  clearComposerPastedRanges(state);
  return true;
}
