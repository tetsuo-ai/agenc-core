import { feature } from "bun:bundle";
import * as React from "react";
import { useMemo } from "react";
import { Box } from "../../ink.js";
import { useAppState } from "../../state/AppState.js";
import type { AppState } from "../../state/AppState.js";
import {
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_NOTIFICATION_TAG,
} from "../../../constants/xml.js";
import { QueuedMessageProvider } from "../../context/QueuedMessageContext.js";
import { useCommandQueue } from "../../hooks/useCommandQueue.js";
import type {
  QueuedCommand,
  QueuedCommandOwner,
} from "../../../types/textInputTypes.js";
import {
  isQueuedCommandEditable,
  isQueuedCommandVisible,
  queuedCommandOwnedByConversation,
  queuedCommandOwnedByMount,
} from "../../../utils/messageQueueManager.js";
import { getShortcutDisplay } from "../../keybindings/shortcutFormat.js";
import {
  createUserMessage,
  EMPTY_LOOKUPS,
  normalizeMessages,
} from "../../../utils/messages.js";
import { jsonParse } from "../../../utils/slowOperations.js";
import { escapeXml } from "../../../utils/xml.js";
import { truncateToWidth } from "../../../utils/truncate.js";
import { useContentWidth } from "../../context/contentWidthContext.js";
import { useTerminalSize } from "../../hooks/useTerminalSize.js";
import { stringWidth } from "../../ink/stringWidth.js";
import { wrapAnsi } from "../../ink/wrapAnsi.js";
import ThemedText from "../design-system/ThemedText.js";
import { Message } from "../Message.js";
const EMPTY_SET = new Set<string>();

/** Rows one queued input may take in the list. A longer one ends with an ellipsis. */
const MAX_QUEUED_INPUT_ROWS = 2;
/** Queued inputs listed by number. With more, one line says how many more wait. */
const MAX_LISTED_QUEUED_INPUTS = 5;
/** The list is inset by two cells, like the transcript. */
const QUEUED_INPUTS_INSET = 2;

/** A queued input the user typed: a prompt or a shell line that can still be dropped. */
function isQueuedUserInput(cmd: QueuedCommand): boolean {
  return (
    isQueuedCommandEditable(cmd) &&
    (cmd.mode === "prompt" || cmd.mode === "bash")
  );
}

/**
 * A queued input as one line of text: line breaks and runs of spaces become
 * one space. A content block that is not text (an image, a document) is
 * named in brackets, so the user sees that an attachment waits with the
 * input before dropping or sending it.
 */
export function queuedInputText(cmd: Pick<QueuedCommand, "value" | "mode">): string {
  const value =
    typeof cmd.value === "string"
      ? cmd.value
      : (cmd.value as ReadonlyArray<{ type?: string; text?: string }>)
          .map((block) =>
            block.type === "text"
              ? (block.text ?? "")
              : `[${block.type ?? "attachment"}]`,
          )
          .join(" ");
  const text = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  return cmd.mode === "bash" ? `! ${text}` : text;
}

/**
 * The rows of the queued inputs list, without the header line.
 *
 *   1  first words of the first input, wrapped at a word boundary
 *      under its own first character…
 *   2  check now
 *
 * An input is always shown from its first character. It takes at most
 * MAX_QUEUED_INPUT_ROWS rows; a longer one is cut at the end of its last
 * row with an ellipsis, never at the start.
 */
export function formatQueuedInputRows(
  inputs: readonly string[],
  width: number,
  maxListed: number = MAX_LISTED_QUEUED_INPUTS,
): string[] {
  return formatQueuedInputEntries(inputs, width, maxListed).map(
    (row) => `${row.marker}${row.text}`,
  );
}

/** One row of the queued inputs list: the number cell (or its hang) and the text. */
export interface QueuedInputRow {
  readonly marker: string;
  readonly text: string;
  /** The closing "N more queued" row, drawn quieter than an input. */
  readonly more?: boolean;
}

/** The rows of {@link formatQueuedInputRows}, with the number cell kept apart. */
export function formatQueuedInputEntries(
  inputs: readonly string[],
  width: number,
  maxListed: number = MAX_LISTED_QUEUED_INPUTS,
): QueuedInputRow[] {
  const listed = inputs.slice(0, maxListed);
  const numberWidth = String(listed.length).length;
  const hang = " ".repeat(numberWidth + 2);
  const textWidth = Math.max(8, Math.floor(width) - hang.length);
  const rows: QueuedInputRow[] = [];
  listed.forEach((input, index) => {
    const lines = wrapAnsi(input, textWidth, { hard: true, trim: true }).split("\n");
    const shown = lines.slice(0, MAX_QUEUED_INPUT_ROWS);
    if (lines.length > MAX_QUEUED_INPUT_ROWS) {
      // Everything after the rows before the last one, cut to one row.
      let rest = input;
      for (const line of shown.slice(0, -1)) {
        rest = rest.slice(line.length).trimStart();
      }
      shown[shown.length - 1] = truncateToWidth(rest, textWidth);
    }
    shown.forEach((line, lineIndex) => {
      rows.push({
        marker:
          lineIndex === 0
            ? `${String(index + 1).padStart(numberWidth)}  `
            : hang,
        text: line,
      });
    });
  });
  const more = inputs.length - listed.length;
  if (more > 0) rows.push({ marker: hang, text: `${more} more queued`, more: true });
  return rows;
}

/**
 * Check if a command value is an idle notification that should be hidden.
 * Idle notifications are processed silently without showing to the user.
 */
function isIdleNotification(value: string): boolean {
  try {
    const parsed = jsonParse(value);
    return parsed?.type === "idle_notification";
  } catch {
    return false;
  }
}

// Maximum number of task notification lines to show
const MAX_VISIBLE_NOTIFICATIONS = 3;

/**
 * Create a synthetic overflow notification message for capped task notifications.
 */
function createOverflowNotificationMessage(count: number): string {
  return `<${TASK_NOTIFICATION_TAG}>
<${SUMMARY_TAG}>+${count} more tasks completed</${SUMMARY_TAG}>
<${STATUS_TAG}>completed</${STATUS_TAG}>
</${TASK_NOTIFICATION_TAG}>`;
}

/**
 * Process queued commands to cap task notifications at MAX_VISIBLE_NOTIFICATIONS lines.
 * Other command types are always shown in full.
 * Idle notifications are filtered out entirely.
 */
function processQueuedCommands(
  queuedCommands: QueuedCommand[],
): QueuedCommand[] {
  // Filter out idle notifications - they are processed silently
  const filteredCommands = queuedCommands.filter(
    (cmd) => typeof cmd.value !== "string" || !isIdleNotification(cmd.value),
  );

  // Separate task notifications from other commands
  const taskNotifications = filteredCommands.filter(
    (cmd) => cmd.mode === "task-notification",
  );
  const otherCommands = filteredCommands.filter(
    (cmd) => cmd.mode !== "task-notification",
  );

  // If notifications fit within limit, return all commands as-is
  if (taskNotifications.length <= MAX_VISIBLE_NOTIFICATIONS) {
    return [...otherCommands, ...taskNotifications];
  }

  // Show first (MAX_VISIBLE_NOTIFICATIONS - 1) notifications, then a summary
  const visibleNotifications = taskNotifications.slice(
    0,
    MAX_VISIBLE_NOTIFICATIONS - 1,
  );
  const overflowCount =
    taskNotifications.length - (MAX_VISIBLE_NOTIFICATIONS - 1);

  // Create synthetic overflow message
  const overflowCommand: QueuedCommand = {
    value: createOverflowNotificationMessage(overflowCount),
    mode: "task-notification",
  };
  return [...otherCommands, ...visibleNotifications, overflowCommand];
}
/** The queued commands of one TUI mount (all of them when no owner is given). */
function useOwnedQueuedCommands(
  queueOwner: QueuedCommandOwner | undefined,
): readonly QueuedCommand[] {
  const allQueuedCommands = useCommandQueue();
  return useMemo(
    () =>
      queueOwner === undefined
        ? allQueuedCommands
        : allQueuedCommands.filter(
            (command) =>
              queuedCommandOwnedByMount(command, queueOwner) ||
              queuedCommandOwnedByConversation(
                command,
                queueOwner.conversationId,
              ),
          ),
    [allQueuedCommands, queueOwner],
  );
}

/** Cells of the prompt glyph and its space ("❯ "): the queue lines up with the typed text. */
export const PROMPT_BAND_INPUT_INSET = 2;
/** The left word of the header row inside the prompt band. */
const IN_BAND_HEADER = "next";

/**
 * The inputs typed while a turn runs, inside the prompt band above the line
 * the user types on (owner pick 2026-11-14, queue option A):
 *
 *   next                                   ctrl+x backspace drops the last
 *   1  check the vbmeta flags too
 *   2  then flash boot_b, reboot into slot b and tell me if root works
 *   ────────────────────────────────────────────────────────────────────
 *   ❯ (the input line)
 *
 * The block is drawn only while something is queued, so the band grows
 * with it and returns to its usual height when the queue empties. `width`
 * is the band's inner width; the block starts under the typed text. On a
 * narrow band the hint goes first, before any entry is cut.
 */
export function PromptBandQueuedInputs({
  queueOwner,
  listAll = false,
  width,
}: {
  readonly queueOwner?: QueuedCommandOwner;
  /** List every queued input (prompts wait for a tool outcome review). */
  readonly listAll?: boolean;
  readonly width: number;
}): React.ReactNode {
  const queuedCommands = useOwnedQueuedCommands(queueOwner);
  const viewingAgent = useAppState((s: AppState) => !!s.viewingAgentTaskId);
  const blockWidth = Math.max(8, Math.floor(width) - PROMPT_BAND_INPUT_INSET);
  const rows = useMemo(
    () =>
      formatQueuedInputEntries(
        queuedCommands
          .filter((cmd) => isQueuedCommandVisible(cmd) && isQueuedUserInput(cmd))
          .map(queuedInputText),
        blockWidth - 1,
        listAll ? Number.POSITIVE_INFINITY : MAX_LISTED_QUEUED_INPUTS,
      ),
    [queuedCommands, blockWidth, listAll],
  );
  if (viewingAgent || rows.length === 0) return null;
  // The keycap is lowercased so the hint reads like the footer's hints.
  const hint = `${getShortcutDisplay("chat:dropQueuedInput", "Chat", "ctrl+x backspace").toLowerCase()} drops the last`;
  const showHint =
    stringWidth(IN_BAND_HEADER) + 2 + stringWidth(hint) <= blockWidth;
  return (
    <Box
      flexDirection="column"
      marginLeft={PROMPT_BAND_INPUT_INSET}
      width={blockWidth}
      flexShrink={0}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <ThemedText color="text2" bold>
          {IN_BAND_HEADER}
        </ThemedText>
        {showHint ? <ThemedText color="text3">{hint}</ThemedText> : null}
      </Box>
      {rows.map((row, i) => (
        <Box key={i} flexDirection="row">
          <ThemedText color="text3">{row.marker}</ThemedText>
          <ThemedText color={row.more ? "text3" : "text"} wrap="truncate-end">
            {row.text}
          </ThemedText>
        </Box>
      ))}
      <ThemedText color="subtle">{"─".repeat(blockWidth)}</ThemedText>
    </Box>
  );
}

function PromptInputQueuedCommandsImpl({
  queueOwner,
  listAll = false,
  showInputs = false,
}: {
  readonly queueOwner?: QueuedCommandOwner;
  /**
   * List every queued input, however many. Set while the prompts cannot be
   * sent (a tool outcome waits for review): the user then needs to see all
   * that wait, not the first five and a count.
   */
  readonly listAll?: boolean;
  /**
   * Also list the queued inputs here. They normally wait inside the prompt
   * band (PromptBandQueuedInputs); this is for when the prompt is hidden
   * (a permission request or another overlay owns it), so they stay in view.
   */
  readonly showInputs?: boolean;
}): React.ReactNode {
  const queuedCommands = useOwnedQueuedCommands(queueOwner);
  const viewingAgent = useAppState((s: AppState) => !!s.viewingAgentTaskId);
  // Brief layout: dim queue items + skip the paddingX (brief messages
  // already indent themselves). Gate mirrors the brief-spinner/message
  // check elsewhere — no teammate-view override needed since this
  // component early-returns when viewing a teammate.
  const useBriefLayout =
    feature("KAIROS") || feature("KAIROS_BRIEF")
      ? // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
        useAppState((s_0: AppState) => s_0.isBriefOnly)
      : false;

  const { columns } = useTerminalSize();
  const contentWidth = useContentWidth() ?? columns;
  // The inputs the user typed are listed by number. Everything else that is
  // visible in the queue (task notifications, channel messages) keeps its
  // own message rendering below.
  const queuedInputRows = useMemo(
    () =>
      showInputs
        ? formatQueuedInputRows(
            queuedCommands
              .filter((cmd) => isQueuedCommandVisible(cmd) && isQueuedUserInput(cmd))
              .map(queuedInputText),
            contentWidth - QUEUED_INPUTS_INSET - 1,
            listAll ? Number.POSITIVE_INFINITY : MAX_LISTED_QUEUED_INPUTS,
          )
        : [],
    [queuedCommands, contentWidth, listAll, showInputs],
  );

  // createUserMessage mints a fresh UUID per call; without memoization, streaming
  // re-renders defeat Message's areMessagePropsEqual (compares uuid) → flicker.
  const messages = useMemo(() => {
    if (queuedCommands.length === 0) return null;
    // task-notification is shown via useInboxNotification; most isMeta commands
    // (scheduled tasks, proactive ticks) are system-generated and hidden.
    // Channel messages are the exception — isMeta but shown so the keyboard
    // user sees what arrived.
    const visibleCommands = queuedCommands.filter(
      (cmd) => isQueuedCommandVisible(cmd) && !isQueuedUserInput(cmd),
    );
    if (visibleCommands.length === 0) return null;
    const processedCommands = processQueuedCommands(visibleCommands);
    return normalizeMessages(
      processedCommands.map((cmd) => {
        let content = cmd.value;
        if (cmd.mode === "bash" && typeof content === "string") {
          content = `<bash-input>${escapeXml(content)}</bash-input>`;
        }
        // [Image #N] placeholders are inline in the text value (inserted at
        // paste time), so the queue preview shows them without stub blocks.
        //
        // Pass an explicit empty timestamp so createUserMessage does NOT default
        // to new Date().toISOString(): the queue is a "what's next" preview, not
        // the live turn, and the per-item enqueue time isn't tracked. Defaulting
        // here mints the SAME render-time clock for every queued item (the
        // useMemo re-mints the whole list whenever one is added), so all previews
        // would show one identical machine timestamp. A quiet "queued" marker is
        // rendered in the header instead (see Msg / HighlightedThinkingText).
        return createUserMessage({
          content,
          timestamp: "",
        });
      }),
    );
  }, [queuedCommands]);

  // Don't show leader's queued commands when viewing any agent's transcript
  // Typed inputs now wait in the prompt band, so with nothing else queued
  // this draws nothing at all (not even its blank row).
  if (
    viewingAgent ||
    ((messages === null || messages.length === 0) &&
      queuedInputRows.length === 0)
  ) {
    return null;
  }
  return (
    <Box marginTop={1} flexDirection="column">
      {queuedInputRows.length > 0 && (
        // One header line, then one numbered entry per input. No band, no
        // fill and no label per entry: the header says once what the list is
        // and how to drop the last input. The "esc to interrupt" hint is not
        // repeated here; the footer shows it while a turn runs. The keycap is
        // lowercased so the line reads like the footer's hints.
        <Box marginLeft={QUEUED_INPUTS_INSET} flexDirection="column">
          <ThemedText color="text3" wrap="truncate-end">
            {`queued for next turn · ${getShortcutDisplay("chat:dropQueuedInput", "Chat", "ctrl+x backspace").toLowerCase()} drops the last`}
          </ThemedText>
          {queuedInputRows.map((row, i) => (
            <ThemedText key={i} color="text3" wrap="truncate-end">
              {row}
            </ThemedText>
          ))}
        </Box>
      )}
      {(messages ?? []).map((message, i) => (
        <QueuedMessageProvider
          key={i}
          isFirst={i === 0 && queuedInputRows.length === 0}
          useBriefLayout={useBriefLayout}
        >
          {/* One blank line between consecutive queued items (none before the
              first); without it items 2..n butt directly under the previous
              item's last body line and read as one dense block. */}
          <Message
            message={message}
            lookups={EMPTY_LOOKUPS}
            addMargin={i !== 0 || queuedInputRows.length > 0}
            tools={[]}
            commands={[]}
            verbose={false}
            inProgressToolUseIDs={EMPTY_SET}
            progressMessagesForMessage={[]}
            shouldAnimate={false}
            shouldShowDot={false}
            isTranscriptMode={false}
            isStatic={true}
          />
        </QueuedMessageProvider>
      ))}
    </Box>
  );
}
export const PromptInputQueuedCommands = React.memo(
  PromptInputQueuedCommandsImpl,
);
