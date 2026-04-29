/**
 * MessageSelector — pick a prior user prompt to rewind / restore to.
 *
 * Adapted from upstream's `components/MessageSelector.tsx`.
 *
 * AgenC adaptations
 * -----------------
 *   - Upstream took the upstream `Message[]` content-block-array shape
 *     and the `AppState.fileHistory` snapshot store. AgenC's transcript
 *     reducer collapses everything to flat `TranscriptMessage` rows and
 *     does not expose a file-history surface yet, so this port:
 *       * accepts the AgenC `TranscriptMessage[]` array directly
 *       * filters to `kind === "user"` rows (the only "rewindable" kind
 *         today)
 *       * drops the file-history "restore code" branch entirely; the only
 *         restore option offered is "Restore conversation". `onRestoreCode`
 *         and `onSummarize` props are still accepted so the lead can wire
 *         them when the matching reducer surfaces ship.
 *   - Keybindings: upstream bound `messageSelector:up/down/top/bottom/select`
 *     in its own context. AgenC's `defaultBindings.ts` has only
 *     `global / chat / modal / transcript` contexts; this component falls
 *     back to `useInput` for arrow / `j/k` / Enter handling so it works in
 *     the existing context surface without expanding the binding map.
 *   - Analytics events from upstream are dropped — AgenC has no equivalent
 *     `logEvent` surface today.
 *   - Theme keys remapped per the port contract (`suggestion → accent`,
 *     `permission → accent`, `inactive → dim`).
 *
 * @module
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import useInput from "../ink/hooks/use-input.js";
import { glyphs } from "../design-system/glyphs.js";
import { Divider } from "../design-system/Divider.js";
import { Spinner } from "../design-system/Spinner.js";
import {
  Select,
  type OptionWithDescription,
} from "../design-system/CustomSelect/index.js";
import { theme } from "../theme.js";
import type { TranscriptMessage } from "./MessageList.js";

const MAX_VISIBLE_MESSAGES = 7;

type RestoreOption =
  | "conversation"
  | "summarize"
  | "summarize_up_to"
  | "nevermind";

function isSummarizeOption(
  value: RestoreOption | null,
): value is "summarize" | "summarize_up_to" {
  return value === "summarize" || value === "summarize_up_to";
}

function selectableUserMessages(
  messages: readonly TranscriptMessage[],
): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const message of messages) {
    if (message.kind !== "user") continue;
    if (typeof message.content !== "string" || message.content.trim().length === 0) {
      continue;
    }
    out.push(message);
  }
  return out;
}

function previewText(input: string, maxColumns: number): string {
  const trimmed = input.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxColumns) return trimmed;
  return `${trimmed.slice(0, Math.max(1, maxColumns - 1))}…`;
}

export interface MessageSelectorProps {
  readonly messages: readonly TranscriptMessage[];
  readonly onPreRestore?: () => void;
  readonly onRestoreMessage: (message: TranscriptMessage) => Promise<void>;
  readonly onRestoreCode?: (message: TranscriptMessage) => Promise<void>;
  readonly onSummarize?: (
    message: TranscriptMessage,
    feedback: string | undefined,
    direction: "from" | "up_to",
  ) => Promise<void>;
  readonly onClose: () => void;
  /** Skip pick-list, land on confirm. Caller ran skip-check first. */
  readonly preselectedMessage?: TranscriptMessage;
  /** Width hint used to truncate prompt previews. */
  readonly columns?: number;
}

export function MessageSelector({
  messages,
  onPreRestore,
  onRestoreMessage,
  onRestoreCode,
  onSummarize,
  onClose,
  preselectedMessage,
  columns = 80,
}: MessageSelectorProps): React.ReactElement {
  void onRestoreCode; // file-history restore is a future-tranche surface

  const [error, setError] = useState<string | undefined>(undefined);
  const userMessages = useMemo(
    () => selectableUserMessages(messages),
    [messages],
  );
  const [selectedIndex, setSelectedIndex] = useState<number>(
    Math.max(0, userMessages.length - 1),
  );
  const [messageToRestore, setMessageToRestore] = useState<
    TranscriptMessage | undefined
  >(preselectedMessage);
  const [isRestoring, setIsRestoring] = useState<boolean>(false);
  const [restoringOption, setRestoringOption] = useState<RestoreOption | null>(
    null,
  );
  const [summarizeFeedbackFrom, setSummarizeFeedbackFrom] = useState("");
  const [summarizeFeedbackUpTo, setSummarizeFeedbackUpTo] = useState("");

  const hasMessagesToSelect = userMessages.length > 0;
  const firstVisibleIndex = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(MAX_VISIBLE_MESSAGES / 2),
      userMessages.length - MAX_VISIBLE_MESSAGES,
    ),
  );

  // Build the list of restore options. Code-restore is suppressed for now
  // (no file-history surface in AgenC). Summarize-up-to is gated on whether
  // the consumer wired `onSummarize`.
  const restoreOptions = useMemo<OptionWithDescription<RestoreOption>[]>(
    () => {
      const baseOptions: OptionWithDescription<RestoreOption>[] = [
        { value: "conversation", label: "Restore conversation" },
      ];
      if (onSummarize) {
        const summarizeInputProps = {
          type: "input" as const,
          placeholder: "add context (optional)",
          initialValue: "",
          allowEmptySubmitToCancel: true,
          showLabelWithValue: true,
          labelValueSeparator: ": ",
        };
        baseOptions.push({
          value: "summarize",
          label: "Summarize from here",
          ...summarizeInputProps,
          onChange: setSummarizeFeedbackFrom,
        });
        baseOptions.push({
          value: "summarize_up_to",
          label: "Summarize up to here",
          ...summarizeInputProps,
          onChange: setSummarizeFeedbackUpTo,
        });
      }
      baseOptions.push({ value: "nevermind", label: "Never mind" });
      return baseOptions;
    },
    [onSummarize],
  );

  const restoreConversationDirectly = useCallback(
    async (message: TranscriptMessage): Promise<void> => {
      onPreRestore?.();
      setIsRestoring(true);
      try {
        await onRestoreMessage(message);
        setIsRestoring(false);
        onClose();
      } catch (err) {
        setIsRestoring(false);
        setError(`Failed to restore the conversation:\n${String(err)}`);
      }
    },
    [onClose, onPreRestore, onRestoreMessage],
  );

  const handleSelect = useCallback(
    async (message: TranscriptMessage): Promise<void> => {
      if (!userMessages.includes(message)) {
        onClose();
        return;
      }
      // No file-history surface yet — go straight to restore-conversation
      // confirmation instead of an intermediate code/conversation prompt.
      setMessageToRestore(message);
    },
    [onClose, userMessages],
  );

  const onSelectRestoreOption = useCallback(
    async (option: RestoreOption): Promise<void> => {
      if (!messageToRestore) {
        setError("Message not found.");
        return;
      }
      if (option === "nevermind") {
        if (preselectedMessage) onClose();
        else setMessageToRestore(undefined);
        return;
      }
      if (isSummarizeOption(option) && onSummarize) {
        onPreRestore?.();
        setIsRestoring(true);
        setRestoringOption(option);
        setError(undefined);
        try {
          const direction = option === "summarize_up_to" ? "up_to" : "from";
          const feedback =
            (direction === "up_to"
              ? summarizeFeedbackUpTo
              : summarizeFeedbackFrom
            ).trim() || undefined;
          await onSummarize(messageToRestore, feedback, direction);
          setIsRestoring(false);
          setRestoringOption(null);
          setMessageToRestore(undefined);
          onClose();
        } catch (err) {
          setIsRestoring(false);
          setRestoringOption(null);
          setMessageToRestore(undefined);
          setError(`Failed to summarize:\n${String(err)}`);
        }
        return;
      }
      // option === "conversation"
      await restoreConversationDirectly(messageToRestore);
    },
    [
      messageToRestore,
      onClose,
      onPreRestore,
      onSummarize,
      preselectedMessage,
      restoreConversationDirectly,
      summarizeFeedbackFrom,
      summarizeFeedbackUpTo,
    ],
  );

  // Keyboard navigation. Lives outside the global keybinding map because
  // AgenC's `defaultBindings.ts` does not have a `messageSelector` context
  // surface today.
  const handleEscape = useCallback((): void => {
    if (messageToRestore && !preselectedMessage) {
      setMessageToRestore(undefined);
      return;
    }
    onClose();
  }, [messageToRestore, onClose, preselectedMessage]);

  useInput(
    (input, key) => {
      if (isRestoring || messageToRestore || error) return;
      if (key.escape) {
        handleEscape();
        return;
      }
      if (key.upArrow || input === "k") {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setSelectedIndex((prev) =>
          Math.min(userMessages.length - 1, prev + 1),
        );
        return;
      }
      if (input === "g") {
        setSelectedIndex(0);
        return;
      }
      if (input === "G") {
        setSelectedIndex(userMessages.length - 1);
        return;
      }
      if (key.return) {
        const target = userMessages[selectedIndex];
        if (target) void handleSelect(target);
      }
    },
    { isActive: hasMessagesToSelect && !preselectedMessage },
  );

  useEffect(() => {
    if (!preselectedMessage) return;
    setMessageToRestore(preselectedMessage);
  }, [preselectedMessage]);

  const showPickList =
    !error && !messageToRestore && !preselectedMessage && hasMessagesToSelect;

  return (
    <Box flexDirection="column" width="100%">
      <Divider color="accent" />
      <Box flexDirection="column" marginX={1} gap={1}>
        <Text bold color={theme.colors.accent}>
          Rewind
        </Text>

        {error ? (
          <Text color={theme.colors.error}>Error: {error}</Text>
        ) : null}

        {!hasMessagesToSelect ? (
          <Text>Nothing to rewind to yet.</Text>
        ) : null}

        {!error && messageToRestore && hasMessagesToSelect ? (
          <Box flexDirection="column" gap={1}>
            <Text>
              Confirm you want to restore the conversation to the point before
              you sent this message:
            </Text>
            <Box
              flexDirection="column"
              paddingLeft={1}
              borderStyle="single"
              borderRight={false}
              borderTop={false}
              borderBottom={false}
              borderLeft
              borderLeftDimColor
            >
              <Text>{previewText(messageToRestore.content, columns - 4)}</Text>
            </Box>
            {isRestoring && isSummarizeOption(restoringOption) ? (
              <Box flexDirection="row" gap={1}>
                <Spinner />
                <Text>Summarizing…</Text>
              </Box>
            ) : (
              <Select<RestoreOption>
                isDisabled={isRestoring}
                options={restoreOptions}
                defaultFocusValue="conversation"
                onChange={(value) => {
                  void onSelectRestoreOption(value);
                }}
                onCancel={() =>
                  preselectedMessage ? onClose() : setMessageToRestore(undefined)
                }
              />
            )}
          </Box>
        ) : null}

        {showPickList ? (
          <Box flexDirection="column" width="100%">
            <Text>Restore the conversation to the point before…</Text>
            <Box flexDirection="column" width="100%">
              {userMessages
                .slice(firstVisibleIndex, firstVisibleIndex + MAX_VISIBLE_MESSAGES)
                .map((message, visibleOptionIndex) => {
                  const optionIndex = firstVisibleIndex + visibleOptionIndex;
                  const isSelected = optionIndex === selectedIndex;
                  return (
                    <Box
                      key={message.id}
                      height={2}
                      overflow="hidden"
                      width="100%"
                      flexDirection="row"
                    >
                      <Box width={2} minWidth={2}>
                        {isSelected ? (
                          <Text color={theme.colors.accent} bold>
                            {glyphs.pointer}{" "}
                          </Text>
                        ) : (
                          <Text>{"  "}</Text>
                        )}
                      </Box>
                      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                        <Box flexShrink={1} height={1} overflow="hidden">
                          <Text
                            color={
                              isSelected ? theme.colors.accent : undefined
                            }
                          >
                            {previewText(message.content, columns - 6)}
                          </Text>
                        </Box>
                      </Box>
                    </Box>
                  );
                })}
            </Box>
          </Box>
        ) : null}

        {!messageToRestore ? (
          <Text color={theme.colors.dim} italic>
            {!error && hasMessagesToSelect ? "Enter to continue · " : ""}
            Esc to exit
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

export default MessageSelector;
