// @ts-nocheck
import React, { type RefObject } from "react";

import { Box, Text } from "../../ink.js";
import ScrollBox, { type ScrollBoxHandle } from "../../ink/components/ScrollBox.js";

export function TranscriptSurface({
  children,
  scrollRef,
}: {
  readonly children: React.ReactNode;
  readonly scrollRef?: RefObject<ScrollBoxHandle | null>;
}): React.ReactElement {
  const body = scrollRef ? (
    <ScrollBox ref={scrollRef} flexGrow={1} flexDirection="column" width="100%" stickyScroll={true}>
      {children}
    </ScrollBox>
  ) : (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {children}
    </Box>
  );

  return (
    <Box flexDirection="column" width="100%" height="100%" overflow="hidden">
      <Box height={1} flexShrink={0}>
        <Text color="text2">TRANSCRIPT</Text>
      </Box>
      {body}
    </Box>
  );
}
