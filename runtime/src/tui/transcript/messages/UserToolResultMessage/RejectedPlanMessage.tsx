/**
 * RejectedPlanMessage — renders the rejected plan body in dim chrome.
 *
 * Ported from upstream
 * `components/messages/UserToolResultMessage/RejectedPlanMessage.tsx`.
 *
 * Differences from upstream:
 *   - upstream rendered the plan body through its `<Markdown>` widget
 *     inside a rounded box with the `planMode` border color. AgenC does
 *     not own that border token; we use the design-system `Pane` with
 *     the `accent` color, which carries the same plan-mode semantics
 *     across the AgenC UI.
 *   - upstream embedded the row inside `<MessageResponse>`. AgenC's
 *     transcript draws indentation on the parent dispatcher, so we
 *     emit a plain `<Box>`.
 *   - The leading "User rejected …'s plan:" label uses the AgenC
 *     branding instead of the upstream string.
 *
 * @module
 */

import React from "react";

import { Box, Text } from "../../../ink-public.js";
import { MarkdownBlock } from "../../MarkdownBlock.js";

export interface RejectedPlanMessageProps {
  /** The plan body the user rejected, as raw markdown. */
  readonly plan: string;
}

export function RejectedPlanMessage({
  plan,
}: RejectedPlanMessageProps): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="dim">User rejected the plan:</Text>
      <Box
        borderStyle="round"
        borderColor="accent"
        paddingX={1}
        flexDirection="column"
        overflow="hidden"
      >
        <MarkdownBlock content={plan} isComplete />
      </Box>
    </Box>
  );
}

export default RejectedPlanMessage;
