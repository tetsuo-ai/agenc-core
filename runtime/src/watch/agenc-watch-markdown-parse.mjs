import markdownit from "markdown-it";
import { buildDiffDisplayLines } from "./agenc-watch-diff-render.mjs";

const MARKDOWN = markdownit({
  html: false,
  linkify: false,
  breaks: true,
  typographer: false,
});

export function createDisplayLine(text, mode = "plain", metadata = {}) {
  return {
    text: String(text ?? ""),
    plainText: String(text ?? ""),
    mode,
    ...metadata,
  };
}

export function stripTerminalControlSequences(value) {
  return String(value ?? "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    // Screen/line-erasing CSI commands must leave a newline behind —
    // otherwise `line1\x1b[2Jline2` collapses to `line1line2` and
    // transcript/tool output silently glues unrelated output
    // together. Handle the common erase/cursor-move sequences
    // explicitly before the catch-all strip.
    .replace(/\x1b\[(?:2J|H|2K|0K|1K|K|\d*;\d*H|\d*;\d*f)/g, "\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, "");
}

export function normalizeMarkdownSource(value) {
  return stripTerminalControlSequences(String(value ?? ""))
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "  ");
}

export function normalizeInlineMarkdown(value) {
  return String(value ?? "")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
      const normalizedAlt = normalizeInlineMarkdown(alt).trim();
      const normalizedUrl = String(url ?? "").trim();
      if (normalizedAlt && normalizedUrl) {
        return `image: ${normalizedAlt} (${normalizedUrl})`;
      }
      return normalizedAlt || normalizedUrl || "image";
    })
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const normalizedLabel = normalizeInlineMarkdown(label).trim();
      const normalizedUrl = String(url ?? "").trim();
      if (!normalizedUrl) {
        return normalizedLabel;
      }
      if (!normalizedLabel || normalizedLabel === normalizedUrl) {
        return normalizedUrl;
      }
      return `${normalizedLabel} (${normalizedUrl})`;
    })
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, "$1")
    // Code span: require the backticks to NOT be adjacent to another
    // backtick. `` `x`y`z` `` used to match the outer span and drop
    // the middle `y` pair because the greedy scanner left the
    // adjacent pairs orphaned. Negative lookbehind/lookahead on
    // backticks plus requiring non-empty content avoids both the
    // empty-span and chained-adjacent-backtick failure modes.
    .replace(/(?<!`)`([^`\n]+)`(?!`)/g, "'$1'")
    // Bold: require the inner content to not start or end with the
    // delimiter so `** *a*** ` doesn't over-merge.
    .replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, "$1")
    // Bold with underscores: require a non-word boundary around the
    // outer `__` so `foo__bar__baz` is left alone.
    .replace(/(^|[^A-Za-z0-9_])__(?!\s)([^_\n]+?)(?<!\s)__(?=[^A-Za-z0-9_]|$)/g, "$1$2")
    // Italic with asterisks: single `*` must not be flanked by
    // whitespace on the open side AND a word-character on the open
    // side (opposite for close).
    .replace(/(?<!\*)\*(?!\s|\*)([^*\n]+?)(?<!\s)\*(?!\*)/g, "$1")
    // Italic with underscores: same word-boundary rule as __ so
    // `foo_bar_baz.py` is preserved.
    .replace(/(^|[^A-Za-z0-9_])_(?!\s)([^_\n]+?)(?<!\s)_(?=[^A-Za-z0-9_]|$)/g, "$1$2")
    .replace(/~~(?!\s)([^~\n]+?)(?<!\s)~~/g, "$1")
    .replace(/\\([\\`*_{}\[\]()#+\-.!>])/g, "$1");
}

function normalizeInlineWhitespace(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

const TABLE_TARGET_WIDTH = 88;
const TABLE_SAFETY_MARGIN = 4;
const TABLE_MIN_COLUMN_WIDTH = 3;
const TABLE_MAX_ROW_LINES = 4;

function normalizeTableLayoutOptions(options = {}) {
  const hasExplicitTargetWidth =
    Object.prototype.hasOwnProperty.call(options, "targetWidth") ||
    Object.prototype.hasOwnProperty.call(options, "tableTargetWidth") ||
    Object.prototype.hasOwnProperty.call(options, "width");
  const rawTargetWidth = hasExplicitTargetWidth
    ? options.targetWidth ?? options.tableTargetWidth ?? options.width
    : TABLE_TARGET_WIDTH;
  const numericTargetWidth = Number(rawTargetWidth);
  const targetWidth = Number.isFinite(numericTargetWidth)
    ? Math.max(24, Math.floor(numericTargetWidth))
    : TABLE_TARGET_WIDTH;
  const fillWidth = options.fillWidth === true ||
    options.fillTables === true ||
    (hasExplicitTargetWidth && options.fillWidth !== false && options.fillTables !== false);
  const safetyMargin = hasExplicitTargetWidth ? 0 : TABLE_SAFETY_MARGIN;
  return {
    targetWidth,
    fillWidth,
    safetyMargin,
  };
}

function distributeWidthRemainder(widths, remainder) {
  const output = widths.map((width) => Math.max(TABLE_MIN_COLUMN_WIDTH, width));
  let remaining = Math.max(0, Math.floor(remainder));
  let index = 0;
  while (remaining > 0 && output.length > 0) {
    output[index % output.length] += 1;
    remaining -= 1;
    index += 1;
  }
  return output;
}

function displayWidth(value) {
  return Array.from(String(value ?? "")).length;
}

function sliceDisplay(value, start, end = Infinity) {
  return Array.from(String(value ?? "")).slice(start, end).join("");
}

function padAligned(value, targetWidth, align = "left") {
  const text = String(value ?? "");
  const padding = Math.max(0, targetWidth - displayWidth(text));
  if (align === "right") {
    return `${" ".repeat(padding)}${text}`;
  }
  if (align === "center") {
    const left = Math.floor(padding / 2);
    return `${" ".repeat(left)}${text}${" ".repeat(padding - left)}`;
  }
  return `${text}${" ".repeat(padding)}`;
}

function hardWrapWord(word, width) {
  const output = [];
  let remaining = String(word ?? "");
  while (displayWidth(remaining) > width) {
    output.push(sliceDisplay(remaining, 0, width));
    remaining = sliceDisplay(remaining, width);
  }
  if (remaining.length > 0) {
    output.push(remaining);
  }
  return output;
}

function wrapCellText(value, width, { hard = false } = {}) {
  const text = String(value ?? "")
    .trimEnd()
    .replace(/\s+/g, " ");
  if (!text) {
    return [""];
  }
  const normalizedWidth = Math.max(1, Number(width) || 1);
  const words = text.split(" ").filter((word) => word.length > 0);
  const lines = [];
  let current = "";

  for (const word of words) {
    const wordParts = hard && displayWidth(word) > normalizedWidth
      ? hardWrapWord(word, normalizedWidth)
      : [word];
    for (const part of wordParts) {
      if (!current) {
        current = part;
        continue;
      }
      const candidate = `${current} ${part}`;
      if (displayWidth(candidate) <= normalizedWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = part;
      }
    }
  }

  if (current) {
    lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

function longestWordWidth(value) {
  const words = String(value ?? "")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) {
    return TABLE_MIN_COLUMN_WIDTH;
  }
  return Math.max(TABLE_MIN_COLUMN_WIDTH, ...words.map(displayWidth));
}

function normalizeTableMatrix(headers, rows) {
  const columnCount = Math.max(
    headers.length,
    ...rows.map((row) => row.length),
    0,
  );
  return {
    columnCount,
    headers: Array.from({ length: columnCount }, (_, index) => headers[index] ?? `column ${index + 1}`),
    rows: rows.map((row) =>
      Array.from({ length: columnCount }, (_, index) => String(row[index] ?? "").trim()),
    ),
  };
}

function normalizeTableAlignments(alignments, columnCount) {
  return Array.from({ length: columnCount }, (_, index) => {
    const value = String(alignments?.[index] ?? "left").toLowerCase();
    return value === "right" || value === "center" ? value : "left";
  });
}

export function parseTableRow(rawLine) {
  if (typeof rawLine !== "string" || !rawLine.includes("|")) {
    return null;
  }
  const trimmed = rawLine.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return null;
  }
  const cells = trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => normalizeInlineMarkdown(cell).trim());
  return cells.length > 0 ? cells : null;
}

export function isTableSeparator(rawLine) {
  return /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(String(rawLine ?? ""));
}

export function parseTableAlignment(rawLine) {
  const cells = parseTableRow(rawLine);
  if (!cells) {
    return [];
  }
  return cells.map((cell) => {
    const value = String(cell ?? "").trim();
    const left = value.startsWith(":");
    const right = value.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

function buildVerticalTableDisplayLines(headers, rows, options = {}) {
  const { targetWidth } = normalizeTableLayoutOptions(options);
  const separator = "─".repeat(Math.min(targetWidth - 1, 40));
  const lines = [];
  rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) {
      lines.push(createDisplayLine(separator, "table-divider"));
    }
    headers.forEach((header, columnIndex) => {
      const label = String(header ?? `Column ${columnIndex + 1}`).trim();
      const value = String(row[columnIndex] ?? "")
        .replace(/\n+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const firstLineWidth = Math.max(10, targetWidth - displayWidth(label) - 3);
      const continuationWidth = Math.max(10, targetWidth - 3);
      const firstPass = wrapCellText(value, firstLineWidth);
      const firstLine = firstPass[0] ?? "";
      const wrapped = firstPass.length <= 1 || continuationWidth <= firstLineWidth
        ? firstPass
        : [
            firstLine,
            ...wrapCellText(
              firstPass.slice(1).map((line) => line.trim()).join(" "),
              continuationWidth,
            ),
          ];
      lines.push(createDisplayLine(`${label}: ${wrapped[0] ?? ""}`, "table-row"));
      for (const continuation of wrapped.slice(1)) {
        if (continuation.trim()) {
          lines.push(createDisplayLine(`  ${continuation}`, "table-row"));
        }
      }
    });
  });
  return lines;
}

export function buildTableDisplayLines(headers, rows, alignments = [], options = {}) {
  const { targetWidth, fillWidth, safetyMargin } = normalizeTableLayoutOptions(options);
  const normalized = normalizeTableMatrix(headers, rows);
  const columnCount = normalized.columnCount;
  const align = normalizeTableAlignments(alignments, columnCount);
  const matrix = [normalized.headers, ...normalized.rows];
  const minWidths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(...matrix.map((row) => longestWordWidth(row[index]))),
  );
  const idealWidths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(TABLE_MIN_COLUMN_WIDTH, ...matrix.map((row) => displayWidth(row[index]))),
  );
  const borderOverhead = 1 + columnCount * 3;
  const availableWidth = Math.max(
    targetWidth - borderOverhead - safetyMargin,
    columnCount * TABLE_MIN_COLUMN_WIDTH,
  );
  const totalMin = minWidths.reduce((sum, width) => sum + width, 0);
  const totalIdeal = idealWidths.reduce((sum, width) => sum + width, 0);
  let needsHardWrap = false;
  let columnWidths;

  if (totalIdeal <= availableWidth) {
    columnWidths = idealWidths;
    if (fillWidth) {
      columnWidths = distributeWidthRemainder(
        columnWidths,
        availableWidth - columnWidths.reduce((sum, width) => sum + width, 0),
      );
    }
  } else if (totalMin <= availableWidth) {
    const extraSpace = availableWidth - totalMin;
    const overflows = idealWidths.map((ideal, index) => ideal - minWidths[index]);
    const totalOverflow = overflows.reduce((sum, overflow) => sum + overflow, 0);
    columnWidths = minWidths.map((minWidth, index) => {
      if (totalOverflow === 0) {
        return minWidth;
      }
      return minWidth + Math.floor((overflows[index] / totalOverflow) * extraSpace);
    });
    if (fillWidth) {
      columnWidths = distributeWidthRemainder(
        columnWidths,
        availableWidth - columnWidths.reduce((sum, width) => sum + width, 0),
      );
    }
  } else {
    needsHardWrap = true;
    const scaleFactor = availableWidth / totalMin;
    columnWidths = minWidths.map((width) =>
      Math.max(Math.floor(width * scaleFactor), TABLE_MIN_COLUMN_WIDTH),
    );
    if (fillWidth) {
      columnWidths = distributeWidthRemainder(
        columnWidths,
        availableWidth - columnWidths.reduce((sum, width) => sum + width, 0),
      );
    }
  }

  const wrappedRows = matrix.map((row) =>
    row.map((cell, index) =>
      wrapCellText(cell, columnWidths[index], { hard: needsHardWrap })
    ),
  );
  const maxRowLines = Math.max(1, ...wrappedRows.flatMap((row) => row.map((cellLines) => cellLines.length)));
  if (maxRowLines > TABLE_MAX_ROW_LINES) {
    return buildVerticalTableDisplayLines(normalized.headers, normalized.rows, options);
  }

  const renderBorderLine = (type) => {
    const [left, mid, cross, right] = {
      top: ["┌", "─", "┬", "┐"],
      middle: ["├", "─", "┼", "┤"],
      bottom: ["└", "─", "┴", "┘"],
    }[type];
    return `${left}${columnWidths
      .map((width) => mid.repeat(width + 2))
      .join(cross)}${right}`;
  };
  const renderRowLines = (row, isHeader) => {
    const cellLines = row.map((cell, index) =>
      wrapCellText(cell, columnWidths[index], { hard: needsHardWrap })
    );
    const rowHeight = Math.max(1, ...cellLines.map((lines) => lines.length));
    const offsets = cellLines.map((lines) => Math.floor((rowHeight - lines.length) / 2));
    const output = [];
    for (let lineIndex = 0; lineIndex < rowHeight; lineIndex += 1) {
      let line = "│";
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        const localIndex = lineIndex - offsets[columnIndex];
        const cellLine = localIndex >= 0 && localIndex < cellLines[columnIndex].length
          ? cellLines[columnIndex][localIndex]
          : "";
        line += ` ${padAligned(
          cellLine,
          columnWidths[columnIndex],
          isHeader ? "center" : align[columnIndex],
        )} │`;
      }
      output.push(line);
    }
    return output;
  };

  const lines = [
    createDisplayLine(renderBorderLine("top"), "table-divider"),
    ...renderRowLines(normalized.headers, true).map((line) =>
      createDisplayLine(line, "table-header")
    ),
    createDisplayLine(renderBorderLine("middle"), "table-divider"),
  ];
  normalized.rows.forEach((row, rowIndex) => {
    lines.push(
      ...renderRowLines(row, false).map((line) => createDisplayLine(line, "table-row")),
    );
    if (rowIndex < normalized.rows.length - 1) {
      lines.push(createDisplayLine(renderBorderLine("middle"), "table-divider"));
    }
  });
  lines.push(createDisplayLine(renderBorderLine("bottom"), "table-divider"));
  return lines;
}

export function normalizeDisplayLineCollection(lines) {
  const normalized = [];
  let blankRun = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    const entry =
      typeof line === "string"
        ? createDisplayLine(line, "plain")
        : line && typeof line === "object"
          ? line
          : createDisplayLine("", "blank");
    if (entry.mode === "blank" || String(entry.text ?? "").trim().length === 0) {
      blankRun += 1;
      if (blankRun > 1) {
        continue;
      }
      normalized.push(createDisplayLine("", "blank"));
      continue;
    }
    blankRun = 0;
    normalized.push(entry);
  }
  return normalized.length > 0 ? normalized : [createDisplayLine("(empty)", "paragraph")];
}

function attributeValue(token, name) {
  if (token && typeof token.attrGet === "function") {
    return token.attrGet(name);
  }
  if (!Array.isArray(token?.attrs)) {
    return null;
  }
  const pair = token.attrs.find((entry) => entry?.[0] === name);
  return pair?.[1] ?? null;
}

function formatLinkDisplay(label, destination) {
  const normalizedLabel = normalizeInlineWhitespace(label);
  const normalizedDestination = String(destination ?? "").trim();
  if (!normalizedDestination) {
    return normalizedLabel;
  }
  if (!normalizedLabel || normalizedLabel === normalizedDestination) {
    return normalizedDestination;
  }
  return `${normalizedLabel} (${normalizedDestination})`;
}

function formatImageDisplay(altText, destination) {
  const normalizedAlt = normalizeInlineWhitespace(altText);
  const normalizedDestination = String(destination ?? "").trim();
  if (normalizedAlt && normalizedDestination) {
    return `image: ${normalizedAlt} (${normalizedDestination})`;
  }
  return normalizedAlt || normalizedDestination || "image";
}

function renderInlineTokens(tokens = [], stopTypes = new Set(), startIndex = 0) {
  let output = "";
  let index = startIndex;
  while (index < tokens.length) {
    const token = tokens[index];
    if (stopTypes.has(token?.type)) {
      return {
        text: output,
        nextIndex: index + 1,
      };
    }
    switch (token?.type) {
      case "text":
        output += normalizeInlineMarkdown(token.content);
        index += 1;
        break;
      case "softbreak":
      case "hardbreak":
        output += "\n";
        index += 1;
        break;
      case "code_inline":
        output += `'${token.content ?? ""}'`;
        index += 1;
        break;
      case "image": {
        const alt = renderInlineTokens(token.children ?? []).text;
        output += formatImageDisplay(alt, attributeValue(token, "src"));
        index += 1;
        break;
      }
      case "link_open": {
        const link = renderInlineTokens(tokens, new Set(["link_close"]), index + 1);
        output += formatLinkDisplay(link.text, attributeValue(token, "href"));
        index = link.nextIndex;
        break;
      }
      case "em_open": {
        const emphasis = renderInlineTokens(tokens, new Set(["em_close"]), index + 1);
        output += emphasis.text;
        index = emphasis.nextIndex;
        break;
      }
      case "strong_open": {
        const strong = renderInlineTokens(tokens, new Set(["strong_close"]), index + 1);
        output += strong.text;
        index = strong.nextIndex;
        break;
      }
      case "s_open": {
        const strike = renderInlineTokens(tokens, new Set(["s_close"]), index + 1);
        output += strike.text;
        index = strike.nextIndex;
        break;
      }
      case "html_inline":
        output += normalizeInlineMarkdown(token.content);
        index += 1;
        break;
      default:
        if (Array.isArray(token?.children) && token.children.length > 0) {
          output += renderInlineTokens(token.children).text;
        } else if (typeof token?.content === "string" && token.content.length > 0) {
          output += normalizeInlineMarkdown(token.content);
        }
        index += 1;
        break;
    }
  }
  return {
    text: output,
    nextIndex: index,
  };
}

function maybeInsertGapLine(lines, lastSourceEnd, map) {
  if (
    !Array.isArray(map) ||
    map.length < 2 ||
    !Number.isFinite(lastSourceEnd) ||
    map[0] <= lastSourceEnd
  ) {
    return;
  }
  const lastLine = lines.at(-1);
  if (lastLine?.mode !== "blank") {
    lines.push(createDisplayLine("", "blank"));
  }
}

function nextSourceEnd(map, fallback) {
  return Array.isArray(map) && map.length >= 2 ? map[1] : fallback;
}

function createRenderContext() {
  return {
    blockquoteDepth: 0,
    listStack: [],
    listItemStack: [],
  };
}

function openList(context, token, type) {
  const start = Number.parseInt(attributeValue(token, "start") ?? "1", 10);
  context.listStack.push({
    type,
    nextIndex: Number.isFinite(start) ? start : 1,
  });
}

function openListItem(context) {
  const activeList = context.listStack.at(-1) ?? { type: "bullet", nextIndex: 1 };
  const marker =
    activeList.type === "ordered"
      ? `${activeList.nextIndex}. `
      : "• ";
  if (activeList.type === "ordered") {
    activeList.nextIndex += 1;
  }
  context.listItemStack.push({
    indent: " ".repeat(
      Math.max(0, (context.listStack.length - 1) * 2 + context.blockquoteDepth * 2),
    ),
    marker,
    paragraphCount: 0,
  });
}

function appendStructuredTextLine(lines, text, defaultMode, map, context, lastSourceEnd) {
  // Split on embedded newlines (from softbreak/hardbreak tokens) so each
  // line renders independently instead of being collapsed into one paragraph.
  const segments = String(text ?? "").split("\n").map((s) => normalizeInlineWhitespace(s)).filter(Boolean);
  if (segments.length === 0) {
    return nextSourceEnd(map, lastSourceEnd);
  }
  maybeInsertGapLine(lines, lastSourceEnd, map);
  const activeListItem = context.listItemStack.at(-1);
  if (activeListItem) {
    const continuationPrefix = `${activeListItem.indent}${" ".repeat(activeListItem.marker.length)}`;
    for (const [segIndex, segment] of segments.entries()) {
      const prefix =
        activeListItem.paragraphCount === 0 && segIndex === 0
          ? `${activeListItem.indent}${activeListItem.marker}`
          : continuationPrefix;
      lines.push(
        createDisplayLine(`${prefix}${segment}`, "list", {
          continuationPrefix,
        }),
      );
    }
    activeListItem.paragraphCount += 1;
    return nextSourceEnd(map, lastSourceEnd);
  }
  if (context.blockquoteDepth > 0) {
    const quoteLead =
      context.blockquoteDepth > 1
        ? `${"> ".repeat(context.blockquoteDepth - 1)}`
        : "";
    for (const segment of segments) {
      lines.push(
        createDisplayLine(`${quoteLead}${segment}`, "quote", {
          continuationPrefix: `${"  ".repeat(Math.max(1, context.blockquoteDepth))}`,
        }),
      );
    }
    return nextSourceEnd(map, lastSourceEnd);
  }
  for (const segment of segments) {
    lines.push(createDisplayLine(segment, defaultMode));
  }
  return nextSourceEnd(map, lastSourceEnd);
}

function appendCodeFenceLines(lines, token, lastSourceEnd) {
  maybeInsertGapLine(lines, lastSourceEnd, token.map);
  const language =
    String(token.info ?? "")
      .trim()
      .split(/\s+/)[0] || "text";
  const content = String(token.content ?? "").replace(/\r\n/g, "\n");
  if (language === "diff" || language === "patch") {
    const diffLines = buildDiffDisplayLines({ kind: "tool", body: content });
    if (diffLines.length > 0) {
      lines.push(...diffLines);
      return nextSourceEnd(token.map, lastSourceEnd);
    }
  }

  lines.push(
    createDisplayLine(`code · ${language}`, "code-meta", {
      language,
    }),
  );
  const contentLines = content.endsWith("\n")
    ? content.slice(0, -1).split("\n")
    : content.split("\n");
  for (const line of contentLines) {
    lines.push(
      createDisplayLine(line, "code", {
        language,
      }),
    );
  }
  return nextSourceEnd(token.map, lastSourceEnd);
}

function tokenTableAlignment(token) {
  const style = String(attributeValue(token, "style") ?? "");
  const match = style.match(/text-align\s*:\s*(left|right|center)/i);
  return match?.[1]?.toLowerCase() ?? "left";
}

function consumeTable(tokens, startIndex, options = {}) {
  let headers = [];
  let alignments = [];
  const rows = [];
  let currentRow = [];
  let currentCell = "";
  let currentCellAlign = "left";
  let inHeader = false;
  let index = startIndex + 1;
  while (index < tokens.length) {
    const token = tokens[index];
    switch (token?.type) {
      case "thead_open":
        inHeader = true;
        break;
      case "thead_close":
        inHeader = false;
        break;
      case "th_open":
      case "td_open":
        currentCellAlign = tokenTableAlignment(token);
        break;
      case "inline":
        currentCell = normalizeInlineWhitespace(
          renderInlineTokens(token.children ?? []).text,
        );
        break;
      case "th_close":
      case "td_close":
        currentRow.push(currentCell);
        if (inHeader) {
          alignments.push(currentCellAlign);
        }
        currentCell = "";
        currentCellAlign = "left";
        break;
      case "tr_close":
        if (currentRow.length > 0) {
          if (headers.length === 0 && (inHeader || rows.length === 0)) {
            headers = currentRow;
          } else {
            rows.push(currentRow);
          }
        }
        currentRow = [];
        break;
      case "table_close":
        return {
          nextIndex: index + 1,
          lines: headers.length > 0
            ? buildTableDisplayLines(headers, rows, alignments, options)
            : [createDisplayLine("(empty)", "paragraph")],
        };
      default:
        break;
    }
    index += 1;
  }
  return {
    nextIndex: index,
    lines: headers.length > 0
      ? buildTableDisplayLines(headers, rows, alignments, options)
      : [createDisplayLine("(empty)", "paragraph")],
  };
}

export function buildMarkdownDisplayLines(value, options = {}) {
  const source = normalizeMarkdownSource(value);
  if (source.trim().length === 0) {
    return [createDisplayLine("(empty)", "paragraph")];
  }

  const tokens = MARKDOWN.parse(source, {});
  const lines = [];
  const context = createRenderContext();
  let index = 0;
  let lastSourceEnd = null;

  while (index < tokens.length) {
    const token = tokens[index];
    switch (token?.type) {
      case "heading_open": {
        const inlineToken = tokens[index + 1];
        const level = Number.parseInt(String(token.tag ?? "h1").slice(1), 10) || 1;
        maybeInsertGapLine(lines, lastSourceEnd, token.map);
        lines.push(
          createDisplayLine(
            normalizeInlineWhitespace(
              renderInlineTokens(inlineToken?.children ?? []).text,
            ),
            "heading",
            { level },
          ),
        );
        lastSourceEnd = nextSourceEnd(token.map, lastSourceEnd);
        index += 3;
        break;
      }
      case "paragraph_open": {
        const inlineToken = tokens[index + 1];
        lastSourceEnd = appendStructuredTextLine(
          lines,
          renderInlineTokens(inlineToken?.children ?? []).text,
          "paragraph",
          token.map,
          context,
          lastSourceEnd,
        );
        index += 3;
        break;
      }
      case "blockquote_open":
        context.blockquoteDepth += 1;
        index += 1;
        break;
      case "blockquote_close":
        context.blockquoteDepth = Math.max(0, context.blockquoteDepth - 1);
        index += 1;
        break;
      case "bullet_list_open":
        openList(context, token, "bullet");
        index += 1;
        break;
      case "ordered_list_open":
        openList(context, token, "ordered");
        index += 1;
        break;
      case "bullet_list_close":
      case "ordered_list_close":
        context.listStack.pop();
        index += 1;
        break;
      case "list_item_open":
        openListItem(context);
        index += 1;
        break;
      case "list_item_close":
        context.listItemStack.pop();
        index += 1;
        break;
      case "fence":
      case "code_block":
        lastSourceEnd = appendCodeFenceLines(lines, token, lastSourceEnd);
        index += 1;
        break;
      case "hr":
        maybeInsertGapLine(lines, lastSourceEnd, token.map);
        lines.push(createDisplayLine("────────", "rule"));
        lastSourceEnd = nextSourceEnd(token.map, lastSourceEnd);
        index += 1;
        break;
      case "table_open": {
        maybeInsertGapLine(lines, lastSourceEnd, token.map);
        const table = consumeTable(tokens, index, options);
        lines.push(...table.lines);
        lastSourceEnd = nextSourceEnd(token.map, lastSourceEnd);
        index = table.nextIndex;
        break;
      }
      case "html_block": {
        maybeInsertGapLine(lines, lastSourceEnd, token.map);
        for (const rawLine of normalizeMarkdownSource(token.content).split("\n")) {
          const normalizedLine = normalizeInlineWhitespace(rawLine);
          if (!normalizedLine) {
            lines.push(createDisplayLine("", "blank"));
            continue;
          }
          lines.push(createDisplayLine(normalizedLine, "paragraph"));
        }
        lastSourceEnd = nextSourceEnd(token.map, lastSourceEnd);
        index += 1;
        break;
      }
      default:
        index += 1;
        break;
    }
  }

  return normalizeDisplayLineCollection(lines);
}
