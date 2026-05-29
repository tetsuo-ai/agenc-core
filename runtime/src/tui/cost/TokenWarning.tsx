// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { feature } from 'bun:bundle';
import * as React from 'react';
import { Box, Text } from '../ink.js';
import { calculateTokenWarningState, getEffectiveContextWindowSize, isAutoCompactEnabled } from '../../services/compact/autoCompact.js';
import { useCompactWarningSuppression } from '../../services/compact/compactWarningHook.js';
import { getUpgradeMessage } from '../../utils/model/contextWindowUpgradeCheck.js';
import { isContextCollapseEnabled } from '../../services/contextCollapse/index.js';
type Props = {
  tokenUsage: number;
  model: string;
};
export function TokenWarning({
  tokenUsage,
  model
}: Props): React.ReactElement | null {
  const {
    percentLeft,
    isAboveWarningThreshold,
    isAboveErrorThreshold
  } = calculateTokenWarningState(tokenUsage, model);
  const suppressWarning = useCompactWarningSuppression();
  if (!isAboveWarningThreshold || suppressWarning) {
    return null;
  }
  const showAutoCompactWarning = isAutoCompactEnabled();
  const upgradeMessage = getUpgradeMessage("warning");
  let displayPercentLeft = percentLeft;
  let reactiveOnlyMode = false;
  let collapseMode = false;
  if (feature("REACTIVE_COMPACT")) {
    if (false) {
      reactiveOnlyMode = true;
    }
  }
  if (feature("CONTEXT_COLLAPSE")) {
    if (isContextCollapseEnabled()) {
      collapseMode = true;
    }
  }
  if (reactiveOnlyMode || collapseMode) {
    const effectiveWindow = getEffectiveContextWindowSize(model);
    displayPercentLeft = Math.max(
      0,
      Math.round((effectiveWindow - tokenUsage) / effectiveWindow * 100),
    );
  }
  const autocompactLabel = reactiveOnlyMode ? `${100 - displayPercentLeft}% context used` : `${displayPercentLeft}% until auto-compact`;

  return (
    <Box flexDirection="row">
      {showAutoCompactWarning ? (
        <Text dimColor={true} wrap="truncate">
          {upgradeMessage ? `${autocompactLabel} · ${upgradeMessage}` : autocompactLabel}
        </Text>
      ) : (
        <Text color={isAboveErrorThreshold ? "error" : "warning"} wrap="truncate">
          {upgradeMessage
            ? `Context low (${percentLeft}% remaining) · ${upgradeMessage}`
            : `Context low (${percentLeft}% remaining) · Run /compact to compact & continue`}
        </Text>
      )}
    </Box>
  );
}
