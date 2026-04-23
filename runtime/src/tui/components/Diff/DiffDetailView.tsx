import React from "react";

import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import type { Color } from "../../ink/styles.js";
import { theme } from "../../theme.js";
import type { DiffDisplayLine } from "./model.js";

export interface DiffDetailViewProps {
  readonly lines: readonly DiffDisplayLine[];
  readonly title?: string;
}

function lineColor(mode: string): Color {
  switch (mode) {
    case "diff-header":
      return theme.colors.accent as Color;
    case "diff-hunk":
      return theme.colors.info as Color;
    case "diff-add":
    case "diff-section-add":
      return theme.colors.success as Color;
    case "diff-remove":
    case "diff-section-remove":
      return theme.colors.error as Color;
    case "diff-meta":
    case "blank":
      return theme.colors.dim as Color;
    default:
      return theme.colors.ink as Color;
  }
}

export const DiffDetailView: React.FC<DiffDetailViewProps> = ({
  lines,
  title,
}) => (
  <Box flexDirection="column">
    {title !== undefined && title.length > 0 ? (
      <Text color={theme.colors.warning as Color}>{title}</Text>
    ) : null}
    {lines.map((line, index) => (
      <Text key={`${line.mode}-${index}`} color={lineColor(line.mode)}>
        {line.text}
      </Text>
    ))}
  </Box>
);

export default DiffDetailView;
