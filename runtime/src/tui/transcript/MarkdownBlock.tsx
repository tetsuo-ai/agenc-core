import React, {
  startTransition,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Ansi } from "../ink/Ansi.js";
import Box from "../ink/components/Box.js";
import { TerminalSizeContext } from "../ink/components/TerminalSizeContext.js";
import Text from "../ink/components/Text.js";
import type { MarkdownDisplayLine } from "../render/markdown.js";
import {
  createMarkdownDisplayLineStream,
  renderMarkdownDisplayLines,
  renderMarkdownDisplayLinesSync,
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
      {...(style.color ? { color: style.color } : {})}
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

  if (line.mode === "code-meta") {
    return (
      <Box key={`code-meta-${index}`} flexDirection="row">
        <Text color="gray" dim>{"╭─ "}</Text>
        <Text color="gray" dim>{line.text}</Text>
      </Box>
    );
  }

  if (line.mode === "code") {
    return (
      <Box key={`code-${index}`} flexDirection="row">
        <Text color="gray" dim>{"│ "}</Text>
        {renderTextContent(line, index, {})}
      </Box>
    );
  }

  const style = styleForMode(line.mode);
  return (
    <Box key={`text-${index}`}>
      {renderTextContent(line, index, style)}
    </Box>
  );
}

function renderLines(lines: readonly MarkdownDisplayLine[]): React.ReactElement[] {
  const rendered: React.ReactElement[] = [];
  let inCodeBlock = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (inCodeBlock && line.mode !== "code") {
      rendered.push(
        <Box key={`code-close-${index}`} flexDirection="row">
          <Text color="gray" dim>{"╰"}</Text>
        </Box>,
      );
      inCodeBlock = false;
    }
    rendered.push(renderLineElement(line, index));
    if (line.mode === "code-meta") {
      inCodeBlock = true;
    }
  }

  if (inCodeBlock) {
    rendered.push(
      <Box key="code-close-final" flexDirection="row">
        <Text color="gray" dim>{"╰"}</Text>
      </Box>,
    );
  }

  return rendered;
}

interface StreamingCacheEntry {
  readonly key: string;
  readonly content: string;
  readonly committed: readonly MarkdownDisplayLine[];
  readonly preview: readonly MarkdownDisplayLine[];
  readonly rendered: readonly MarkdownDisplayLine[];
}

function lineEquals(left: MarkdownDisplayLine, right: MarkdownDisplayLine): boolean {
  return (
    left.mode === right.mode &&
    left.text === right.text &&
    left.plainText === right.plainText &&
    left.language === right.language
  );
}

function linesEqual(
  left: readonly MarkdownDisplayLine[],
  right: readonly MarkdownDisplayLine[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftLine = left[index];
    const rightLine = right[index];
    if (!leftLine || !rightLine || !lineEquals(leftLine, rightLine)) {
      return false;
    }
  }
  return true;
}

export const MarkdownBlock: React.FC<MarkdownBlockProps> = ({
  content,
  isComplete = false,
}) => {
  const terminalSize = useContext(TerminalSizeContext);
  const width = Math.max(24, (terminalSize?.columns ?? 80) - 4);
  const streamRef = useRef<ReturnType<typeof createMarkdownDisplayLineStream> | null>(null);
  const streamCacheRef = useRef<StreamingCacheEntry | null>(null);

  const streamingLines = useMemo(() => {
    if (isComplete) {
      streamRef.current = null;
      streamCacheRef.current = null;
      return null;
    }

    const key = `${width}`;
    const cache = streamCacheRef.current;
    const canReuse =
      cache !== null &&
      cache.key === key &&
      content.startsWith(cache.content);

    if (!canReuse) {
      const stream = createMarkdownDisplayLineStream({ width });
      stream.syncToValue(content);
      const committed = stream.commitCompleteLines();
      const preview = stream.previewPendingLines();
      const rendered = [...committed, ...preview];
      streamRef.current = stream;
      streamCacheRef.current = {
        key,
        content,
        committed,
        preview,
        rendered,
      };
      return rendered;
    }

    const stream = streamRef.current;
    if (!stream) {
      return cache.rendered;
    }

    stream.syncToValue(content);
    const committedAdditions = stream.commitCompleteLines();
    const preview = stream.previewPendingLines();
    const committed =
      committedAdditions.length > 0
        ? [...cache.committed, ...committedAdditions]
        : cache.committed;
    const rendered =
      committedAdditions.length === 0 && linesEqual(cache.preview, preview)
        ? cache.rendered
        : [...committed, ...preview];

    streamCacheRef.current = {
      key,
      content,
      committed,
      preview,
      rendered,
    };
    return rendered;
  }, [content, isComplete, width]);

  const syncCompleteLines = useMemo(
    () => renderMarkdownDisplayLinesSync(content, { width }),
    [content, width],
  );
  const [lines, setLines] = useState<readonly MarkdownDisplayLine[]>(
    isComplete ? syncCompleteLines : (streamingLines ?? []),
  );

  useEffect(() => {
    if (!isComplete) {
      setLines(streamingLines ?? []);
      return;
    }
    setLines(syncCompleteLines);
  }, [isComplete, streamingLines, syncCompleteLines]);

  useEffect(() => {
    if (!isComplete) {
      return undefined;
    }
    let cancelled = false;
    const render = async (): Promise<void> => {
      const next = await renderMarkdownDisplayLines(content, { width });
      if (!cancelled) {
        startTransition(() => {
          setLines((current) => (linesEqual(current, next) ? current : next));
        });
      }
    };
    void render();
    return () => {
      cancelled = true;
    };
  }, [content, isComplete, width]);

  return <Box flexDirection="column">{renderLines(lines)}</Box>;
};

export default MarkdownBlock;
