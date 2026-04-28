/**
 * HookProgressMessage — shows hook execution progress for a tool call.
 *
 * Ported from upstream `components/messages/HookProgressMessage.tsx`.
 *
 * Differences from upstream:
 *   - upstream pulled `inProgressHookCounts` and `resolvedHookCounts`
 *     out of `buildMessageLookups`. AgenC's transcript reducer does not
 *     own those tables yet, so this component takes the counts as
 *     props. The wiring point in the dispatcher will pass the values
 *     it has from the live event stream when the hook progress is
 *     surfaced.
 *   - The upstream three-mode dispatch (transcript-mode summary for
 *     `PreToolUse`/`PostToolUse`, otherwise a "Running … hooks" line)
 *     is preserved, but rendered with the design-system `Spinner` so
 *     the row reads as live in the AgenC TUI even when no event arrives
 *     between renders.
 *   - The React Compiler `_c()` cache slots are dropped per the port
 *     pattern guide.
 *
 * @module
 */

import React from "react";

import { Box, Text } from "../../ink-public.js";
import { Spinner } from "../../design-system/Spinner.js";

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Notification"
  | "Stop"
  | "SubagentStop"
  | "PreCompact"
  | "SessionStart"
  | "SessionEnd";

export interface HookProgressMessageProps {
  readonly hookEvent: HookEvent;
  /** Tool the hook is associated with, surfaced in transcript mode. */
  readonly toolName?: string;
  /** Number of hook executions still in flight for this tool. */
  readonly inProgressHookCount: number;
  /** Number of hook executions that have completed for this tool. */
  readonly resolvedHookCount?: number;
  /**
   * When true, the row is being rendered inside the verbose
   * transcript surface. The transcript surface keeps the Pre/Post tool
   * hook summary line; the live composer hides it.
   */
  readonly isTranscriptMode?: boolean;
}

export function HookProgressMessage({
  hookEvent,
  toolName,
  inProgressHookCount,
  resolvedHookCount = 0,
  isTranscriptMode,
}: HookProgressMessageProps): React.ReactElement | null {
  if (inProgressHookCount === 0) {
    return null;
  }

  const isPrePost = hookEvent === "PreToolUse" || hookEvent === "PostToolUse";
  if (isPrePost) {
    if (isTranscriptMode !== true) return null;
    const noun = inProgressHookCount === 1 ? "hook" : "hooks";
    return (
      <Box flexDirection="row">
        <Text color="dim">{`  ⎿  ${inProgressHookCount} `}</Text>
        <Text color="dim" bold>
          {hookEvent}
        </Text>
        <Text color="dim">{` ${noun} ran`}</Text>
        {toolName ? (
          <Text color="dim">{` for ${toolName}`}</Text>
        ) : null}
      </Box>
    );
  }

  if (resolvedHookCount >= inProgressHookCount) {
    return null;
  }

  const remaining = inProgressHookCount - resolvedHookCount;
  const noun = remaining === 1 ? "hook" : "hooks";
  return (
    <Box flexDirection="row">
      <Box marginRight={1}>
        <Spinner />
      </Box>
      <Text color="dim">Running </Text>
      <Text color="dim" bold>
        {hookEvent}
      </Text>
      <Text color="dim">{` ${noun}…`}</Text>
      {toolName ? <Text color="dim">{` (${toolName})`}</Text> : null}
    </Box>
  );
}

export default HookProgressMessage;
