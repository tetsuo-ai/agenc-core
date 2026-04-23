import React, { useContext, useEffect, useMemo, useState } from "react";

import { Ansi } from "../ink/Ansi.js";
import Box from "../ink/components/Box.js";
import { TerminalSizeContext } from "../ink/components/TerminalSizeContext.js";
import Text from "../ink/components/Text.js";
import type { MarkdownDisplayLine } from "../render/markdown.js";
import {
  renderMarkdownDisplayLines,
  renderMarkdownDisplayLinesSync,
  renderStreamingMarkdownDisplayLines,
  renderStreamingMarkdownDisplayLinesSync,
} from "../render/markdown.js";

export interface MarkdownBlockProps {
  readonly content: string;
  readonly isComplete?: boolean;
}

function styleForMode(
  mode: string,
): {
  readonly color?: string;
  readonly bold?: boolean;
  readonly dim?: boolean;
} {
  switch (mode) {
    case "heading":
      return { color: "cyan", bold: true };
    case "quote":
    case "rule":
    case "code-meta":
    case "table-divider":
    case "diff-meta":
    case "stream-tail":
      return { color: "gray", dim: true };
    case "table-header":
      return { bold: true };
    case "diff-header":
      return { color: "yellow", bold: true };
    case "diff-hunk":
      return { color: "cyan" };
    case "diff-add":
      return { color: "green" };
    case "diff-remove":
      return { color: "red" };
    default:
      return {};
  }
}

function renderLine(line: MarkdownDisplayLine, index: number): React.ReactElement {
  if (line.mode === "blank" || line.text.length === 0) {
    return (
      <Box key={`blank-${index}`}>
        <Text>{" "}</Text>
      </Box>
    );
  }

  if (line.text.includes("\u001b[")) {
    return (
      <Box key={`ansi-${index}`}>
        <Ansi>{line.text}</Ansi>
      </Box>
    );
  }

  const style = styleForMode(line.mode);
  return (
    <Box key={`text-${index}`}>
      <Text
        {...(style.color ? { color: style.color } : {})}
        {...(style.bold ? { bold: true } : {})}
        {...(style.dim ? { dim: true } : {})}
      >
        {line.text}
      </Text>
    </Box>
  );
}

export const MarkdownBlock: React.FC<MarkdownBlockProps> = ({
  content,
  isComplete = false,
}) => {
  const terminalSize = useContext(TerminalSizeContext);
  const width = Math.max(24, (terminalSize?.columns ?? 80) - 4);
  const syncLines = useMemo(
    () =>
      isComplete
        ? renderMarkdownDisplayLinesSync(content, { width })
        : renderStreamingMarkdownDisplayLinesSync(content, { width }),
    [content, isComplete, width],
  );
  const [lines, setLines] = useState<readonly MarkdownDisplayLine[]>(syncLines);

  useEffect(() => {
    setLines(syncLines);
  }, [syncLines]);

  useEffect(() => {
    let cancelled = false;
    const render = async (): Promise<void> => {
      const next = isComplete
        ? await renderMarkdownDisplayLines(content, { width })
        : await renderStreamingMarkdownDisplayLines(content, { width });
      if (!cancelled) {
        setLines(next);
      }
    };
    void render();
    return () => {
      cancelled = true;
    };
  }, [content, isComplete, width]);

  return <Box flexDirection="column">{lines.map(renderLine)}</Box>;
};

export default MarkdownBlock;
