/**
 * GroupedToolUseContent — stacks several tool-use rows that share a
 * tool family under a common header.
 *
 * Ported from upstream `components/messages/GroupedToolUseContent.tsx`.
 *
 * Differences from upstream:
 *   - upstream required the tool object to provide a
 *     `renderGroupedToolUse()` hook and routed all of the rendering
 *     through it. AgenC's `tool-renderers.ts` registry does not own a
 *     grouped renderer, so this component falls back to stacking each
 *     entry through the existing `ToolCell`. That keeps the visual
 *     consistent with the live transcript and avoids touching the
 *     registry shape until a per-tool grouped renderer actually lands.
 *   - The progress / shouldAnimate plumbing is replaced with a single
 *     boolean per entry that the caller can derive from the live
 *     transcript reducer.
 *
 * @module
 */

import React from "react";

import { Box, Text } from "../../ink-public.js";
import { ToolCell } from "../ToolCell.js";

export interface GroupedToolUseEntry {
  /** Stable React key — typically the runtime tool-call id. */
  readonly id: string;
  /** Specific tool name for this entry. */
  readonly toolName: string;
  readonly toolArgs?: unknown;
  readonly result?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
  readonly isComplete?: boolean;
}

export interface GroupedToolUseContentProps {
  /** Family-level title rendered above the stacked rows. */
  readonly toolName: string;
  /** Individual tool-use entries to stack vertically. */
  readonly entries: readonly GroupedToolUseEntry[];
}

export function GroupedToolUseContent({
  toolName,
  entries,
}: GroupedToolUseContentProps): React.ReactElement | null {
  if (entries.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text bold>{toolName}</Text>
        <Text color="dim">{`  (${entries.length} ${entries.length === 1 ? "call" : "calls"})`}</Text>
      </Box>
      <Box flexDirection="column" marginLeft={2}>
        {entries.map((entry) => (
          <ToolCell
            key={entry.id}
            toolName={entry.toolName}
            toolArgs={entry.toolArgs}
            isComplete={entry.isComplete !== false}
            isError={entry.isError === true}
            result={entry.result}
            metadata={entry.metadata}
          />
        ))}
      </Box>
    </Box>
  );
}

export default GroupedToolUseContent;
