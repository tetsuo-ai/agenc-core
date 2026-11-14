import * as React from "react";
import { Box, Text } from "../ink.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { formatLiveEfficiency, type TurnEfficiency } from "../turn-efficiency.js";

export function LiveRunLine({ turn }: {
  readonly turn: TurnEfficiency;
}): React.ReactNode {
  const { columns } = useTerminalSize();
  const line = formatLiveEfficiency(turn, Math.max(0, columns - 2));
  return line ? <Box paddingLeft={2} width="100%">
    <Text dimColor wrap="truncate-end">{line}</Text>
  </Box> : null;
}
