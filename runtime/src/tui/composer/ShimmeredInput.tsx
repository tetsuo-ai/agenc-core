/**
 * Highlighted/shimmered text renderer for the composer buffer.
 *
 * The composer can decorate slices of the live buffer with a color, a
 * dim flag, an inverse flag, or a sweeping "shimmer" gradient — used by
 * the upstream renderer to draw the eye to the `ultrathink` keyword.
 * AgenC keeps the same API so future tranches can reintroduce keyword
 * sweeps without re-plumbing the renderer.
 *
 * The implementation is intentionally local: the upstream shimmer
 * relies on `@alcalzone/ansi-tokenize` and a `ShimmerChar` widget that
 * are not in the codex runtime today, so this file owns the small
 * segment-and-paint loop in plain React. Highlights are resolved with
 * a simple "first writer wins after priority sort" pass — exactly the
 * upstream contract — but we skip the full ANSI re-tokenization step
 * because the composer hands us pre-stripped UTF-8 buffers.
 */

import * as React from "react";

import { Box, Text, useAnimationFrame } from "../ink-public.js";
import type { Theme } from "../theme.js";

/**
 * Color tokens accepted by `TextHighlight.color`. Keep aligned with
 * `Theme['colors']` so highlight authors get type-checked tokens.
 */
type ThemeColorKey = keyof Theme["colors"];

export type TextHighlight = {
  readonly start: number;
  readonly end: number;
  readonly color: ThemeColorKey | undefined;
  readonly dimColor?: boolean;
  readonly inverse?: boolean;
  readonly shimmerColor?: ThemeColorKey;
  readonly priority: number;
};

type Props = {
  readonly text: string;
  readonly highlights: readonly TextHighlight[];
};

type LinePart = {
  readonly text: string;
  readonly highlight: TextHighlight | undefined;
  readonly start: number;
};

type Segment = {
  readonly text: string;
  readonly start: number;
  readonly highlight: TextHighlight | undefined;
};

/**
 * Resolve overlapping highlights into a flat list of non-overlapping
 * segments. Ties are broken by `priority` (higher wins) and then by
 * insertion order. Plain text in between highlights is emitted as
 * segments without a `highlight` so the renderer paints them in the
 * default theme color.
 */
function segmentByHighlights(
  text: string,
  highlights: readonly TextHighlight[],
): Segment[] {
  if (highlights.length === 0) {
    return [{ text, start: 0, highlight: undefined }];
  }

  const sorted = [...highlights]
    .filter((h) => h.start < h.end)
    .sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      return b.priority - a.priority;
    });

  // Resolve overlap by reserving ranges in sort order.
  const reserved: Array<{ start: number; end: number; highlight: TextHighlight }> = [];
  for (const h of sorted) {
    const conflict = reserved.some(
      (r) =>
        (h.start >= r.start && h.start < r.end) ||
        (h.end > r.start && h.end <= r.end) ||
        (h.start <= r.start && h.end >= r.end),
    );
    if (conflict) continue;
    reserved.push({ start: h.start, end: h.end, highlight: h });
  }
  reserved.sort((a, b) => a.start - b.start);

  const segments: Segment[] = [];
  let cursor = 0;
  for (const r of reserved) {
    if (r.start > cursor) {
      segments.push({
        text: text.slice(cursor, r.start),
        start: cursor,
        highlight: undefined,
      });
    }
    segments.push({
      text: text.slice(r.start, r.end),
      start: r.start,
      highlight: r.highlight,
    });
    cursor = r.end;
  }
  if (cursor < text.length) {
    segments.push({
      text: text.slice(cursor),
      start: cursor,
      highlight: undefined,
    });
  }
  return segments;
}

/**
 * Render `text` with the supplied `highlights`. When at least one
 * highlight specifies a `shimmerColor`, the renderer animates a single
 * "glimmer" character left-to-right across the shimmer span at ~50ms
 * per step.
 */
export function HighlightedInput({ text, highlights }: Props): React.ReactElement {
  const lines = React.useMemo<LinePart[][]>(() => {
    const segments = segmentByHighlights(text, highlights);
    const out: LinePart[][] = [[]];
    let pos = 0;
    for (const segment of segments) {
      const parts = segment.text.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          out.push([]);
          pos = pos + 1;
        }
        const part = parts[i] ?? "";
        if (part.length > 0) {
          out[out.length - 1]!.push({
            text: part,
            highlight: segment.highlight,
            start: pos,
          });
        }
        pos = pos + part.length;
      }
    }
    return out;
  }, [text, highlights]);

  const hasShimmer = highlights.some((h) => h.shimmerColor !== undefined);

  let sweepStart = 0;
  let cycleLength = 1;
  if (hasShimmer) {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const h of highlights) {
      if (h.shimmerColor !== undefined) {
        lo = Math.min(lo, h.start);
        hi = Math.max(hi, h.end);
      }
    }
    sweepStart = lo - 10;
    cycleLength = hi - lo + 20;
  }

  const [ref, time] = useAnimationFrame(hasShimmer ? 50 : null);
  const glimmerIndex = hasShimmer
    ? sweepStart + (Math.floor(time / 50) % cycleLength)
    : -100;

  const renderedLines = lines.map((lineParts, lineIndex) => (
    <Box key={`${lineIndex}`}>
      {lineParts.length === 0 ? (
        <Text> </Text>
      ) : (
        lineParts.map((part, partIndex) => {
          const color = part.highlight?.color;
          const dimColor = part.highlight?.dimColor === true;
          const inverse = part.highlight?.inverse === true;
          // The glimmer is a single bright character that slides
          // along the shimmer span. Characters outside the current
          // glimmer index keep the underlying highlight color.
          if (
            part.highlight?.shimmerColor !== undefined &&
            part.highlight.color !== undefined
          ) {
            return (
              <React.Fragment key={partIndex}>
                <Text>
                  {part.text.split("").map((char, charIndex) => {
                    const charPos = part.start + charIndex;
                    const isGlimmer = charPos === glimmerIndex;
                    return (
                      <React.Fragment key={charIndex}>
                        <Text
                          color={
                            isGlimmer
                              ? part.highlight!.shimmerColor!
                              : part.highlight!.color!
                          }
                        >
                          {char}
                        </Text>
                      </React.Fragment>
                    );
                  })}
                </Text>
              </React.Fragment>
            );
          }
          return (
            <React.Fragment key={partIndex}>
              <Text color={color} dimColor={dimColor} inverse={inverse}>
                {part.text}
              </Text>
            </React.Fragment>
          );
        })
      )}
    </Box>
  ));

  return (
    <Box ref={ref} flexDirection="column">
      {renderedLines}
    </Box>
  );
}
