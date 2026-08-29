// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import React from 'react';
import { useFullscreenMode } from '../context/fullscreenModeContext.js';
import { Box } from '../ink.js';
import { BashTool } from '../../tools/BashTool/BashTool';
import type { ShellProgress } from '../../types/tools';
import { escapeXml } from '../../utils/xml.js';
import { ShellInputMessage } from './v2/messagePrimitives.js';
import { ShellProgressMessage } from './shell/ShellProgressMessage';
type Props = {
  input: string;
  progress: ShellProgress | null;
  verbose: boolean;
};
export function BashModeProgress({
  input,
  progress,
  verbose,
}: Props): React.ReactNode {
  const fullscreen = useFullscreenMode();
  const shellInput = `<bash-input>${escapeXml(input)}</bash-input>`;
  const progressMessage = progress ? (
    <ShellProgressMessage
      fullOutput={progress.fullOutput}
      output={progress.output}
      elapsedTimeSeconds={progress.elapsedTimeSeconds}
      totalLines={progress.totalLines}
      verbose={verbose}
    />
  ) : (
    BashTool.renderToolUseProgressMessage?.([], {
      fullscreen,
      verbose,
      tools: [],
      terminalSize: undefined,
    })
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      <ShellInputMessage
        addMargin={false}
        param={{ text: shellInput, type: 'text' }}
      />
      {progressMessage}
    </Box>
  );
}
