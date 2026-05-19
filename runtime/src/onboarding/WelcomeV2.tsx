import React from "react";

import { OnboardingBox as Box, OnboardingText as Text } from "./elements.js";

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
      <Text bold>{compact ? "AgenC" : "Welcome to AgenC"}</Text>
      {compact ? null : (
        <Text dimColor>Set up the runtime once, then start working.</Text>
      )}
      {selection !== undefined ? (
        <Text dimColor>Selected model: {selection}</Text>
      ) : null}
    </Box>
  );
}
