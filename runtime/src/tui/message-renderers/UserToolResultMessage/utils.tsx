import { c as _c } from "react-compiler-runtime";
import { useMemo } from 'react';
import { findToolByName, type Tool, type Tools } from '../../../tools/Tool';
import type { AgenCToolResultBlockParam } from '../../../types/message.js';
import type { buildMessageLookups } from '../../../utils/messages';

export function getTextToolResultContent(
  content: AgenCToolResultBlockParam['content'],
): string | undefined {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const textParts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      textParts.push(block);
    } else if (block && typeof block === 'object' && typeof block.text === 'string') {
      textParts.push(block.text);
    }
  }

  return textParts.length > 0 ? textParts.join('\n') : undefined;
}

export function useGetToolFromMessages(toolUseID, tools, lookups) {
  const $ = _c(7);
  let t0;
  if ($[0] !== lookups.toolUseByToolUseID || $[1] !== toolUseID || $[2] !== tools) {
    bb0: {
      const toolUse = lookups.toolUseByToolUseID.get(toolUseID);
      if (!toolUse) {
        t0 = null;
        break bb0;
      }
      const tool = findToolByName(tools, toolUse.name);
      if (!tool) {
        t0 = null;
        break bb0;
      }
      let t1;
      if ($[4] !== tool || $[5] !== toolUse) {
        t1 = {
          tool,
          toolUse
        };
        $[4] = tool;
        $[5] = toolUse;
        $[6] = t1;
      } else {
        t1 = $[6];
      }
      t0 = t1;
    }
    $[0] = lookups.toolUseByToolUseID;
    $[1] = toolUseID;
    $[2] = tools;
    $[3] = t0;
  } else {
    t0 = $[3];
  }
  return t0;
}
