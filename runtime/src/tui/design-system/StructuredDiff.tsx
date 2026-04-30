import type { StructuredPatchHunk } from "diff";
import { diffWordsWithSpace } from "diff";
import React, { memo, useMemo } from "react";

import { RawAnsi } from "../ink/components/RawAnsi.js";
import { NoSelect } from "../ink/components/NoSelect.js";
import { Box } from "../ink-public.js";
import {
  type DiffDisplayLine,
  buildDiffDisplayLines,
} from "../_deps/diff-render.js";
import sliceAnsi from "../ink/vendored/sliceAnsi.js";

type BaseProps = {
  readonly width?: number;
  readonly dim?: boolean;
  readonly filePath?: string;
  readonly firstLine?: string | null;
  readonly fileContent?: string;
  readonly skipHighlighting?: boolean;
};

type Props =
  | (BaseProps & {
      readonly patch: StructuredPatchHunk;
      readonly patchText?: never;
      readonly lines?: never;
    })
  | (BaseProps & {
      readonly patchText: string;
      readonly patch?: never;
      readonly lines?: never;
    })
  | (BaseProps & {
      readonly lines: readonly DiffDisplayLine[];
      readonly patch?: never;
      readonly patchText?: never;
    });

type CachedRender = {
  readonly lines: readonly string[];
  readonly gutterWidth: number;
  readonly gutters: readonly string[] | null;
  readonly contents: readonly string[] | null;
};

const RENDER_CACHE = new WeakMap<object, Map<string, CachedRender>>();

function patchToText(patch: StructuredPatchHunk): string {
  const header = `@@ -${patch.oldStart},${patch.oldLines} +${patch.newStart},${patch.newLines} @@`;
  return [header, ...patch.lines].join("\n");
}

function computeGutterWidthFromPatch(patch: StructuredPatchHunk): number {
  const maxLineNumber = Math.max(
    patch.oldStart + patch.oldLines - 1,
    patch.newStart + patch.newLines - 1,
    1,
  );
  return maxLineNumber.toString().length + 3;
}

function cacheKey(
  width: number,
  dim: boolean,
  filePath: string,
  firstLine: string | null,
  fileContent: string | undefined,
  skipHighlighting: boolean,
): string {
  return [
    width,
    dim ? 1 : 0,
    filePath,
    firstLine ?? "",
    fileContent?.length ?? 0,
    skipHighlighting ? 1 : 0,
  ].join("|");
}

function displayLinesToCached(
  lines: readonly DiffDisplayLine[],
  gutterWidth: number,
): CachedRender {
  const ansiLines = lines.map((line) => line.text);
  const safeGutter = gutterWidth > 0 ? gutterWidth : 0;
  return {
    lines: ansiLines,
    gutterWidth: safeGutter,
    gutters:
      safeGutter > 0
        ? ansiLines.map((line) => sliceAnsi(line, 0, safeGutter))
        : null,
    contents:
      safeGutter > 0
        ? ansiLines.map((line) => sliceAnsi(line, safeGutter))
        : null,
  };
}

class LocalColorDiff {
  constructor(
    private readonly patch: StructuredPatchHunk,
    private readonly filePath: string,
    private readonly fileContent: string | undefined,
  ) {}

  render(width: number): readonly DiffDisplayLine[] {
    return buildDiffDisplayLines(
      {
        kind: "tool",
        body: patchToText(this.patch),
        filePath: this.filePath,
        fileContent: this.fileContent,
      },
      { maxPathChars: Math.max(12, width) },
    );
  }
}

function renderPatch(
  patch: StructuredPatchHunk,
  firstLine: string | null,
  filePath: string,
  fileContent: string | undefined,
  width: number,
  dim: boolean,
  skipHighlighting: boolean,
): CachedRender {
  const key = cacheKey(width, dim, filePath, firstLine, fileContent, skipHighlighting);
  let perPatch = RENDER_CACHE.get(patch);
  const hit = perPatch?.get(key);
  if (hit) return hit;

  const gutterWidth = computeGutterWidthFromPatch(patch);
  const rendered = skipHighlighting
    ? buildWordFallbackLines(patch)
    : new LocalColorDiff(patch, filePath, fileContent).render(width);
  const cached = displayLinesToCached(
    rendered,
    gutterWidth > 0 && gutterWidth < width ? gutterWidth : 0,
  );

  if (!perPatch) {
    perPatch = new Map();
    RENDER_CACHE.set(patch, perPatch);
  }
  if (perPatch.size >= 4) perPatch.clear();
  perPatch.set(key, cached);
  return cached;
}

function buildWordFallbackLines(
  patch: StructuredPatchHunk,
): readonly DiffDisplayLine[] {
  const output: DiffDisplayLine[] = [];
  for (const line of patch.lines) {
    if (line.startsWith("-") || line.startsWith("+")) {
      const pieces = diffWordsWithSpace("", line.slice(1));
      output.push({
        text: `${line[0]} ${pieces.map((piece) => piece.value).join("")}`,
        plainText: line,
        mode: line.startsWith("+") ? "diff-add" : "diff-remove",
      });
    } else {
      output.push({
        text: line,
        plainText: line,
        mode: line.startsWith("@@") ? "diff-hunk" : "diff-context",
      });
    }
  }
  return output;
}

function computeGutterWidth(lines: readonly DiffDisplayLine[]): number {
  let candidate = -1;
  for (const line of lines) {
    const plain = line.plainText ?? "";
    const match = plain.match(/^(\s*\d+\s+[+\- ])/);
    if (!match) return 0;
    const width = (match[1] ?? "").length;
    if (candidate === -1) candidate = width;
    else if (candidate !== width) return 0;
  }
  return candidate > 0 ? candidate : 0;
}

export const StructuredDiff = memo(function StructuredDiff(
  props: Props,
): React.ReactElement | null {
  const width = Math.max(1, Math.floor(props.width ?? 80));
  const dim = props.dim ?? false;
  const cached = useMemo((): CachedRender => {
    if ("patch" in props && props.patch) {
      return renderPatch(
        props.patch,
        props.firstLine ?? null,
        props.filePath ?? "",
        props.fileContent,
        width,
        dim,
        props.skipHighlighting === true,
      );
    }
    const lines =
      "lines" in props && props.lines
        ? props.lines
        : buildDiffDisplayLines({ kind: "tool", body: props.patchText ?? "" });
    return displayLinesToCached(lines, computeGutterWidth(lines));
  }, [dim, props, width]);

  if (cached.lines.length === 0) return null;

  if (
    cached.gutterWidth > 0 &&
    cached.gutters !== null &&
    cached.contents !== null
  ) {
    return (
      <Box flexDirection="row">
        <NoSelect fromLeftEdge={true}>
          <RawAnsi lines={cached.gutters} width={cached.gutterWidth} />
        </NoSelect>
        <RawAnsi
          lines={cached.contents}
          width={Math.max(1, width - cached.gutterWidth)}
        />
      </Box>
    );
  }

  return <RawAnsi lines={cached.lines} width={width} />;
});

export default StructuredDiff;
