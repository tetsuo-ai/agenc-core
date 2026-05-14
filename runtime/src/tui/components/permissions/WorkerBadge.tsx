import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { selectAgenCTuiGlyphs } from '../../glyphs.js';
import { Box, Text } from '../../ink.js';
import { toInkColor } from '../../../utils/ink.js'; // upstream-import: keep target is owned by another Z-PURGE item
export type WorkerBadgeProps = {
  name: string;
  color: string;
};

/**
 * Renders a colored badge showing the worker's name for permission prompts.
 * Used to indicate which swarm worker is requesting the permission.
 */
export function WorkerBadge(t0: WorkerBadgeProps): React.ReactNode {
  const $ = _c(8);
  const {
    name,
    color
  } = t0;
  const statusDot = selectAgenCTuiGlyphs().statusDot;
  let t1;
  if ($[0] !== color) {
    t1 = toInkColor(color);
    $[0] = color;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const inkColor = t1;
  let t2;
  if ($[2] !== name) {
    t2 = <Text bold={true}>@{name}</Text>;
    $[2] = name;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  let t3;
  if ($[4] !== inkColor || $[5] !== statusDot || $[6] !== t2) {
    t3 = <Box flexDirection="row" gap={1}><Text color={inkColor}>{statusDot} {t2}</Text></Box>;
    $[4] = inkColor;
    $[5] = statusDot;
    $[6] = t2;
    $[7] = t3;
  } else {
    t3 = $[7];
  }
  return t3;
}
