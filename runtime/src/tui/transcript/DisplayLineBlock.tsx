import React from "react";

import { Ansi } from "../ink/Ansi.js";
import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import type { Color } from "../ink/styles.js";
import { theme } from "../theme.js";
import type { MarkdownDisplayLine } from "../render/markdown.js";

export interface DisplayLineBlockProps {
  readonly lines: readonly MarkdownDisplayLine[];
}

function styleForMode(
  mode: string,
): {
  readonly color?: string;
  readonly backgroundColor?: string;
  readonly bold?: boolean;
  readonly dim?: boolean;
} {
  switch (mode) {
    case "heading":
      return { color: theme.colors.primary, bold: true };
    case "quote":
    case "rule":
    case "code-meta":
    case "table-divider":
    case "diff-meta":
    case "stream-tail":
      return { color: theme.colors.dim, dim: true };
    case "table-header":
      return { bold: true };
    case "diff-header":
      return { color: theme.colors.warning, bold: true };
    case "diff-hunk":
      return { color: theme.colors.primary };
    case "diff-section-add":
    case "diff-add":
      return {
        color: theme.colors.success,
        backgroundColor: "rgb(22,47,32)",
      };
    case "diff-section-remove":
    case "diff-remove":
      return {
        color: theme.colors.error,
        backgroundColor: "rgb(61,31,32)",
      };
    case "diff-context":
      return { color: theme.colors.muted };
    case "code":
      return { color: theme.colors.muted };
    default:
      return {};
  }
}

function renderTextContent(
  line: MarkdownDisplayLine,
  index: number,
  style: ReturnType<typeof styleForMode>,
): React.ReactElement {
  if (line.text.includes("\u001b[")) {
    return <Ansi key={`ansi-content-${index}`}>{line.text}</Ansi>;
  }
  return (
    <Text
      key={`text-content-${index}`}
      {...(style.color ? { color: style.color as Color } : {})}
      {...(style.backgroundColor
        ? { backgroundColor: style.backgroundColor as Color }
        : {})}
      {...(style.bold ? { bold: true } : {})}
      {...(style.dim ? { dim: true } : {})}
    >
      {line.text}
    </Text>
  );
}

function renderLineElement(
  line: MarkdownDisplayLine,
  index: number,
): React.ReactElement {
  if (line.mode === "blank" || line.text.length === 0) {
    return (
      <Box key={`blank-${index}`}>
        <Text>{" "}</Text>
      </Box>
    );
  }

  const style = styleForMode(line.mode);
  return (
    <Box key={`display-line-${index}`} flexDirection="row">
      {renderTextContent(line, index, style)}
    </Box>
  );
}

export function DisplayLineBlock({
  lines,
}: DisplayLineBlockProps): React.ReactElement {
  return <Box flexDirection="column">{lines.map(renderLineElement)}</Box>;
}
