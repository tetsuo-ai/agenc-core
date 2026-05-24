import { basename } from 'path';
import type React from 'react';

import type { MCPServerConnection } from '../../services/mcp/types.js';
import { selectAgenCTuiGlyphs } from '../glyphs.js';
import { useIdeConnectionStatus } from '../hooks/useIdeConnectionStatus.js';
import type { IDESelection } from '../hooks/useIdeSelection.js';
import { Text } from '../ink.js';

type IdeStatusIndicatorProps = {
  ideSelection: IDESelection | undefined;
  mcpClients?: MCPServerConnection[];
};

export function IdeStatusIndicator({
  ideSelection,
  mcpClients,
}: IdeStatusIndicatorProps): React.ReactNode {
  const { status: ideStatus } = useIdeConnectionStatus(mcpClients);
  const shouldShowIdeSelection =
    ideStatus === 'connected' &&
    Boolean(
      ideSelection?.filePath ||
        (ideSelection?.text && ideSelection.lineCount > 0),
    );

  if (!shouldShowIdeSelection || !ideSelection) {
    return null;
  }

  const ideSelectionGlyph = selectAgenCTuiGlyphs().ideSelection;

  if (ideSelection.text && ideSelection.lineCount > 0) {
    const lineLabel = ideSelection.lineCount === 1 ? 'line' : 'lines';

    return (
      <Text color="ide" key="selection-indicator" wrap="truncate">
        {ideSelectionGlyph} {ideSelection.lineCount} {lineLabel} selected
      </Text>
    );
  }

  return (
    <Text color="ide" key="selection-indicator" wrap="truncate">
      {ideSelectionGlyph} In {basename(ideSelection.filePath ?? '')}
    </Text>
  );
}
