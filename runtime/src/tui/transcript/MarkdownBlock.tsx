import React, {
  startTransition,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { TerminalSizeContext } from "../ink/components/TerminalSizeContext.js";
import type { MarkdownDisplayLine } from "../render/markdown.js";
import {
  createMarkdownDisplayLineStream,
  renderMarkdownDisplayLines,
  renderMarkdownDisplayLinesSync,
} from "../render/markdown.js";
import { DisplayLineBlock } from "./DisplayLineBlock.js";

export interface MarkdownBlockProps {
  readonly content: string;
  readonly isComplete?: boolean;
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
    () => (isComplete ? renderMarkdownDisplayLinesSync(content, { width }) : null),
    [content, isComplete, width],
  );
  const [lines, setLines] = useState<readonly MarkdownDisplayLine[]>(
    isComplete ? (syncCompleteLines ?? []) : (streamingLines ?? []),
  );

  useEffect(() => {
    if (!isComplete) {
      setLines(streamingLines ?? []);
      return;
    }
    setLines(syncCompleteLines ?? []);
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

  return <DisplayLineBlock lines={lines} />;
};

export default MarkdownBlock;
