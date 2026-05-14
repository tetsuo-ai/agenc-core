import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { selectAgenCTuiGlyphs } from '../../glyphs.js';
import { Box, Text } from '../../ink.js';
import type { Theme } from '../../../utils/theme.js'; // upstream-import: keep target is owned by another Z-PURGE item
import type { WorkerBadgeProps } from './WorkerBadge.js';
type Props = {
  title: string;
  subtitle?: React.ReactNode;
  color?: keyof Theme;
  workerBadge?: WorkerBadgeProps;
};
export function PermissionRequestTitle(t0: Props) {
  const $ = _c(14);
  const {
    title,
    subtitle,
    color: t1,
    workerBadge
  } = t0;
  const color = t1 === undefined ? "permission" : t1;
  const separator = selectAgenCTuiGlyphs().separator;
  let t2;
  if ($[0] !== color || $[1] !== title) {
    t2 = <Text bold={true} color={color}>{title}</Text>;
    $[0] = color;
    $[1] = title;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  let t3;
  if ($[3] !== separator || $[4] !== workerBadge) {
    t3 = workerBadge && <Text dimColor={true}>{separator} @{workerBadge.name}</Text>;
    $[3] = separator;
    $[4] = workerBadge;
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  let t4;
  if ($[6] !== t2 || $[7] !== t3) {
    t4 = <Box flexDirection="row" gap={1}>{t2}{t3}</Box>;
    $[6] = t2;
    $[7] = t3;
    $[8] = t4;
  } else {
    t4 = $[8];
  }
  let t5;
  if ($[9] !== subtitle) {
    t5 = subtitle != null && (typeof subtitle === "string" ? <Text dimColor={true} wrap="truncate-start">{subtitle}</Text> : subtitle);
    $[9] = subtitle;
    $[10] = t5;
  } else {
    t5 = $[10];
  }
  let t6;
  if ($[11] !== t4 || $[12] !== t5) {
    t6 = <Box flexDirection="column">{t4}{t5}</Box>;
    $[11] = t4;
    $[12] = t5;
    $[13] = t6;
  } else {
    t6 = $[13];
  }
  return t6;
}
