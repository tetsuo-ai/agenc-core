/**
 * Footer-style suggestion list rendered below the composer.
 *
 * Ported from upstream. AgenC's existing `Palette` widget renders the
 * `/` `@` `$` typeahead popovers, but the footer suggestions surface
 * (file/agent/MCP-resource ghost-list) is an additive UI used by the
 * inline suggestion pipeline. The shape matches upstream so suggestion
 * sources (`commandSuggestions`, `directoryCompletion`,
 * `shellHistoryCompletion`) can produce items consumed by this
 * renderer.
 *
 * Truncation helpers (`truncatePathMiddle`, `truncateToWidth`) are
 * inlined here to avoid pulling in upstream's broader format util
 * surface.
 */
import { memo, type ReactNode } from "react";
import * as React from "react";

import { Box, Text } from "../ink-public.js";
import { stringWidth } from "../ink/stringWidth.js";
import { glyphs } from "../design-system/glyphs.js";
import type { Theme } from "../theme.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";

export interface SuggestionItem {
  readonly id: string;
  readonly displayText: string;
  readonly tag?: string;
  readonly description?: string;
  readonly metadata?: unknown;
  readonly color?: keyof Theme["colors"];
}

export type SuggestionType =
  | "command"
  | "file"
  | "directory"
  | "agent"
  | "shell"
  | "custom-title"
  | "none";

export const OVERLAY_MAX_ITEMS = 5;

const SELECTED_PREFIX = `${glyphs.pointer} `;
const UNSELECTED_PREFIX = "  ";
const PREFIX_WIDTH = stringWidth(SELECTED_PREFIX);

function getIcon(itemId: string): string {
  if (itemId.startsWith("file-")) return "+";
  if (itemId.startsWith("mcp-resource-")) return "◇";
  if (itemId.startsWith("agent-")) return "*";
  return "+";
}

function isUnifiedSuggestion(itemId: string): boolean {
  return (
    itemId.startsWith("file-") ||
    itemId.startsWith("mcp-resource-") ||
    itemId.startsWith("agent-")
  );
}

/** Truncate `text` so it occupies at most `maxWidth` terminal cells. */
function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (stringWidth(text) <= maxWidth) return text;
  // Reserve one cell for the ellipsis when there is room.
  const limit = maxWidth > 1 ? maxWidth - 1 : maxWidth;
  let acc = "";
  let width = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    if (width + w > limit) break;
    acc += ch;
    width += w;
  }
  return maxWidth > 1 ? acc + "…" : acc;
}

/**
 * Truncate a slash-delimited path so it fits within `maxWidth` cells.
 * Preserves the leading and trailing segments and replaces the middle
 * with `…/` markers.
 */
function truncatePathMiddle(path: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (stringWidth(path) <= maxWidth) return path;
  const segments = path.split("/");
  if (segments.length <= 2) {
    return truncateToWidth(path, maxWidth);
  }
  const head = segments[0] ?? "";
  const tail = segments[segments.length - 1] ?? "";
  const ellipsis = "/…/";
  const fixed = stringWidth(head) + stringWidth(ellipsis) + stringWidth(tail);
  if (fixed <= maxWidth) {
    return `${head}${ellipsis}${tail}`;
  }
  return truncateToWidth(`${head}/${tail}`, maxWidth);
}

const SuggestionItemRow = memo(function SuggestionItemRow({
  item,
  maxColumnWidth,
  isSelected,
}: {
  item: SuggestionItem;
  maxColumnWidth?: number;
  isSelected: boolean;
}): ReactNode {
  const columns = useTerminalSize().columns;
  const selectionPrefix = isSelected ? SELECTED_PREFIX : UNSELECTED_PREFIX;
  const rowBackgroundColor: keyof Theme["colors"] | undefined = isSelected
    ? "accent"
    : undefined;
  const textColor: keyof Theme["colors"] | undefined = isSelected
    ? "ink"
    : undefined;

  if (isUnifiedSuggestion(item.id)) {
    const icon = getIcon(item.id);
    const dimColor = !isSelected;
    const isFile = item.id.startsWith("file-");
    const isMcpResource = item.id.startsWith("mcp-resource-");
    const iconWidth = 2;
    const paddingWidth = 4;
    const separatorWidth = item.description ? 3 : 0;

    let displayText: string;
    if (isFile) {
      const descReserve = item.description
        ? Math.min(20, stringWidth(item.description))
        : 0;
      const maxPathLength =
        columns -
        PREFIX_WIDTH -
        iconWidth -
        paddingWidth -
        separatorWidth -
        descReserve;
      displayText = truncatePathMiddle(item.displayText, maxPathLength);
    } else if (isMcpResource) {
      displayText = truncateToWidth(item.displayText, 30);
    } else {
      displayText = item.displayText;
    }

    const availableWidth =
      columns -
      PREFIX_WIDTH -
      iconWidth -
      stringWidth(displayText) -
      separatorWidth -
      paddingWidth;

    let lineContent: string;
    if (item.description) {
      const truncatedDesc = truncateToWidth(
        item.description.replace(/\s+/g, " "),
        Math.max(0, availableWidth),
      );
      lineContent = `${selectionPrefix}${icon} ${displayText} - ${truncatedDesc}`;
    } else {
      lineContent = `${selectionPrefix}${icon} ${displayText}`;
    }

    return (
      <Box width="100%" backgroundColor={rowBackgroundColor}>
        <Text
          color={textColor}
          dimColor={dimColor}
          bold={isSelected}
          wrap="truncate"
        >
          {lineContent}
        </Text>
      </Box>
    );
  }

  const maxNameWidth = Math.floor(columns * 0.4);
  const displayTextWidth = Math.min(
    maxColumnWidth ?? stringWidth(item.displayText) + 5,
    maxNameWidth,
  );

  let displayText = item.displayText;
  if (stringWidth(displayText) > displayTextWidth - 2) {
    displayText = truncateToWidth(displayText, displayTextWidth - 2);
  }

  const paddedDisplayText =
    selectionPrefix +
    displayText +
    " ".repeat(Math.max(0, displayTextWidth - stringWidth(displayText)));
  const tagText = item.tag ? `[${item.tag}] ` : "";
  const tagWidth = stringWidth(tagText);
  const descriptionWidth = Math.max(
    0,
    columns - PREFIX_WIDTH - displayTextWidth - tagWidth - 4,
  );
  const truncatedDescription = item.description
    ? truncateToWidth(
        item.description.replace(/\s+/g, " "),
        descriptionWidth,
      )
    : "";
  const lineContent = `${paddedDisplayText}${tagText}${truncatedDescription}`;

  return (
    <Box width="100%" backgroundColor={rowBackgroundColor}>
      <Text
        color={textColor}
        dimColor={!isSelected}
        bold={isSelected}
        wrap="truncate"
      >
        {lineContent}
      </Text>
    </Box>
  );
});

interface Props {
  readonly suggestions: readonly SuggestionItem[];
  readonly selectedSuggestion: number;
  readonly maxColumnWidth?: number;
  readonly overlay?: boolean;
}

export function PromptInputFooterSuggestions({
  suggestions,
  selectedSuggestion,
  maxColumnWidth: maxColumnWidthProp,
  overlay,
}: Props): ReactNode {
  const { rows } = useTerminalSize();
  const maxVisibleItems = overlay
    ? OVERLAY_MAX_ITEMS
    : Math.min(6, Math.max(1, rows - 3));

  if (suggestions.length === 0) {
    return null;
  }

  const maxColumnWidth =
    maxColumnWidthProp ??
    Math.max(...suggestions.map((item) => stringWidth(item.displayText))) + 5;

  const startIndex = Math.max(
    0,
    Math.min(
      selectedSuggestion - Math.floor(maxVisibleItems / 2),
      suggestions.length - maxVisibleItems,
    ),
  );
  const endIndex = Math.min(startIndex + maxVisibleItems, suggestions.length);
  const visibleItems = suggestions.slice(startIndex, endIndex);

  return (
    <Box
      flexDirection="column"
      justifyContent={overlay ? undefined : "flex-end"}
    >
      {visibleItems.map((item) => (
        <SuggestionItemRow
          key={`${item.id}:${item.id === suggestions[selectedSuggestion]?.id ? "selected" : "idle"}`}
          item={item}
          maxColumnWidth={maxColumnWidth}
          isSelected={item.id === suggestions[selectedSuggestion]?.id}
        />
      ))}
    </Box>
  );
}

export default memo(PromptInputFooterSuggestions);
