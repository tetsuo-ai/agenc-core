import React from "react";

import { Box } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";

export interface WelcomeV2Props {
  readonly compact?: boolean;
  readonly provider?: string;
  readonly model?: string;
}

export function WelcomeV2({
  compact = false,
  provider,
  model,
}: WelcomeV2Props): React.ReactElement {
  const selection =
    provider !== undefined && model !== undefined
      ? `${provider}/${model}`
      : provider ?? model;
  return (
    <Box flexDirection="column" width="100%">
      {/* Brand moment consistent with the cold-start welcome panel, instead of
          a plain bold "Welcome to AgenC". */}
      <ThemedText color="agenc" bold>
        {compact ? "agenc" : "agenc."}
      </ThemedText>
      {compact ? null : (
        <ThemedText color="inactive">
          set up the runtime once, then start working
        </ThemedText>
      )}
      {selection !== undefined ? (
        <Box flexDirection="row">
          <ThemedText color="inactive">using </ThemedText>
          <ThemedText color="text2">{selection}</ThemedText>
        </Box>
      ) : null}
    </Box>
  );
}
