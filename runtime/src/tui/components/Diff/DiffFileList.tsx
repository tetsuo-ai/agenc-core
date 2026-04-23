import React from "react";

import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import type { Color } from "../../ink/styles.js";
import { theme } from "../../theme.js";
import type { DiffFileSummary } from "./model.js";

export interface DiffFileListProps {
  readonly files: readonly DiffFileSummary[];
  readonly selectedIndex?: number;
}

export const DiffFileList: React.FC<DiffFileListProps> = ({
  files,
  selectedIndex = 0,
}) => (
  <Box flexDirection="column">
    {files.map((file, index) => {
      const selected = index === selectedIndex;
      return (
        <Box key={file.path} flexDirection="row">
          <Text color={selected ? theme.colors.accent : theme.colors.dim}>
            {selected ? "▸ " : "  "}
          </Text>
          <Text color={(selected ? theme.colors.ink : theme.colors.muted) as Color}>
            {file.status}
          </Text>
          <Text color={theme.colors.dim as Color}>{" · "}</Text>
          <Text color={(selected ? theme.colors.primary : theme.colors.secondary) as Color}>
            {file.label}
          </Text>
        </Box>
      );
    })}
  </Box>
);

export default DiffFileList;
