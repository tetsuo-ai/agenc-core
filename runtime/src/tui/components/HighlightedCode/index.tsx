import React, { useEffect, useState } from "react";

import { RawAnsi } from "../../ink/components/RawAnsi.js";
import {
  renderHighlightedCodeLines,
  type HighlightedCodeLine,
} from "../../render/code-highlight.js";
import { HighlightedCodeFallback } from "./Fallback.js";

export interface HighlightedCodeProps {
  readonly code: string;
  readonly filePath: string;
  readonly width?: number;
  readonly dim?: boolean;
}

export const HighlightedCode: React.FC<HighlightedCodeProps> = ({
  code,
  filePath,
  width,
  dim = false,
}) => {
  const [lines, setLines] = useState<readonly HighlightedCodeLine[] | null>(null);
  const resolvedWidth =
    Number.isFinite(width) && typeof width === "number"
      ? Math.max(1, Math.floor(width))
      : 80;

  useEffect(() => {
    let cancelled = false;
    void renderHighlightedCodeLines({
      code,
      filePath,
      width: resolvedWidth,
    }).then((next) => {
      if (!cancelled) {
        setLines(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, filePath, resolvedWidth]);

  if (lines === null) {
    return <HighlightedCodeFallback code={code} width={resolvedWidth} dim={dim} />;
  }

  const rendered = lines.map((line) => line.text);
  const hasAnsi = rendered.some((line) => line.includes("\u001b["));
  if (!hasAnsi) {
    return <HighlightedCodeFallback code={code} width={resolvedWidth} dim={dim} />;
  }

  return <RawAnsi lines={rendered} width={resolvedWidth} />;
};

export default HighlightedCode;
