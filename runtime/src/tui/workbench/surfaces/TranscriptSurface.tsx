import React, { type RefObject } from "react";

import { Box, Text } from "../../ink.js";
import ScrollBox, { type ScrollBoxHandle } from "../../ink/components/ScrollBox.js";

export function TranscriptSurface({
  children,
  scrollRef,
  atWelcome = false,
}: {
  readonly children: React.ReactNode;
  readonly scrollRef?: RefObject<ScrollBoxHandle | null>;
  /**
   * Cold-start/empty transcript. When true the ScrollBox is NOT pinned to the
   * bottom, so on a short viewport (e.g. 80 cols) the welcome hero — the
   * `agenc.` brand line, the tagline, and the workspace box top border — stays
   * at the top instead of being scrolled off-screen. Once real messages arrive
   * the transcript returns to sticky-bottom follow behaviour.
   */
  readonly atWelcome?: boolean;
}): React.ReactElement {
  const body = scrollRef ? (
    <ScrollBox ref={scrollRef} flexGrow={1} flexDirection="column" width="100%" stickyScroll={!atWelcome}>
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
