/**
 * Single-line notice shown below the composer when a stashed prompt
 * is available for auto-restore on the next submit.
 *
 * Ported from upstream. The notice is intentionally minimal — the
 * stash mechanism owns the actual stash/restore lifecycle; this widget
 * only surfaces the "stashed" indicator while a stash is present.
 */
import * as React from "react";

import { Box, Text } from "../ink-public.js";

interface Props {
  readonly hasStash: boolean;
}

export function PromptInputStashNotice({
  hasStash,
}: Props): React.ReactElement | null {
  if (!hasStash) return null;
  return (
    <Box paddingLeft={2}>
      <Text dimColor>
        {"› Stashed (auto-restores after submit)"}
      </Text>
    </Box>
  );
}

export default PromptInputStashNotice;
