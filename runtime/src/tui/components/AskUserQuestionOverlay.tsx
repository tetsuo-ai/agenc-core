import { useState } from "react";

import { Box, Text, useInput } from "../ink.js";
import type {
  AskUserQuestion,
  AskUserQuestionInput,
} from "../../tools/ask-user-question/tool.js";

export interface AskUserQuestionOverlayProps {
  readonly input: AskUserQuestionInput;
  /** Called with the merged input (original questions + collected answers). */
  onSubmit(updatedInput: unknown): void;
  /** Called when the user dismisses the picker without answering (esc). */
  onSkip(): void;
}

const OTHER_LABEL = "Other";

/**
 * Interactive picker for the AskUserQuestion permission prompt. Without this,
 * an AskUserQuestion approval falls back to the generic tool-approval card —
 * which dumps the questions as raw JSON and, when approved, records NO
 * answers, so the tool then fails with "User did not provide answers."
 * Questions are answered one at a time; every question also offers an
 * implicit "Other" free-text choice (the model is told to expect it).
 */
export function AskUserQuestionOverlay({
  input,
  onSubmit,
  onSkip,
}: AskUserQuestionOverlayProps): React.ReactElement | null {
  const questions = input.questions;
  const [questionIndex, setQuestionIndex] = useState(0);
  const [optionIndex, setOptionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [otherMode, setOtherMode] = useState(false);
  const [otherText, setOtherText] = useState("");

  const question: AskUserQuestion | undefined = questions[questionIndex];
  if (question === undefined) return null;

  const rowCount = question.options.length + 1; // + Other
  const isOther = optionIndex === question.options.length;

  const commitAnswers = (nextAnswers: Record<string, string>): void => {
    if (questionIndex + 1 >= questions.length) {
      onSubmit({ ...input, answers: nextAnswers });
      return;
    }
    setAnswers(nextAnswers);
    setQuestionIndex(questionIndex + 1);
    setOptionIndex(0);
    setPicked(new Set());
    setOtherMode(false);
    setOtherText("");
  };

  const commitLabel = (label: string): void => {
    commitAnswers({ ...answers, [question.question]: label });
  };

  const confirmSelection = (): void => {
    if (isOther) {
      setOtherMode(true);
      return;
    }
    if (question.multiSelect === true) {
      const chosen = picked.size > 0 ? [...picked] : [optionIndex];
      const label = chosen
        .sort((a, b) => a - b)
        .map((index) => question.options[index]?.label)
        .filter((label): label is string => typeof label === "string")
        .join(", ");
      if (label.length > 0) commitLabel(label);
      return;
    }
    const selected = question.options[optionIndex];
    if (selected !== undefined) commitLabel(selected.label);
  };

  useInput((inputChar, key, event) => {
    event.stopImmediatePropagation();
    if (otherMode) {
      if (key.return) {
        const text = otherText.trim();
        if (text.length > 0) commitLabel(text);
        return;
      }
      if (key.escape) {
        setOtherMode(false);
        setOtherText("");
        return;
      }
      if (key.backspace || key.delete) {
        setOtherText((value) => value.slice(0, -1));
        return;
      }
      if (inputChar.length > 0 && !key.ctrl && !key.meta) {
        setOtherText((value) => value + inputChar);
      }
      return;
    }
    if (key.escape) {
      onSkip();
      return;
    }
    if (key.upArrow) {
      setOptionIndex((index) => (index + rowCount - 1) % rowCount);
      return;
    }
    if (key.downArrow) {
      setOptionIndex((index) => (index + 1) % rowCount);
      return;
    }
    if (question.multiSelect === true && inputChar === " ") {
      setPicked((previous) => {
        const next = new Set(previous);
        if (next.has(optionIndex)) {
          next.delete(optionIndex);
        } else {
          next.add(optionIndex);
        }
        return next;
      });
      return;
    }
    if (key.return) {
      confirmSelection();
      return;
    }
    const digit = Number.parseInt(inputChar, 10);
    if (Number.isInteger(digit) && digit >= 1 && digit <= rowCount) {
      const index = digit - 1;
      setOptionIndex(index);
      if (index === question.options.length) {
        setOtherMode(true);
        return;
      }
      if (question.multiSelect === true) {
        setPicked((previous) => new Set([...previous, index]));
        return;
      }
      const selected = question.options[index];
      if (selected !== undefined) commitLabel(selected.label);
    }
  });

  return (
    <Box flexDirection="column" gap={0}>
      <Box>
        <Text color="planMode" bold={true}>
          {question.header}
        </Text>
        {questions.length > 1 ? (
          <Text color="muted3">{`  question ${questionIndex + 1} of ${questions.length}`}</Text>
        ) : null}
      </Box>
      <Box marginBottom={1}>
        <Text color="text2" bold={true}>
          {question.question}
        </Text>
      </Box>
      <Box
        flexDirection="column"
        borderStyle="single"
        borderLeft={true}
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor="planMode"
        paddingLeft={1}
      >
        {question.options.map((option, index) => {
          const selected = index === optionIndex;
          const marked = picked.has(index);
          const rawDetail = option.preview ?? option.description;
          // The description falls back to the label (label-only options are
          // the common Grok shape) — don't render a detail that just repeats
          // the label next to itself.
          const detail = rawDetail !== option.label ? rawDetail : "";
          const marker =
            question.multiSelect === true ? (marked ? "[x] " : "[ ] ") : selected ? "❯ " : "  ";
          const rowText = `${marker}${index + 1}  ${option.label}`;
          const detailText = detail.length > 0 ? `  ${detail}` : "";
          return (
            <Box key={option.label}>
              {selected ? (
                <Text color="planMode" bold={true}>
                  {rowText}
                  <Text color="text2" bold={false}>
                    {detailText}
                  </Text>
                </Text>
              ) : (
                <Text color="text2">
                  {rowText}
                  <Text color="muted3">{detailText}</Text>
                </Text>
              )}
            </Box>
          );
        })}
        {isOther ? (
          <Box flexDirection="column">
            <Box>
              <Text color="planMode" bold={true}>{`❯ ${rowCount}  ${OTHER_LABEL}`}</Text>
            </Box>
            <Box paddingLeft={4}>
              {otherMode ? (
                <Text color="text2">{`› ${otherText}▏`}</Text>
              ) : (
                <Text color="muted3">type a custom answer</Text>
              )}
            </Box>
          </Box>
        ) : (
          <Box>
            <Text color="muted3">{`   ${rowCount}  ${OTHER_LABEL}  type a custom answer`}</Text>
          </Box>
        )}
      </Box>
      <Box marginTop={1}>
        <Text color="muted3">
          {otherMode
            ? "⏎ submit answer   esc back"
            : question.multiSelect === true
              ? "space toggle · ⏎ confirm · ↑↓ move · esc skip"
              : "1-4 choose · ↑↓ move · ⏎ confirm · esc skip"}
        </Text>
      </Box>
    </Box>
  );
}
