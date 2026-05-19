import React from "react";

import { Box, Text } from "../ink.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { stringWidth } from "../ink/stringWidth.js";
import wrapText from "../ink/wrap-text.js";
import {
  effectiveRealtimeMicrophoneMuted,
  realtimeLevelBar,
  type RealtimeTuiState,
} from "./state.js";

export interface RealtimePanelProps {
  readonly state: RealtimeTuiState;
}

export interface RealtimeStatusRenderParts {
  readonly statusText: string;
  readonly meterText: string | null;
}

function realtimeStatusText(state: RealtimeTuiState): string {
  const micMuted = effectiveRealtimeMicrophoneMuted(state);
  return [
    "voice",
    state.phase,
    state.transport ?? "idle",
    state.realtimeSessionId,
    micMuted ? "mic muted" : "mic live",
    state.pushToTalk ? (state.pushToTalkHeld ? "ptt held" : "ptt armed") : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" | ");
}

export function getRealtimeStatusRenderParts(
  state: RealtimeTuiState,
  columns: number,
): RealtimeStatusRenderParts {
  const safeColumns = Number.isFinite(columns)
    ? Math.max(0, Math.floor(columns))
    : 0;
  if (safeColumns === 0) {
    return { statusText: "", meterText: null };
  }

  const statusText = realtimeStatusText(state);
  const meterText = ` [${realtimeLevelBar(state.localAudioLevel)}]`;
  const fullLine = `${statusText}${meterText}`;
  if (stringWidth(fullLine) <= safeColumns) {
    return { statusText, meterText };
  }

  const meterWidth = stringWidth(meterText);
  if (safeColumns > meterWidth) {
    return {
      statusText: wrapText(statusText, safeColumns - meterWidth, "truncate"),
      meterText,
    };
  }

  return {
    statusText: wrapText(fullLine, safeColumns, "truncate"),
    meterText: null,
  };
}

export function RealtimePanel({ state }: RealtimePanelProps): React.ReactElement | null {
  const { columns } = useTerminalSize();
  if (
    state.phase === "inactive" &&
    state.errorBanner === null &&
    state.closedBanner === null
  ) {
    return null;
  }
  const status = getRealtimeStatusRenderParts(state, columns);

  return (
    <Box flexDirection="column" width="100%" marginTop={1}>
      <Box>
        <Text bold wrap="truncate">
          {status.statusText}
        </Text>
        {status.meterText !== null ? <Text dimColor>{status.meterText}</Text> : null}
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
