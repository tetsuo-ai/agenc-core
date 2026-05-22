// @ts-nocheck
import React from "react";

import { Box, Text } from "../../ink.js";

export function TranscriptSurface({
  children,
}: {
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box flexDirection="column" width="100%" height="100%" overflow="hidden">
      <Box height={1} flexShrink={0}>
        <Text color="text2">TRANSCRIPT</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {children}
      </Box>
    </Box>
  );
}
