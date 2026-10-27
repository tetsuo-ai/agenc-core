import React from "react";

import { Box } from "../ink.js";
import ThemedText from "./design-system/ThemedText.js";

export type SwarmStatusPresentation = {
  readonly glyph: "◆" | "◇";
  readonly label: string;
  readonly color: "text" | "accentSoft" | "accent";
  readonly bold: boolean;
};

/**
 * Keep the swarm-mode signal compact and human-readable. A filled diamond
 * means agents are active; the outline means swarm mode is ready but idle.
 */
export function swarmStatusPresentation(
  runningAgents: number,
): SwarmStatusPresentation {
  const count = Number.isFinite(runningAgents)
    ? Math.max(0, Math.trunc(runningAgents))
    : 0;

  if (count === 0) {
    return { glyph: "◇", label: "swarm", color: "text", bold: false };
  }

  return {
    glyph: "◆",
    label: `swarm (${count})`,
    // The monochrome themes keep color for meaning and have no amber, so
    // the count grows in the brand purple: soft, then full, then bold.
    color: count >= 3 ? "accent" : "accentSoft",
    bold: count >= 6,
  };
}

/**
 * Activity uses the brand purple, stronger as more helpers work.
 */
export function SwarmStatusIndicator({
  runningAgents,
}: {
  readonly runningAgents: number;
}): React.ReactElement {
  const presentation = swarmStatusPresentation(runningAgents);

  return (
    <Box flexDirection="row" flexShrink={0}>
      <ThemedText color="inactive" wrap="truncate-end">
        {" · "}
      </ThemedText>
      <ThemedText color={presentation.color} bold={presentation.bold} wrap="truncate-end">
        {presentation.label}
      </ThemedText>
    </Box>
  );
}
