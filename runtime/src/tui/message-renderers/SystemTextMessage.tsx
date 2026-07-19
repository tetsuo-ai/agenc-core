// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { Box, Text } from '../ink.js';
import { feature } from 'bun:bundle';
import * as React from 'react';
import { useState } from 'react';
import sample from 'lodash-es/sample.js';
import { BLACK_CIRCLE, REFERENCE_MARK, TEARDROP_ASTERISK } from '../../constants/figures.js';
import figures from 'figures';
import { basename } from 'path';
import { MessageResponse } from '../components/MessageResponse';
import { FilePathLink } from '../components/FilePathLink';
import { openPath } from '../../utils/browser.js';
import * as teamMemSavedModule from './teamMemSaved';
const teamMemSaved = feature('TEAMMEM') ? teamMemSavedModule : null;
import { TURN_COMPLETION_VERBS } from '../../constants/turnCompletionVerbs.js';
import { useContentWidth } from '../context/contentWidthContext.js';
import { useTerminalSize } from '../hooks/useTerminalSize';
import type { SystemMessage, SystemStopHookSummaryMessage, SystemBridgeStatusMessage, SystemTurnDurationMessage, SystemMemorySavedMessage } from '../../types/message';
import { SystemAPIErrorMessage } from '../components/SystemAPIErrorMessage.js';
import { formatDuration, formatNumber, formatSecondsShort } from '../../utils/format.js';
import { HOOK_TIMING_DISPLAY_THRESHOLD_MS } from '../../tools/hooks.js';
import { getGlobalConfig } from '../../utils/config.js';
import Link from '../ink/components/Link.js';
import ThemedText from '../components/design-system/ThemedText';
import { CtrlOToExpand } from '../components/CtrlOToExpand';
import { useAppStateStore } from '../state/AppState.js';
import { isBackgroundTask, type TaskState } from '../../tasks/types';
import { getPillLabel } from '../../tasks/pillLabel';
import { useSelectedMessageBg } from '../components/messageActions';
import { AGENT_MESSAGE_THEME_COLOR } from '../message-theme.js';
import { ProtocolEvent } from '../components/v2/primitives.js';
type Props = {
  message: SystemMessage;
  addMargin: boolean;
  verbose: boolean;
  isTranscriptMode?: boolean;
};

export function getSystemMessageContentWidth(columns: number): number {
  return Math.max(1, columns - 10);
}

export function formatHookDuration(durationMs: number | undefined): string {
  return durationMs !== undefined && durationMs > 0 ? ` (${formatSecondsShort(durationMs)})` : "";
}

export function getStopHookTotalDurationMs(message: SystemStopHookSummaryMessage): number {
  return message.totalDurationMs ?? message.hookInfos.reduce(_temp, 0);
}

export function shouldRenderStopHookSummary(message: SystemStopHookSummaryMessage, totalDurationMs = getStopHookTotalDurationMs(message)): boolean {
  if (message.hookErrors.length > 0 || message.preventedContinuation || message.hookLabel) {
    return true;
  }
  return totalDurationMs > HOOK_TIMING_DISPLAY_THRESHOLD_MS;
}

export function SystemTextMessage({
  message,
  addMargin,
  verbose,
  isTranscriptMode,
}: Props): React.ReactNode {
  const bg = useSelectedMessageBg();
  if (message.subtype === "protocol_event") {
    return <ProtocolEventSystemMessage message={message} addMargin={addMargin} />;
  }
  if (message.subtype === "turn_duration") {
    return <TurnDurationMessage message={message} addMargin={addMargin} />;
  }
  if (message.subtype === "memory_saved") {
    return <MemorySavedMessage message={message} addMargin={addMargin} />;
  }
  if (message.subtype === "away_summary") {
    return (
      <Box flexDirection="row" marginTop={addMargin ? 1 : 0} backgroundColor={bg} width="100%">
        <Box minWidth={2}>
          <Text dimColor={true}>{REFERENCE_MARK}</Text>
        </Box>
        <Text dimColor={true}>{message.content}</Text>
      </Box>
    );
  }
  if (message.subtype === "agents_killed") {
    return (
      <Box flexDirection="row" marginTop={addMargin ? 1 : 0} backgroundColor={bg} width="100%">
        <Box minWidth={2}>
          <Text color="error">{BLACK_CIRCLE}</Text>
        </Box>
        <Text dimColor={true}>All background agents stopped</Text>
      </Box>
    );
  }
  if (message.subtype === "collab_agent") {
    return <CollabAgentSystemMessage message={message} addMargin={addMargin} />;
  }
  if (message.subtype === "thinking") {
    return null;
  }
  if (message.subtype === "bridge_status") {
    return <BridgeStatusMessage message={message} addMargin={addMargin} />;
  }
  if (message.subtype === "scheduled_task_fire") {
    return (
      <Box marginTop={addMargin ? 1 : 0} backgroundColor={bg} width="100%">
        <Text dimColor={true}>{TEARDROP_ASTERISK} {message.content}</Text>
      </Box>
    );
  }
  if (message.subtype === "permission_retry") {
    return (
      <Box marginTop={addMargin ? 1 : 0} backgroundColor={bg} width="100%">
        <Text dimColor={true}>{TEARDROP_ASTERISK} </Text>
        <Text>Allowed </Text>
        <Text bold={true}>{message.commands.join(", ")}</Text>
      </Box>
    );
  }
  // Phase 5 #54: previously, every info-level system message was
  // hidden in non-verbose mode (`return null`). That made the
  // transcript silent for "Context compacted", "Plan started",
  // "Realtime voice started", and the post-#50 allow-list output.
  // The policy was inverted — non-verbose mode just dims info; the
  // user can still see what happened. `--verbose` keeps the more
  // detailed rendering it had before.
  if (message.subtype === "api_error") {
    return <SystemAPIErrorMessage message={message} verbose={verbose} />;
  }
  if (message.subtype === "stop_hook_summary") {
    return (
      <StopHookSummaryMessage
        message={message}
        addMargin={addMargin}
        verbose={verbose}
        isTranscriptMode={isTranscriptMode}
      />
    );
  }
  const content = message.content;
  if (typeof content !== "string") {
    return null;
  }
  const t1 = message.level !== "info";
  // Phase 5 #55: previously only `warning` got a color — error-level
  // messages rendered in default text. The user couldn't distinguish
  // an error from a benign log line. Map `error` → `error` (red in
  // the design system) so red dots / red text actually surface.
  const t2 =
    message.level === "error"
      ? "error"
      : message.level === "warning"
        ? "warning"
        : undefined;
  const t3 = message.level === "info";
  // Verbose error dumps (provider/LLM failures with long remediation bodies)
  // are noise in the live chat: clamp them to the headline in non-verbose,
  // non-transcript mode — the full text is one ctrl+o away.
  const contentLines = content.trim().split("\n");
  const shouldClampError =
    message.level === "error" && !verbose && !isTranscriptMode &&
    (contentLines.length > 2 || content.trim().length > 300);
  const renderedContent = shouldClampError
    ? contentLines.length > 2
      ? `${contentLines[0]}\n${contentLines[1]}`
      : `${content.trim().slice(0, 300)}…`
    : content;
  return (
    <Box flexDirection="row" width="100%">
      <SystemTextMessageInner content={renderedContent} addMargin={addMargin} dot={t1} color={t2} dimColor={t3} />
      {shouldClampError ? <CtrlOToExpand /> : null}
    </Box>
  );
}
function StopHookSummaryMessage({
  message,
  addMargin,
  verbose,
  isTranscriptMode,
}: {
  message: SystemStopHookSummaryMessage;
  addMargin: boolean;
  verbose: boolean;
  isTranscriptMode?: boolean;
}): React.ReactNode {
  const bg = useSelectedMessageBg();
  const {
    hookCount,
    hookInfos,
    hookErrors,
    preventedContinuation,
    stopReason
  } = message;
  const {
    columns
  } = useTerminalSize();
  const inheritedContentWidth = useContentWidth();
  const totalDurationMs = message.totalDurationMs ?? hookInfos.reduce(_temp, 0);
  if (!shouldRenderStopHookSummary(message, totalDurationMs)) {
    return null;
  }
  const totalStr = formatHookDuration(totalDurationMs);
  if (message.hookLabel) {
    const hookNoun = hookCount === 1 ? "hook" : "hooks";
    const transcriptRows = isTranscriptMode && hookInfos.map(_temp2);
    return (
      <Box flexDirection="column" width="100%">
        <Text dimColor={true}>{"  \u23BF  "}Ran {hookCount} {message.hookLabel}{" "}{hookNoun}{totalStr}</Text>
        {transcriptRows}
      </Box>
    );
  }
  const marginTop = addMargin ? 1 : 0;
  const contentWidth = getSystemMessageContentWidth(inheritedContentWidth ?? columns);
  const hookLabel = message.hookLabel ?? "stop";
  const hookNoun = hookCount === 1 ? "hook" : "hooks";
  const compactExpandHint = !verbose && hookInfos.length > 0 && <>{" "}<CtrlOToExpand /></>;
  const verboseRows = verbose && hookInfos.length > 0 && hookInfos.map(_temp3);
  const stopReasonRow = preventedContinuation && stopReason && (
    <Text>
      <Text dimColor={true}>⎿  </Text>
      {stopReason}
    </Text>
  );
  const errorRows = hookErrors.length > 0 && hookErrors.map((err, idx_1) => (
    <Text key={idx_1}>
      <Text dimColor={true}>⎿  </Text>
      {message.hookLabel ?? "Stop"} hook error: {err}
    </Text>
  ));

  return (
    <Box flexDirection="row" marginTop={marginTop} backgroundColor={bg} width="100%">
      <Box minWidth={2}>
        <Text>{BLACK_CIRCLE}</Text>
      </Box>
      <Box flexDirection="column" width={contentWidth}>
        <Text>Ran <Text bold={true}>{hookCount}</Text> {hookLabel}{" "}{hookNoun}{totalStr}{compactExpandHint}</Text>
        {verboseRows}
        {stopReasonRow}
        {errorRows}
      </Box>
    </Box>
  );
}
function _temp3(info_0, idx_0) {
  const durationStr_0 = formatHookDuration(info_0.durationMs);
  return <Text key={`cmd-${idx_0}`} dimColor={true}>⎿  {info_0.command === "prompt" ? `prompt: ${info_0.promptText || ""}` : info_0.command}{durationStr_0}</Text>;
}
function _temp2(info, idx) {
  const durationStr = formatHookDuration(info.durationMs);
  return <Text key={`cmd-${idx}`} dimColor={true}>{"     \u23BF "}{info.command === "prompt" ? `prompt: ${info.promptText || ""}` : info.command}{durationStr}</Text>;
}
function _temp(sum, h) {
  return sum + (h.durationMs ?? 0);
}
function SystemTextMessageInner({
  content,
  addMargin,
  dot,
  color,
  dimColor,
}: {
  content: string;
  addMargin: boolean;
  dot: boolean;
  color: "error" | "warning" | undefined;
  dimColor: boolean;
}): React.ReactNode {
  const {
    columns
  } = useTerminalSize();
  const inheritedContentWidth = useContentWidth();
  const bg = useSelectedMessageBg();
  const marginTop = addMargin ? 1 : 0;
  const contentWidth = getSystemMessageContentWidth(inheritedContentWidth ?? columns);
  const trimmedContent = content.trim();

  return (
    <Box flexDirection="row" marginTop={marginTop} backgroundColor={bg} width="100%">
      {dot && (
        <Box minWidth={2}>
          <Text color={color} dimColor={dimColor}>{BLACK_CIRCLE}</Text>
        </Box>
      )}
      <Box flexDirection="column" width={contentWidth}>
        <Text color={color} dimColor={dimColor} wrap="wrap">{trimmedContent}</Text>
      </Box>
    </Box>
  );
}

function ProtocolEventSystemMessage({
  message,
  addMargin,
}: {
  message: SystemMessage;
  addMargin: boolean;
}): React.ReactNode {
  const bg = useSelectedMessageBg();
  const marginTop = addMargin ? 1 : 0;
  const kind =
    message.protocolKind === "claim" ||
    message.protocolKind === "settle" ||
    message.protocolKind === "slash" ||
    message.protocolKind === "stake"
      ? message.protocolKind
      : "claim";
  const facts = Array.isArray(message.facts)
    ? message.facts.flatMap((fact: unknown) => {
        if (!fact || typeof fact !== "object") return [];
        const record = fact as Record<string, unknown>;
        if (typeof record.label !== "string") return [];
        if (typeof record.value !== "string") return [];
        return [{ label: record.label, value: record.value }];
      })
    : [];
  return (
    <Box flexDirection="column" marginTop={marginTop} backgroundColor={bg} width="100%">
      <ProtocolEvent
        kind={kind}
        title={String(message.title ?? "protocol")}
        body={String(message.content ?? "")}
        facts={facts}
      />
    </Box>
  );
}

function CollabAgentSystemMessage({
  message,
  addMargin,
}: {
  message: SystemMessage;
  addMargin: boolean;
}): React.ReactNode {
  const bg = useSelectedMessageBg();
  const { columns } = useTerminalSize();
  const inheritedContentWidth = useContentWidth();
  const marginTop = addMargin ? 1 : 0;
  const state = message.state;
  const color =
    state === "success"
      ? "success"
      : state === "error"
        ? "error"
        : state === "running"
          ? AGENT_MESSAGE_THEME_COLOR
          : undefined;
  const details = Array.isArray(message.details) ? message.details : [];
  const width = getSystemMessageContentWidth(inheritedContentWidth ?? columns);
  return (
    <Box flexDirection="row" marginTop={marginTop} backgroundColor={bg} width="100%">
      <Box minWidth={2}>
        <Text color={color} dimColor={state === "info"}>
          {BLACK_CIRCLE}
        </Text>
      </Box>
      <Box flexDirection="column" width={width}>
        <Text color={color} bold={state === "running"}>
          {String(message.title ?? message.content ?? "Agent activity")}
        </Text>
        {details.map((detail: string, index: number) => (
          <Text key={`${index}:${detail}`} dimColor={true} wrap="wrap">
            {"⎿  "}
            {detail}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function TurnDurationMessage({
  message,
  addMargin,
}: {
  message: SystemTurnDurationMessage;
  addMargin: boolean;
}): React.ReactNode {
  const bg = useSelectedMessageBg();
  const [verb] = useState(_temp4);
  const store = useAppStateStore();
  const [backgroundTaskSummary] = useState(() => {
    const tasks = store.getState().tasks;
    const running = (Object.values(tasks ?? {}) as TaskState[]).filter(isBackgroundTask);
    return running.length > 0 ? getPillLabel(running) : null;
  });
  const showTurnDuration = getGlobalConfig().showTurnDuration ?? true;
  const duration = formatDuration(message.durationMs);
  const hasBudget = message.budgetLimit !== undefined;
  let budgetSuffix = "";
  if (hasBudget) {
    const tokens = message.budgetTokens;
    const limit = message.budgetLimit;
    const usage = tokens >= limit
      ? `${formatNumber(tokens)} used (${formatNumber(limit)} min ${figures.tick})`
      : `${formatNumber(tokens)} / ${formatNumber(limit)} (${Math.round(tokens / limit * 100)}%)`;
    const nudges = message.budgetNudges > 0 ? ` \u00B7 ${message.budgetNudges} ${message.budgetNudges === 1 ? "nudge" : "nudges"}` : "";
    budgetSuffix = `${showTurnDuration ? " \xB7 " : ""}${usage}${nudges}`;
  }
  if (!showTurnDuration && !hasBudget) {
    return null;
  }
  const turnDuration = showTurnDuration && `${verb} for ${duration}`;
  const backgroundSuffix = backgroundTaskSummary && ` \u00B7 ${backgroundTaskSummary} still running`;

  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0} backgroundColor={bg} width="100%">
      <Box minWidth={2}>
        <Text dimColor={true}>{TEARDROP_ASTERISK}</Text>
      </Box>
      <Text dimColor={true}>{turnDuration}{budgetSuffix}{backgroundSuffix}</Text>
    </Box>
  );
}
function _temp4() {
  return sample(TURN_COMPLETION_VERBS) ?? "Worked";
}
function MemorySavedMessage({
  message,
  addMargin,
}: {
  message: SystemMemorySavedMessage;
  addMargin: boolean;
}): React.ReactNode {
  const bg = useSelectedMessageBg();
  const {
    writtenPaths
  } = message;
  const team = teamMemSaved ? teamMemSaved.teamMemSavedPart(message) : null;
  const privateCount = writtenPaths.length - (team?.count ?? 0);
  const t2 = privateCount > 0 ? `${privateCount} ${privateCount === 1 ? "memory" : "memories"}` : null;
  const t3 = team?.segment;
  const parts = [t2, t3].filter(Boolean);
  const verb = message.verb ?? "Saved";
  const summary = parts.join(" \xB7 ");

  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0} backgroundColor={bg}>
      <Box flexDirection="row">
        <Box minWidth={2}>
          <Text dimColor={true}>{BLACK_CIRCLE}</Text>
        </Box>
        <Text>{verb} {summary}</Text>
      </Box>
      {writtenPaths.map(_temp5)}
    </Box>
  );
}
function _temp5(p) {
  return <MemoryFileRow key={p} path={p} />;
}
function MemoryFileRow({
  path,
}: {
  path: string;
}): React.ReactNode {
  const [hover, setHover] = useState(false);
  const open = () => void openPath(path);
  const enter = () => setHover(true);
  const leave = () => setHover(false);
  const fileName = basename(path);
  const fileLink = <FilePathLink filePath={path}>{fileName}</FilePathLink>;

  return (
    <MessageResponse>
      <Box onClick={open} onMouseEnter={enter} onMouseLeave={leave}>
        <Text dimColor={!hover} underline={hover}>{fileLink}</Text>
      </Box>
    </MessageResponse>
  );
}
function BridgeStatusMessage({
  message,
  addMargin,
}: {
  message: SystemBridgeStatusMessage;
  addMargin: boolean;
}) {
  const bg = useSelectedMessageBg();
  const { columns } = useTerminalSize();
  const inheritedContentWidth = useContentWidth();
  const marginTop = addMargin ? 1 : 0;
  const contentWidth = getSystemMessageContentWidth(inheritedContentWidth ?? columns);

  return (
    <Box flexDirection="row" marginTop={marginTop} backgroundColor={bg} width="100%">
      <Box minWidth={2} />
      <Box flexDirection="column" width={contentWidth}>
        <Text>
          <ThemedText color="suggestion">/remote-control</ThemedText> is active. Code in CLI or at
        </Text>
        <Link url={message.url}>{message.url}</Link>
        {message.upgradeNudge && <Text dimColor={true}>⎿ {message.upgradeNudge}</Text>}
      </Box>
    </Box>
  );
}
