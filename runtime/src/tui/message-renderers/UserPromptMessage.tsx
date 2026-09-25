import { feature } from 'bun:bundle';
import React, { useContext, useMemo } from 'react';
import { getKairosActive, getUserMsgOptIn } from '../../bootstrap/state';
import type { AgenCTextBlockParam } from '../../types/message.js';
import { Box } from '../ink.js';
import { useAppState } from '../state/AppState.js';
import { isEnvTruthy } from '../../utils/envUtils';
import { formatBriefTimestamp } from '../../utils/formatBriefTimestamp.js';
import { logError } from '../../utils/log.js';
import { countCharInString } from '../../utils/stringUtils.js';
import { selectAgenCTuiGlyphs } from '../glyphs.js';
import { MessageActionsSelectedContext } from '../components/messageActions';
import { HighlightedThinkingText } from './HighlightedThinkingText';
import { Msg } from '../components/v2/primitives.js';
type Props = {
  addMargin: boolean;
  param: AgenCTextBlockParam;
  isTranscriptMode?: boolean;
  timestamp?: string;
};

// Hard cap on displayed prompt text. Piping large files via stdin
// (e.g. `cat 11k-line-file | agenc`) creates a single user message whose
// <Text> node the fullscreen Ink renderer must wrap/output on every frame,
// causing 500ms+ keystroke latency. React.memo skips the React render but
// the Ink output pass still iterates the full mounted text. Non-fullscreen
// avoids this via <Static> (print-and-forget to terminal scrollback).
// Head+tail because `{ cat file; echo prompt; } | agenc` puts the user's
// actual question at the end.
const MAX_DISPLAY_CHARS = 10_000;
const TRUNCATE_HEAD_CHARS = 2_500;
const TRUNCATE_TAIL_CHARS = 2_500;

export function getUserPromptTruncationNotice(
  hiddenLines: number,
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): string {
  const ellipsis = selectAgenCTuiGlyphs(env).ellipsis;
  return `${ellipsis} +${hiddenLines} lines ${ellipsis}`;
}

export function truncateUserPromptDisplayText(
  text: string,
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): string {
  if (text.length <= MAX_DISPLAY_CHARS) return text;
  const head = text.slice(0, TRUNCATE_HEAD_CHARS);
  const tail = text.slice(-TRUNCATE_TAIL_CHARS);
  const hiddenLines = countCharInString(text, '\n', TRUNCATE_HEAD_CHARS) - countCharInString(tail, '\n');
  return `${head}\n${getUserPromptTruncationNotice(hiddenLines, env)}\n${tail}`;
}

export function UserPromptMessage({
  addMargin,
  param: {
    text
  },
  isTranscriptMode,
  timestamp
}: Props): React.ReactNode {
  // REPL.tsx passes isBriefOnly={viewedTeammateTask ? false : isBriefOnly}
  // but that prop isn't threaded this deep — replicate the override by
  // reading viewingAgentTaskId directly. Computed here (not in the child)
  // so the parent Box can drop its backgroundColor: in brief mode the
  // child renders a label-style layout, and Box backgroundColor paints
  // behind children unconditionally (they can't opt out).
  //
  // Hooks stay INSIDE feature() ternaries so external builds don't pay
  // the per-scrollback-message store subscription (useSyncExternalStore
  // bypasses React.memo). Runtime-gated like isBriefEnabled() but inlined
  // to avoid pulling BriefTool.ts → prompt.ts tool-name strings into
  // external builds.
  const isBriefOnly = feature('KAIROS') || feature('KAIROS_BRIEF') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useAppState(s => s.isBriefOnly) : false;
  const viewingAgentTaskId = feature('KAIROS') || feature('KAIROS_BRIEF') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useAppState(s_0 => s_0.viewingAgentTaskId) : null;
  // Hoisted to mount-time — per-message component, re-renders on every scroll.
  const briefEnvEnabled = feature('KAIROS') || feature('KAIROS_BRIEF') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useMemo(() => isEnvTruthy(process.env.AGENC_BRIEF), []) : false;
  const useBriefLayout = feature('KAIROS') || feature('KAIROS_BRIEF') ? (getKairosActive() || getUserMsgOptIn() && (briefEnvEnabled || false)) && isBriefOnly && !isTranscriptMode && !viewingAgentTaskId : false;

  // Truncate before the early return so the hook order is stable.
  const displayText = useMemo(() => {
    return truncateUserPromptDisplayText(text);
  }, [text]);
  const isSelected = useContext(MessageActionsSelectedContext);
  if (!text) {
    logError(new Error('No content found in user prompt message'));
    return null;
  }
  // width="100%" mirrors SystemTextMessage/AssistantTextMessage: without it a
  // full-width word-wrap row renders at the viewport edge with no trailing
  // background padding while sibling highlighted rows stop one column short, so
  // the bg reset spills onto the next line's column 0 and the highlight box gets
  // a ragged right edge. Pinning the width makes every wrapped row pad/clip to
  // the same right edge and the highlight forms a clean rectangle.
  return <Box flexDirection="column" width="100%" marginTop={addMargin ? 1 : 0} backgroundColor={isSelected ? 'messageActionsBackground' : useBriefLayout ? undefined : 'userMessageBackground'} paddingRight={useBriefLayout ? 0 : 1}>
      {useBriefLayout ? <HighlightedThinkingText text={displayText} useBriefLayout timestamp={timestamp} /> : <Msg role="user"><HighlightedThinkingText text={displayText} showPointer={false} /></Msg>}
    </Box>;
}
