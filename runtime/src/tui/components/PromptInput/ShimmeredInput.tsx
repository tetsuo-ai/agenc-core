import { Ansi, Box, Text, useAnimationFrame } from '../../ink.js';
import { segmentTextByHighlights, type TextHighlight } from '../../../utils/textHighlighting.js';
import { ShimmerChar } from '../spinner/ShimmerChar.js';
type Props = {
  text: string;
  highlights: TextHighlight[];
};
type LinePart = {
  text: string;
  highlight: TextHighlight | undefined;
  start: number;
};
export function HighlightedInput(t0: Props) {
  const {
    text,
    highlights
  } = t0;
  const lines: LinePart[][] = [[]];
  let pos = 0;
  for (const segment of segmentTextByHighlights(text, highlights)) {
    const parts = segment.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        lines.push([]);
        pos = pos + 1;
      }
      const part = parts[i] ?? "";
      if (part.length > 0) {
        lines[lines.length - 1]!.push({
          text: part,
          highlight: segment.highlight,
          start: pos
        });
      }
      pos = pos + part.length;
    }
  }
  const hasShimmer = highlights.some(hasShimmerColor);
  let sweepStart = 0;
  let cycleLength = 1;
  if (hasShimmer) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const h_0 of highlights) {
      if (h_0.shimmerColor) {
        lo = Math.min(lo, h_0.start);
        hi = Math.max(hi, h_0.end);
      }
    }
    sweepStart = lo - 10;
    cycleLength = hi - lo + 20;
  }
  const [ref, time] = useAnimationFrame(hasShimmer ? 50 : null);
  const glimmerIndex = hasShimmer ? sweepStart + Math.floor(time / 50) % cycleLength : -100;
  return <Box ref={ref} flexDirection="column">{lines.map((lineParts, lineIndex) => <Box key={lineIndex}>{lineParts.length === 0 ? <Text> </Text> : lineParts.map((part_0, partIndex) => {
        if (part_0.highlight?.shimmerColor && part_0.highlight.color) {
          return <Text key={partIndex}>{part_0.text.split("").map((char, charIndex) => <ShimmerChar key={charIndex} char={char} index={part_0.start + charIndex} glimmerIndex={glimmerIndex} messageColor={part_0.highlight!.color!} shimmerColor={part_0.highlight!.shimmerColor!} />)}</Text>;
        }
        return <Text key={partIndex} color={part_0.highlight?.color} dimColor={part_0.highlight?.dimColor} inverse={part_0.highlight?.inverse}><Ansi>{part_0.text}</Ansi></Text>;
      })}</Box>)}</Box>;
}
function hasShimmerColor(h: TextHighlight): boolean {
  return Boolean(h.shimmerColor);
}
