/**
 * UserToolCanceledMessage — renders a canceled tool-call row.
 *
 * Ported from upstream
 * `components/messages/UserToolResultMessage/UserToolCanceledMessage.tsx`.
 * The upstream version wraps an `<InterruptedByUser />` cell inside a
 * `<MessageResponse>`. AgenC has neither, so we render the same single
 * line directly with the design-system `Text` and the dim color token.
 *
 * @module
 */

import React from "react";

import { Box, Text } from "../../../ink-public.js";

export function UserToolCanceledMessage(): React.ReactElement {
  return (
    <Box flexDirection="row">
      <Text color="dim">{"  ⎿  Tool use canceled by user"}</Text>
    </Box>
  );
}

export default UserToolCanceledMessage;
