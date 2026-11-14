import * as React from "react";
import { Box, Text } from "../ink.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { formatLiveEfficiency, type TurnEfficiency } from "../turn-efficiency.js";

/**
 * The live calls and input line under the working line. It belongs to
 * `tui.turnStats = "full"`; the default "brief" shows nothing here.
 */
export function LiveRunLine({ turn, full = false }: {
  readonly turn: TurnEfficiency;
  readonly full?: boolean;
}): React.ReactNode {
  const { columns } = useTerminalSize();
  const line = full ? formatLiveEfficiency(turn, Math.max(0, columns - 2)) : "";
  return line ? <Box paddingLeft={2} width="100%">
    <Text dimColor wrap="truncate-end">{line}</Text>
  </Box> : null;
}
