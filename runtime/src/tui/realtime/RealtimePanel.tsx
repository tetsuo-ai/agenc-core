import React from "react";

import { Box, Text } from "../ink.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { stringWidth } from "../ink/stringWidth.js";
import wrapText from "../ink/wrap-text.js";
import { selectAgenCTuiGlyphs } from "../glyphs.js";
import {
  effectiveRealtimeMicrophoneMuted,
  normalizeRealtimePeak,
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
    `transport ${state.transport ?? "idle"}`,
    "voice default",
    "model realtime",
    state.phase,
    state.realtimeSessionId,
    micMuted ? "mic muted" : "mic live",
    state.pushToTalk ? (state.pushToTalkHeld ? "ptt held" : "ptt armed") : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" | ");
}

type VoiceMeterCell = {
  readonly glyph: string;
  readonly color: "success" | "worker" | "error" | "muted3";
};

function voiceMeterCells(peak: number, width = 18): readonly VoiceMeterCell[] {
  const glyphs = selectAgenCTuiGlyphs().voiceCursorBars;
  const safeWidth = Math.max(1, Math.floor(width));
  const ratio = normalizeRealtimePeak(peak) / 65_535;
  const filled = Math.round(ratio * safeWidth);
  const activeGlyphIndex = Math.max(1, Math.min(glyphs.length - 1, Math.round(ratio * (glyphs.length - 1))));
  const activeGlyph = glyphs[activeGlyphIndex] ?? "█";
  const idleGlyph = glyphs[0] ?? " ";
  return Array.from({ length: safeWidth }, (_value, index): VoiceMeterCell => ({
    glyph: index < filled ? activeGlyph : idleGlyph,
    color: index >= filled ? "muted3" : index < safeWidth * 0.55 ? "success" : index < safeWidth * 0.8 ? "worker" : "error",
  }));
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
  const micMuted = effectiveRealtimeMicrophoneMuted(state);
  const transcript = state.lastTranscript;
  const userText = transcript?.role === "user" ? transcript.text : "listening";
  const assistantText = transcript?.role === "assistant" ? transcript.text : "awaiting response";

  return (
    <Box
      flexDirection="column"
      width="100%"
      marginTop={1}
      borderStyle="single"
      borderColor="lineSoft"
      paddingX={1}
      gap={1}
    >
      <Box flexDirection="row" gap={2}>
        <Text color="agenc" bold wrap="truncate">
          transport {state.transport ?? "idle"}
        </Text>
        <Text color="text2" wrap="truncate">voice default</Text>
        <Text color="muted3" wrap="truncate">model realtime</Text>
        <Text color={micMuted ? "worker" : "success"} wrap="truncate">
          {micMuted ? "mic muted" : "mic live"}
        </Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <Text color="muted3">level</Text>
        {voiceMeterCells(state.localAudioLevel).map((cell, index) => (
          <Text key={index} color={cell.color}>{cell.glyph}</Text>
        ))}
        {status.meterText !== null ? <Text color="muted3">{status.meterText}</Text> : null}
      </Box>
      {state.errorBanner !== null ? (
        <Text color="error">{state.errorBanner}</Text>
      ) : null}
      {state.errorBanner === null && state.closedBanner !== null ? (
        <Text dimColor>{state.closedBanner}</Text>
      ) : null}
      <Box flexDirection="column">
        <Text color="muted3">you</Text>
        <Text color={transcript?.role === "user" ? "text2" : "muted3"} wrap="truncate">
          {userText}
        </Text>
      </Box>
      <Box flexDirection="column">
        <Text color="agenc">agenc</Text>
        <Text color={transcript?.role === "assistant" ? "text2" : "muted3"} wrap="truncate">
          {assistantText}
        </Text>
      </Box>
      {state.lastItemSummary !== null ? (
        <Text color="muted3" wrap="truncate">
          item: {state.lastItemSummary}
        </Text>
      ) : null}
      <Box flexDirection="row" gap={2}>
        <Text color="muted3">[space] PTT</Text>
        <Text color="muted3">[⇧ space] latch</Text>
        <Text color="muted3">[m] mute</Text>
        <Text color="muted3" wrap="truncate">{status.statusText}</Text>
      </Box>
    </Box>
  );
}
