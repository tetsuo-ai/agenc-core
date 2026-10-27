import React, { useEffect, useState } from "react";

import { Box } from "../../ink.js";
import { compactionTokenLabel, type CompactionProgress } from "../../compaction-progress.js";
import FullWidthRow from "../design-system/FullWidthRow.js";
import ThemedText from "../design-system/ThemedText.js";

/** The normal activity-row slot, driven by real phases and an elapsed clock. */
export function CompactingStatus({ progress }: { readonly progress: CompactionProgress }): React.ReactNode {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [progress.startedAtMs]);
  const seconds = Math.max(0, Math.floor((now - progress.startedAtMs) / 1000));
  return (
    <FullWidthRow>
      <Box flexDirection="row" marginTop={1} paddingLeft={2}>
        <ThemedText color="accent">{`Compacting ${Math.floor(progress.percent)}%`}</ThemedText>
        <ThemedText color="text2">{` · ${seconds}s · ${compactionTokenLabel(progress.beforeTokens)} tokens`}</ThemedText>
      </Box>
    </FullWidthRow>
  );
}
