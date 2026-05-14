import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import type { HookEvent } from '../../../entrypoints/agentSdkTypes.js';
import type { buildMessageLookups } from '../../../utils/messages.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { selectAgenCTuiGlyphs } from '../../glyphs.js';
import { Box, Text } from '../../ink.js';
import { MessageResponse } from '../MessageResponse';
type Props = {
  hookEvent: HookEvent;
  lookups: ReturnType<typeof buildMessageLookups>;
  toolUseID: string;
  verbose: boolean;
  isTranscriptMode?: boolean;
};
export function getHookProgressRunningLabel(
  inProgressHookCount: number,
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): string {
  const ellipsis = selectAgenCTuiGlyphs(env).ellipsis;
  return inProgressHookCount === 1 ? ` hook${ellipsis}` : ` hooks${ellipsis}`;
}
export function HookProgressMessage(t0) {
  const $ = _c(22);
  const {
    hookEvent,
    lookups,
    toolUseID,
    isTranscriptMode
  } = t0;
  let t1;
  if ($[0] !== hookEvent || $[1] !== lookups.inProgressHookCounts || $[2] !== toolUseID) {
    t1 = lookups.inProgressHookCounts.get(toolUseID)?.get(hookEvent) ?? 0;
    $[0] = hookEvent;
    $[1] = lookups.inProgressHookCounts;
    $[2] = toolUseID;
    $[3] = t1;
  } else {
    t1 = $[3];
  }
  const inProgressHookCount = t1;
  const resolvedHookCount = lookups.resolvedHookCounts.get(toolUseID)?.get(hookEvent) ?? 0;
  if (inProgressHookCount === 0) {
    return null;
  }
  if (hookEvent === "PreToolUse" || hookEvent === "PostToolUse") {
    if (isTranscriptMode) {
      let t2;
      if ($[4] !== inProgressHookCount) {
        t2 = <Text dimColor={true}>{inProgressHookCount} </Text>;
        $[4] = inProgressHookCount;
        $[5] = t2;
      } else {
        t2 = $[5];
      }
      let t3;
      if ($[6] !== hookEvent) {
        t3 = <Text dimColor={true} bold={true}>{hookEvent}</Text>;
        $[6] = hookEvent;
        $[7] = t3;
      } else {
        t3 = $[7];
      }
      const t4 = inProgressHookCount === 1 ? " hook" : " hooks";
      let t5;
      if ($[8] !== t4) {
        t5 = <Text dimColor={true}>{t4} ran</Text>;
        $[8] = t4;
        $[9] = t5;
      } else {
        t5 = $[9];
      }
      let t6;
      if ($[10] !== t2 || $[11] !== t3 || $[12] !== t5) {
        t6 = <MessageResponse><Box flexDirection="row">{t2}{t3}{t5}</Box></MessageResponse>;
        $[10] = t2;
        $[11] = t3;
        $[12] = t5;
        $[13] = t6;
      } else {
        t6 = $[13];
      }
      return t6;
    }
    const hookLabel = getHookProgressRunningLabel(inProgressHookCount);
    return (
      <MessageResponse>
        <Box flexDirection="row">
          <Text dimColor={true}>Running </Text>
          <Text dimColor={true} bold={true}>{hookEvent}</Text>
          <Text dimColor={true}>{hookLabel}</Text>
        </Box>
      </MessageResponse>
    );
  }
  if (resolvedHookCount === inProgressHookCount) {
    return null;
  }
  let t2;
  if ($[14] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = <Text dimColor={true}>Running </Text>;
    $[14] = t2;
  } else {
    t2 = $[14];
  }
  let t3;
  if ($[15] !== hookEvent) {
    t3 = <Text dimColor={true} bold={true}>{hookEvent}</Text>;
    $[15] = hookEvent;
    $[16] = t3;
  } else {
    t3 = $[16];
  }
  const t4 = inProgressHookCount === 1 ? " hook\u2026" : " hooks\u2026";
  let t5;
  if ($[17] !== t4) {
    t5 = <Text dimColor={true}>{t4}</Text>;
    $[17] = t4;
    $[18] = t5;
  } else {
    t5 = $[18];
  }
  let t6;
  if ($[19] !== t3 || $[20] !== t5) {
    t6 = <MessageResponse><Box flexDirection="row">{t2}{t3}{t5}</Box></MessageResponse>;
    $[19] = t3;
    $[20] = t5;
    $[21] = t6;
  } else {
    t6 = $[21];
  }
  return t6;
}
