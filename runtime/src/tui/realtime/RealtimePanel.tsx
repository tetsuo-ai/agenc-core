import React from "react";

import { Box, Text } from "../ink.js";
import {
  effectiveRealtimeMicrophoneMuted,
  realtimeLevelBar,
  type RealtimeTuiState,
} from "./state.js";

export interface RealtimePanelProps {
  readonly state: RealtimeTuiState;
}

export function RealtimePanel({ state }: RealtimePanelProps): React.ReactElement | null {
  if (
    state.phase === "inactive" &&
    state.errorBanner === null &&
    state.closedBanner === null
  ) {
    return null;
  }
  const micMuted = effectiveRealtimeMicrophoneMuted(state);
  const status = [
    "voice",
    state.phase,
    state.transport ?? "idle",
    micMuted ? "mic muted" : "mic live",
    state.pushToTalk ? (state.pushToTalkHeld ? "ptt held" : "ptt armed") : null,
  ].filter((part): part is string => part !== null);

  return (
    <Box flexDirection="column" width="100%" marginTop={1}>
      <Box>
        <Text bold>{status.join(" | ")}</Text>
        <Text dimColor> [{realtimeLevelBar(state.localAudioLevel)}]</Text>
      </Box>
      {state.errorBanner !== null ? (
        <Text color="error">{state.errorBanner}</Text>
      ) : null}
      {state.errorBanner === null && state.closedBanner !== null ? (
        <Text dimColor>{state.closedBanner}</Text>
      ) : null}
      {state.lastTranscript !== null ? (
        <Text dimColor wrap="truncate">
          {state.lastTranscript.role}: {state.lastTranscript.text}
        </Text>
      ) : null}
      {state.lastItemSummary !== null ? (
        <Text dimColor wrap="truncate">
          item: {state.lastItemSummary}
        </Text>
      ) : null}
    </Box>
  );
}
