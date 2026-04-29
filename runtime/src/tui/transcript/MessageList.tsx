/**
 * MessageList — scrolling transcript of turn events.
 *
 * Each entry in `messages` is a `TranscriptMessage` produced by the Wave
 * 4 session → transcript bridge from the T11 `turn_start` / `assistant_text`
 * / `tool_call` / `tool_result` / `turn_complete` / `warning` / `error`
 * stream. The list renders inside a Wave 1 `<ScrollBox>` with
 * sticky-follow-to-bottom behavior: if the operator has not scrolled off
 * the bottom, new messages pin the view to the latest entry; if they've
 * scrolled up, the transcript stays where they left it so incoming tool
 * output doesn't yank them forward.
 *
 * The scroll-follow decision is made against `ScrollBox`'s own
 * `isSticky()` signal. `ScrollBox` sets that flag whenever the user is
 * at the bottom or when `scrollToBottom()` runs; manual `scrollTo` /
 * `scrollBy` calls from the operator clear it. We call `scrollToBottom()`
 * on each new message only while that flag is still set — matching the
 * "do not pull me forward" expectation above.
 *
 * @module
 */

import React, { useContext, useEffect, useMemo, useRef } from "react";

import Box from "../ink/components/Box.js";
import { TerminalSizeContext } from "../ink/components/TerminalSizeContext.js";
import Text from "../ink/components/Text.js";
import ScrollBox, {
  type ScrollBoxHandle,
} from "../ink/components/ScrollBox.js";
import { useVirtualScroll } from "../hooks/useVirtualScroll.js";
import { useKeybinding } from "../keybindings/KeybindingContext.js";

import { MessageRow } from "./MessageRow.js";
import { OffscreenFreeze } from "./OffscreenFreeze.js";
import type { PlanEvent } from "./PlanProgress.js";
import { normalizeTranscriptMessages } from "./normalize.js";
import type { SlashCommandResult } from "../_deps/commands.js";

/* ────────────────────────────────────────────────────────────────────── */
/* Types                                                                   */
/* ────────────────────────────────────────────────────────────────────── */

export type TranscriptMessageKind =
  | "user"
  | "assistant"
  | "plan_progress"
  | "tool_call"
  | "tool_group"
  | "tool_result"
  | "activity"
  | "meta"
  | "warning"
  | "error"
  | "slash_result";

export interface TranscriptMessage {
  /** Stable id used as React key — usually event id or synthesized. */
  readonly id: string;
  /** Turn this message belongs to. Lets callers group by turn for search. */
  readonly turnId: string;
  readonly kind: TranscriptMessageKind;
  /** Display text. For `tool_call` this is the printable command summary. */
  readonly content: string;

  // Kind-specific fields. All optional — the dispatcher only reads what
  // it needs per kind.
  readonly toolName?: string;
  readonly toolArgs?: unknown;
  readonly isError?: boolean;
  readonly isComplete?: boolean;
  readonly label?: string;
  readonly callId?: string;
  readonly progressStream?: "stdout" | "stderr" | "status";
  readonly toolProgressContent?: string;
  readonly toolResultContent?: string;
  readonly toolResultMetadata?: Readonly<Record<string, unknown>>;
  readonly timestamp: number;
  readonly slashInput?: string;
  readonly slashResult?: SlashCommandResult;
  readonly planEvents?: readonly PlanEvent[];
  readonly groupedTools?: readonly {
    readonly id: string;
    readonly toolName: string;
    readonly target: string;
    readonly collapseTone?: "read" | "search" | "list";
    readonly content?: string;
    readonly toolArgs?: unknown;
    readonly isError?: boolean;
    readonly isComplete?: boolean;
    readonly toolProgressContent?: string;
    readonly toolResultContent?: string;
    readonly toolResultMetadata?: Readonly<Record<string, unknown>>;
    readonly execCommand?: string;
    readonly execStdout?: string;
    readonly execStderr?: string;
    readonly execExitCode?: number;
    readonly execDurationMs?: number;
    readonly execTimedOut?: boolean;
    readonly execTruncated?: boolean;
    readonly execCwdWasReset?: boolean;
    readonly execBackgroundTaskHint?: string;
    readonly execImagePaths?: readonly string[];
    readonly execNoOutputExpected?: boolean;
    readonly execReturnCodeInterpretation?: string;
    readonly execBackgroundTaskId?: string;
  }[];

  /**
   * When the message is a `tool_call` for a shell-exec tool, these
   * carry the stream output plus the resolved exit state so the row
   * can be rendered through `<ExecCell>` instead of the one-line
   * summary. All other kinds leave these undefined.
   */
  readonly execCommand?: string;
  readonly execStdout?: string;
  readonly execStderr?: string;
  readonly execExitCode?: number;
  readonly execDurationMs?: number;
  readonly execTimedOut?: boolean;
  readonly execTruncated?: boolean;
  readonly execCwdWasReset?: boolean;
  readonly execBackgroundTaskHint?: string;
  readonly execImagePaths?: readonly string[];
  readonly execNoOutputExpected?: boolean;
  readonly execReturnCodeInterpretation?: string;
  readonly execBackgroundTaskId?: string;
}

export interface MessageListProps {
  readonly messages: readonly TranscriptMessage[];
  /** True while an assistant_text stream is still landing deltas. */
  readonly isStreaming?: boolean;
  /** Show every raw row without grouping/collapse. */
  readonly verbose?: boolean;
}

/* ────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                 */
/* ────────────────────────────────────────────────────────────────────── */

const TOOL_ARGS_MAX = 80;
const USER_MESSAGE_DISPLAY_MAX = 10_000;
const USER_MESSAGE_DISPLAY_EDGE = 4_500;

function lengthOf(value: string | readonly unknown[] | undefined): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.length;
  return 0;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function fingerprintOf(
  value: string | readonly unknown[] | undefined,
): string {
  if (value === undefined) return "";
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return `${serialized.length}:${hashString(serialized)}`;
}

function metadataFingerprintOf(
  value: Readonly<Record<string, unknown>> | undefined,
): string {
  if (value === undefined) return "";
  try {
    const serialized = JSON.stringify(value);
    return `${serialized.length}:${hashString(serialized)}`;
  } catch {
    return "unserializable";
  }
}

function groupedToolsMutationKey(
  groupedTools: TranscriptMessage["groupedTools"],
): string {
  if (!groupedTools || groupedTools.length === 0) return "";
  return groupedTools
    .map((tool) =>
      [
        tool.id,
        tool.toolName,
        tool.isComplete === false ? "streaming" : "final",
        tool.isError === true ? "error" : "",
        fingerprintOf(tool.content),
        fingerprintOf(tool.toolProgressContent),
        fingerprintOf(tool.toolResultContent),
        metadataFingerprintOf(tool.toolResultMetadata),
        fingerprintOf(tool.execCommand),
        fingerprintOf(tool.execStdout),
        fingerprintOf(tool.execStderr),
        tool.execExitCode ?? "",
        tool.execDurationMs ?? "",
        tool.execTimedOut === true ? "timeout" : "",
        tool.execTruncated === true ? "truncated" : "",
        tool.execCwdWasReset === true ? "cwd-reset" : "",
        fingerprintOf(tool.execBackgroundTaskHint),
        fingerprintOf(tool.execImagePaths),
        tool.execNoOutputExpected === true ? "no-output-expected" : "",
        fingerprintOf(tool.execReturnCodeInterpretation),
        fingerprintOf(tool.execBackgroundTaskId),
      ].join("|"),
    )
    .join(";");
}

export function transcriptMutationKey(
  messages: readonly TranscriptMessage[],
  isStreaming: boolean = false,
): string {
  const tail = messages[messages.length - 1];
  if (!tail) return isStreaming ? "0:tail:1" : "0:tail:0";
  return [
    messages.length,
    tail.id,
    tail.kind,
    tail.timestamp,
    tail.isComplete === false ? "streaming" : "final",
    fingerprintOf(tail.content),
    fingerprintOf(tail.execStdout),
    fingerprintOf(tail.execStderr),
    tail.execExitCode ?? "",
    tail.execDurationMs ?? "",
    tail.execTimedOut === true ? "timeout" : "",
    tail.execTruncated === true ? "truncated" : "",
    tail.execCwdWasReset === true ? "cwd-reset" : "",
    fingerprintOf(tail.execBackgroundTaskHint),
    fingerprintOf(tail.execImagePaths),
    tail.execNoOutputExpected === true ? "no-output-expected" : "",
    fingerprintOf(tail.execReturnCodeInterpretation),
    fingerprintOf(tail.execBackgroundTaskId),
    groupedToolsMutationKey(tail.groupedTools),
    fingerprintOf(tail.toolProgressContent),
    fingerprintOf(tail.toolResultContent),
    metadataFingerprintOf(tail.toolResultMetadata),
    lengthOf(tail.planEvents),
    tail.progressStream ?? "",
    tail.label ?? "",
    tail.isError === true ? "error" : "",
    isStreaming ? "tail:1" : "tail:0",
  ].join(":");
}

/**
 * Truncate a string to `max` chars with an ellipsis suffix. Exported
 * separately only so tests can assert its behavior; this is intentionally
 * a small, boring utility.
 */
export function truncate(input: string, max: number = TOOL_ARGS_MAX): string {
  if (typeof input !== "string" || input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1))}\u2026`;
}

/**
 * Keep huge pasted prompts from becoming enormous Ink text nodes. This mirrors
 * AgenC's prompt-display cap: the runtime still receives the full prompt,
 * but the fullscreen transcript only mounts a bounded head/tail preview.
 */
export function truncateUserMessageForDisplay(input: string): string {
  if (input.length <= USER_MESSAGE_DISPLAY_MAX) return input;
  const omitted = input.length - USER_MESSAGE_DISPLAY_EDGE * 2;
  return [
    input.slice(0, USER_MESSAGE_DISPLAY_EDGE),
    `\n… ${omitted} chars omitted from displayed prompt …\n`,
    input.slice(-USER_MESSAGE_DISPLAY_EDGE),
  ].join("");
}

/* ────────────────────────────────────────────────────────────────────── */
/* Component                                                               */
/* ────────────────────────────────────────────────────────────────────── */

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  isStreaming = false,
  verbose = false,
}) => {
  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  const terminalSize = useContext(TerminalSizeContext);
  const normalizedMessages = useMemo(
    () => normalizeTranscriptMessages(messages, { verbose }),
    [messages, verbose],
  );
  // Remember whether the operator was glued to the bottom at the moment
  // the last message arrived. Using a ref here instead of state avoids
  // re-rendering the whole list on every scroll tick.
  const stickyRef = useRef<boolean>(true);
  const lastLengthRef = useRef<number>(normalizedMessages.length);
  const lastMutationKeyRef = useRef<string>(
    transcriptMutationKey(normalizedMessages, isStreaming),
  );

  // Keep the sticky flag in sync with the real ScrollBox state. `subscribe`
  // fires for imperative scrollTo/scrollBy — exactly the operator-driven
  // scroll events that should break stickiness.
  useEffect(() => {
    const handle = scrollRef.current;
    if (!handle) return;
    const update = (): void => {
      stickyRef.current = handle.isSticky();
    };
    update();
    const unsubscribe = handle.subscribe(update);
    return () => {
      unsubscribe();
    };
  }, []);

  // Follow while sticky not only on appended rows but also when the live tail
  // mutates in place (assistant streaming, exec stdout/stderr growth, plan
  // updates). This mirrors codex runtime's active-cell revision behavior: the bottom
  // stays pinned until the user explicitly scrolls away.
  useEffect(() => {
    const handle = scrollRef.current;
    if (!handle) return;
    const nextKey = transcriptMutationKey(normalizedMessages, isStreaming);
    const previousKey = lastMutationKeyRef.current;
    const previousLength = lastLengthRef.current;
    const grew = normalizedMessages.length > previousLength;
    const mutatedInPlace = previousKey !== nextKey && !grew;
    lastLengthRef.current = normalizedMessages.length;
    lastMutationKeyRef.current = nextKey;
    if (!grew && !mutatedInPlace) return;
    if (stickyRef.current || handle.isSticky()) {
      handle.scrollToBottom();
      stickyRef.current = true;
    }
  }, [isStreaming, normalizedMessages]);

  const jumpBy = (delta: number): void => {
    const handle = scrollRef.current;
    if (!handle) return;
    const max = Math.max(0, handle.getScrollHeight() - handle.getViewportHeight());
    const target = handle.getScrollTop() + handle.getPendingDelta() + delta;
    if (target >= max) {
      handle.scrollTo(max);
      handle.scrollToBottom();
      stickyRef.current = true;
      return;
    }
    handle.scrollTo(Math.max(0, target));
  };

  const pageUp = (): void => {
    const handle = scrollRef.current;
    if (!handle) return;
    jumpBy(-Math.max(1, Math.floor(handle.getViewportHeight() / 2)));
  };

  const pageDown = (): void => {
    const handle = scrollRef.current;
    if (!handle) return;
    jumpBy(Math.max(1, Math.floor(handle.getViewportHeight() / 2)));
  };

  const fullPageUp = (): void => {
    const handle = scrollRef.current;
    if (!handle) return;
    jumpBy(-Math.max(1, handle.getViewportHeight()));
  };

  const fullPageDown = (): void => {
    const handle = scrollRef.current;
    if (!handle) return;
    jumpBy(Math.max(1, handle.getViewportHeight()));
  };

  const lineUp = (): void => {
    const handle = scrollRef.current;
    if (!handle) return;
    const target = handle.getScrollTop() + handle.getPendingDelta() - 1;
    handle.scrollTo(Math.max(0, target));
  };

  const lineDown = (): void => {
    const handle = scrollRef.current;
    if (!handle) return;
    const max = Math.max(0, handle.getScrollHeight() - handle.getViewportHeight());
    const target = handle.getScrollTop() + handle.getPendingDelta() + 1;
    if (target >= max) {
      handle.scrollTo(max);
      handle.scrollToBottom();
      stickyRef.current = true;
      return;
    }
    handle.scrollTo(target);
  };

  const scrollTop = (): void => {
    const handle = scrollRef.current;
    if (!handle) return;
    handle.scrollTo(0);
  };

  const scrollBottom = (): void => {
    const handle = scrollRef.current;
    if (!handle) return;
    const max = Math.max(0, handle.getScrollHeight() - handle.getViewportHeight());
    handle.scrollTo(max);
    handle.scrollToBottom();
    stickyRef.current = true;
  };

  useKeybinding("scroll:pageUp", pageUp, "global");
  useKeybinding("scroll:pageDown", pageDown, "global");
  useKeybinding("scroll:pageUp", pageUp, "transcript");
  useKeybinding("scroll:pageDown", pageDown, "transcript");
  useKeybinding("scroll:halfPageUp", pageUp, "transcript");
  useKeybinding("scroll:halfPageDown", pageDown, "transcript");
  useKeybinding("scroll:fullPageUp", fullPageUp, "transcript");
  useKeybinding("scroll:fullPageDown", fullPageDown, "transcript");
  useKeybinding("scroll:lineUp", lineUp, "global");
  useKeybinding("scroll:lineDown", lineDown, "global");
  useKeybinding("scroll:top", scrollTop, "global");
  useKeybinding("scroll:bottom", scrollBottom, "global");
  useKeybinding("scroll:lineUp", lineUp, "transcript");
  useKeybinding("scroll:lineDown", lineDown, "transcript");
  useKeybinding("scroll:top", scrollTop, "transcript");
  useKeybinding("scroll:bottom", scrollBottom, "transcript");

  const hasInlineStreamingAssistant =
    normalizedMessages.length > 0 &&
    normalizedMessages[normalizedMessages.length - 1]?.kind === "assistant" &&
    normalizedMessages[normalizedMessages.length - 1]?.isComplete === false;
  const itemKeys = useMemo(
    () => normalizedMessages.map((message, index) => `${message.id}:${index}`),
    [normalizedMessages],
  );
  const virtual = useVirtualScroll(
    scrollRef,
    itemKeys,
    terminalSize?.columns ?? 80,
  );
  const [visibleStart, visibleEnd] = virtual.range;
  const visibleMessages = normalizedMessages.slice(visibleStart, visibleEnd);

  return (
    <ScrollBox
      ref={scrollRef}
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      width="100%"
      stickyScroll
    >
      <Box flexDirection="column" width="100%">
        {virtual.topSpacer > 0 ? (
          <Box height={Math.floor(virtual.topSpacer)} flexShrink={0} />
        ) : null}
        {visibleMessages.map((message, offset) => {
          const virtualIndex = visibleStart + offset;
          const key = itemKeys[virtualIndex] ?? message.id;
          return (
            <Box
              key={key}
              ref={virtual.measureRef(key)}
              flexDirection="column"
            >
              <OffscreenFreeze
                cacheKey={transcriptMutationKey([message], isStreaming)}
                freeze={message.isComplete !== false}
              >
                <MessageRow message={message} verbose={verbose} />
              </OffscreenFreeze>
            </Box>
          );
        })}
        {virtual.bottomSpacer > 0 ? (
          <Box height={Math.floor(virtual.bottomSpacer)} flexShrink={0} />
        ) : null}
        {isStreaming && !hasInlineStreamingAssistant ? (
          <Box flexDirection="row">
            <Text dim>{"\u2026"}</Text>
          </Box>
        ) : null}
      </Box>
    </ScrollBox>
  );
};

export default MessageList;
