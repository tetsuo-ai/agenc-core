import React, { useMemo } from "react";

import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import type { Color } from "../../ink/styles.js";
import { theme } from "../../theme.js";
import { DiffDetailView } from "./DiffDetailView.js";
import { DiffFileList } from "./DiffFileList.js";
import {
  buildDiffLines,
  extractDiffFileSummaries,
  type DiffRenderOptions,
} from "./model.js";

export interface DiffDialogProps extends DiffRenderOptions {
  readonly event: unknown;
  readonly title?: string;
  readonly selectedIndex?: number;
  readonly showFileList?: boolean;
}

export const DiffDialog: React.FC<DiffDialogProps> = ({
  event,
  title = "Diff preview",
  selectedIndex = 0,
  showFileList = true,
  cwd,
  maxPathChars,
}) => {
  const lines = useMemo(
    () => buildDiffLines(event, { cwd, maxPathChars }),
    [cwd, event, maxPathChars],
  );
  const files = useMemo(() => extractDiffFileSummaries(lines), [lines]);
  const clampedIndex =
    files.length === 0
      ? 0
      : Math.max(0, Math.min(selectedIndex, files.length - 1));
  const selectedPath = files[clampedIndex]?.path;
  const detailLines =
    selectedPath === undefined
      ? lines
      : lines.filter((line) => line.filePath === undefined || line.filePath === selectedPath);

  if (lines.length === 0) {
    return (
      <Box
        borderStyle="round"
        borderColor={theme.colors.lineStrong as Color}
        paddingX={1}
        flexDirection="column"
      >
        <Text color={theme.colors.warning as Color}>{title}</Text>
        <Text color={theme.colors.dim as Color}>No diff content available.</Text>
      </Box>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor={theme.colors.lineStrong as Color}
      paddingX={1}
      flexDirection="column"
    >
      <Text color={theme.colors.warning as Color}>{title}</Text>
      {showFileList && files.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <DiffFileList files={files} selectedIndex={clampedIndex} />
        </Box>
      ) : null}
      <Box marginTop={1}>
        <DiffDetailView lines={detailLines} />
      </Box>
    </Box>
  );
};

export default DiffDialog;
