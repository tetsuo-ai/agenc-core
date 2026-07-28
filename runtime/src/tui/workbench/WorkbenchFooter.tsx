import React from "react";

import { Box, Text } from "../ink.js";
import { stringWidth } from "../ink/stringWidth.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";

// Hints are `<label>: <segment>  <segment>  …` with double-space separators.
// On narrow terminals whole trailing segments are dropped instead of
// ellipsizing the last one mid-word ("ctrl+w k focu…" taught nothing). The
// label plus first segment always render (truncated as a last resort).
export function fitFooterHints(hints: string, available: number): string {
  if (stringWidth(hints) <= available) return hints;
  const segments = hints.split(/ {2,}/);
  let line = "";
  for (const segment of segments) {
    const candidate = line === "" ? segment : `${line}  ${segment}`;
    if (stringWidth(candidate) > available) break;
    line = candidate;
  }
  return line === "" ? (segments[0] ?? hints) : line;
}

export function WorkbenchFooter(): React.ReactElement {
  const { columns } = useTerminalSize();
  const showMode = columns >= 58;
  const showTranscript = columns >= 76;
  return (
    <Box
      height={3}
      width="100%"
      paddingX={2}
      paddingTop={1}
      alignItems="center"
      backgroundColor="#000000"
      borderTop
      borderTopColor="lineSoft"
    >
      <Text color="text">/</Text>
      <Text color="inactive"> commands</Text>
      <Box width={3} />
      <Text color="text">@</Text>
      <Text color="inactive"> attach</Text>
      {showMode ? (
        <>
          <Box width={3} />
          <Text color="text" bold>shift+tab</Text>
          <Text color="inactive"> mode</Text>
        </>
      ) : null}
      {showTranscript ? (
        <>
          <Box width={3} />
          <Text color="text" bold>ctrl+o</Text>
          <Text color="inactive"> transcript</Text>
        </>
      ) : null}
      <Box width={3} />
      <Text color="text">?</Text>
      <Text color="inactive"> shortcuts</Text>
    </Box>
  );
}
