import { c as _c } from "react-compiler-runtime";
import type React from 'react';
import { Box, Text } from '../ink.js';
type Props = {
  isError: boolean;
  isUnresolved: boolean;
  shouldAnimate: boolean;
};
export function ToolUseLoader(t0: Props): React.ReactNode {
  const $ = _c(4);
  const {
    isError,
    isUnresolved,
  } = t0;
  const color = isUnresolved ? undefined : isError ? "error" : "success";
  const glyph = isUnresolved ? "◐" : isError ? "✕" : "●";
  let t2;
  if ($[0] !== color || $[1] !== glyph || $[2] !== isUnresolved) {
    t2 = <Text color={color} dimColor={isUnresolved}>{glyph}</Text>;
    $[0] = color;
    $[1] = glyph;
    $[2] = isUnresolved;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  return <Box minWidth={2}>{t2}</Box>;
}
