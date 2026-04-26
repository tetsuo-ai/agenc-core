import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  parseAskUserQuestionInput,
  recordAskUserQuestionResponse,
  type AskUserQuestion,
  type AskUserQuestionAnnotation,
  type AskUserQuestionInput,
  type AskUserQuestionOption,
} from "../../tools/system/ask-user-question.js";
import Box from "../ink/components/Box.js";
import StdinContext from "../ink/components/StdinContext.js";
import Text from "../ink/components/Text.js";
import type { InputEvent } from "../ink/events/input-event.js";
import { theme } from "../theme.js";
import {
  useSetKeybindingContext,
} from "../keybindings/KeybindingContext.js";

export interface AskUserQuestionDecision {
  readonly behavior: "allow" | "deny" | "abort";
}

export interface AskUserQuestionOverlayProps {
  readonly requestId: string;
  readonly input: unknown;
  readonly onResolve: (decision: AskUserQuestionDecision) => void;
  readonly abortSignal: AbortSignal;
}

type OptionSelection = {
  readonly selected: readonly string[];
  readonly otherText?: string;
};

const OTHER_VALUE = "__other__";
const MAX_PREVIEW_LINES = 10;

function truncateLines(value: string, maxLines: number): string {
  const lines = value.split("\n");
  if (lines.length <= maxLines) return value;
  return `${lines.slice(0, maxLines).join("\n")}\n...`;
}

function optionValue(option: AskUserQuestionOption): string {
  return option.label;
}

function displaySelection(selection: OptionSelection | undefined): string {
  if (!selection || selection.selected.length === 0) return "";
  return selection.selected
    .map((value) => (value === OTHER_VALUE ? selection.otherText?.trim() || "Other" : value))
    .filter((value) => value.length > 0)
    .join(", ");
}

function answerForQuestion(selection: OptionSelection | undefined): string | null {
  const text = displaySelection(selection);
  return text.length > 0 ? text : null;
}

function hasAnswer(
  question: AskUserQuestion,
  selections: Readonly<Record<string, OptionSelection>>,
): boolean {
  return answerForQuestion(selections[question.question]) !== null;
}

function toggleValue(values: readonly string[], value: string): readonly string[] {
  return values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildAnsweredInput(
  parsed: AskUserQuestionInput,
  selections: Readonly<Record<string, OptionSelection>>,
): AskUserQuestionInput {
  const answers: Record<string, string> = {};
  const annotations: Record<string, AskUserQuestionAnnotation> = {};
  for (const question of parsed.questions) {
    const selection = selections[question.question];
    const answer = answerForQuestion(selection);
    if (answer === null) continue;
    answers[question.question] = answer;
    const selectedLabel = selection?.selected.find((value) => value !== OTHER_VALUE);
    const selectedOption = question.options.find((option) => option.label === selectedLabel);
    if (selectedOption?.preview) {
      annotations[question.question] = { preview: selectedOption.preview };
    }
    if (selection?.otherText?.trim()) {
      annotations[question.question] = {
        ...(annotations[question.question] ?? {}),
        notes: selection.otherText.trim(),
      };
    }
  }
  return {
    ...parsed,
    answers,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}

function NavigationBar({
  questions,
  index,
  selections,
}: {
  readonly questions: readonly AskUserQuestion[];
  readonly index: number;
  readonly selections: Readonly<Record<string, OptionSelection>>;
}): React.ReactElement {
  return (
    <Box>
      {questions.map((question, questionIndex) => {
        const active = questionIndex === index;
        const answered = hasAnswer(question, selections);
        const label = question.header || `Q${questionIndex + 1}`;
        return (
          <Text
            key={question.question}
            inverse={active}
            color={answered ? (theme.colors.success as never) : undefined}
          >
            {` ${answered ? "[x]" : "[ ]"} ${label} `}
          </Text>
        );
      })}
    </Box>
  );
}

export const AskUserQuestionOverlay: React.FC<AskUserQuestionOverlayProps> = ({
  requestId,
  input,
  onResolve,
  abortSignal,
}) => {
  const stdin = useContext(StdinContext);
  const parsed = useMemo(() => parseAskUserQuestionInput(input), [input]);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [selections, setSelections] = useState<Record<string, OptionSelection>>({});
  const [otherInputActive, setOtherInputActive] = useState(false);
  const resolvedRef = useRef(false);
  const setActiveContext = useSetKeybindingContext();

  const resolveOnce = useCallback(
    (decision: AskUserQuestionDecision) => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      onResolve(decision);
    },
    [onResolve],
  );

  useEffect(() => {
    setActiveContext("modal");
    return () => {
      setActiveContext("chat");
    };
  }, [setActiveContext]);

  useEffect(() => {
    if (parsed.ok) return;
    queueMicrotask(() => resolveOnce({ behavior: "deny" }));
  }, [parsed, resolveOnce]);

  useEffect(() => {
    if (abortSignal.aborted) {
      queueMicrotask(() => resolveOnce({ behavior: "abort" }));
      return;
    }
    const handler = (): void => {
      resolveOnce({ behavior: "abort" });
    };
    abortSignal.addEventListener("abort", handler);
    return () => {
      abortSignal.removeEventListener("abort", handler);
    };
  }, [abortSignal, resolveOnce]);

  const submit = useCallback(() => {
    if (!parsed.ok) {
      resolveOnce({ behavior: "deny" });
      return;
    }
    const answered = buildAnsweredInput(parsed.input, selections);
    recordAskUserQuestionResponse(requestId, answered);
    resolveOnce({ behavior: "allow" });
  }, [parsed, requestId, resolveOnce, selections]);

  useEffect(() => {
    if (!parsed.ok) return;
    const emitter = stdin.internal_eventEmitter;
    if (!emitter) return;
    const currentQuestion = parsed.input.questions[questionIndex];
    if (!currentQuestion) return;
    const options = [...currentQuestion.options.map(optionValue), OTHER_VALUE];
    const lastOptionIndex = options.length - 1;

    const updateSelection = (value: string): void => {
      setSelections((current) => {
        const previous = current[currentQuestion.question] ?? { selected: [] };
        const selected = currentQuestion.multiSelect === true
          ? toggleValue(previous.selected, value)
          : [value];
        return {
          ...current,
          [currentQuestion.question]: {
            ...previous,
            selected,
          },
        };
      });
    };

    const focusQuestion = (nextIndex: number): void => {
      setQuestionIndex(clamp(nextIndex, 0, parsed.input.questions.length - 1));
      setFocusedIndex(0);
      setOtherInputActive(false);
    };

    const listener = (event: InputEvent): void => {
      if (resolvedRef.current) return;
      const key = event.key;
      if (!key.ctrl && !key.meta && event.input === "c") {
        resolveOnce({ behavior: "abort" });
        return;
      }
      if (otherInputActive) {
        if (key.escape) {
          setOtherInputActive(false);
          return;
        }
        if (key.return) {
          updateSelection(OTHER_VALUE);
          setOtherInputActive(false);
          return;
        }
        if (key.backspace || key.delete) {
          setSelections((current) => {
            const previous = current[currentQuestion.question] ?? { selected: [OTHER_VALUE] };
            return {
              ...current,
              [currentQuestion.question]: {
                ...previous,
                selected: previous.selected.includes(OTHER_VALUE)
                  ? previous.selected
                  : [...previous.selected, OTHER_VALUE],
                otherText: (previous.otherText ?? "").slice(0, -1),
              },
            };
          });
          return;
        }
        if (
          event.input.length === 1 &&
          !key.ctrl &&
          !key.meta &&
          !key.tab
        ) {
          setSelections((current) => {
            const previous = current[currentQuestion.question] ?? { selected: [OTHER_VALUE] };
            return {
              ...current,
              [currentQuestion.question]: {
                ...previous,
                selected: previous.selected.includes(OTHER_VALUE)
                  ? previous.selected
                  : [...previous.selected, OTHER_VALUE],
                otherText: `${previous.otherText ?? ""}${event.input}`,
              },
            };
          });
        }
        return;
      }

      if (key.escape) {
        resolveOnce({ behavior: "deny" });
        return;
      }
      if (key.leftArrow || (key.shift && key.tab)) {
        focusQuestion(questionIndex - 1);
        return;
      }
      if (key.rightArrow || key.tab) {
        focusQuestion(questionIndex + 1);
        return;
      }
      if (key.upArrow || (key.ctrl && event.input === "p")) {
        setFocusedIndex((current) => clamp(current - 1, 0, lastOptionIndex + 1));
        return;
      }
      if (key.downArrow || (key.ctrl && event.input === "n")) {
        setFocusedIndex((current) => clamp(current + 1, 0, lastOptionIndex + 1));
        return;
      }
      if (!key.ctrl && !key.meta && event.input === "s") {
        submit();
        return;
      }
      if (key.return || (!key.ctrl && !key.meta && event.input === " ")) {
        if (focusedIndex === lastOptionIndex + 1) {
          submit();
          return;
        }
        const value = options[focusedIndex] ?? options[0]!;
        if (value === OTHER_VALUE) {
          setOtherInputActive(true);
          setSelections((current) => ({
            ...current,
            [currentQuestion.question]: {
              ...(current[currentQuestion.question] ?? { selected: [] }),
              selected: [OTHER_VALUE],
            },
          }));
          return;
        }
        updateSelection(value);
        if (currentQuestion.multiSelect !== true) {
          if (parsed.input.questions.length > 1) {
            focusQuestion(questionIndex + 1);
          }
        }
        return;
      }
      if (/^[1-9]$/.test(event.input)) {
        const index = Number.parseInt(event.input, 10) - 1;
        if (index >= 0 && index < options.length) {
          setFocusedIndex(index);
          const value = options[index]!;
          if (value === OTHER_VALUE) {
            setOtherInputActive(true);
          } else {
            updateSelection(value);
          }
        }
      }
    };
    emitter.on("input", listener);
    return () => {
      emitter.removeListener("input", listener);
    };
  }, [
    focusedIndex,
    otherInputActive,
    parsed,
    questionIndex,
    resolveOnce,
    stdin,
    submit,
  ]);

  if (!parsed.ok) {
    return (
      <Box borderStyle="double" borderColor={theme.colors.error as never} padding={1}>
        <Text color={theme.colors.error as never}>{`Invalid AskUserQuestion input: ${parsed.error}`}</Text>
      </Box>
    );
  }

  const questions = parsed.input.questions;
  const question = questions[questionIndex] ?? questions[0]!;
  const selection = selections[question.question];
  const optionRows = [
    ...question.options.map((option) => ({
      value: option.label,
      label: option.label,
      description: option.description,
      preview: option.preview,
    })),
    {
      value: OTHER_VALUE,
      label: "Other",
      description: "Type a custom answer.",
      preview: undefined,
    },
  ];
  const focused = optionRows[focusedIndex];
  const allAnswered = questions.every((entry) => hasAnswer(entry, selections));

  return (
    <Box
      borderStyle="double"
      borderColor={theme.colors.primary as never}
      padding={1}
      flexDirection="column"
    >
      <Text color={theme.colors.warning as never}>Answer questions</Text>
      <NavigationBar
        questions={questions}
        index={questionIndex}
        selections={selections}
      />
      <Box marginTop={1} flexDirection="column">
        <Text bold>{question.question}</Text>
        {optionRows.map((option, index) => {
          const active = focusedIndex === index;
          const selected = selection?.selected.includes(option.value) === true;
          return (
            <Box key={option.value} flexDirection="column">
              <Text
                color={
                  active
                    ? (theme.colors.accent as never)
                    : selected
                      ? (theme.colors.success as never)
                      : undefined
                }
              >
                {`${active ? ">" : " "} ${index + 1}. ${
                  question.multiSelect === true
                    ? selected
                      ? "[x]"
                      : "[ ]"
                    : selected
                      ? "(*)"
                      : "( )"
                } ${option.label}`}
              </Text>
              <Text dim>{`    ${option.description}`}</Text>
            </Box>
          );
        })}
        <Box marginTop={1}>
          <Text color={focusedIndex === optionRows.length ? (theme.colors.accent as never) : undefined}>
            {`${focusedIndex === optionRows.length ? ">" : " "} ${questions.length === 1 ? "Submit answers" : "Submit all answers"} ${allAnswered ? "" : "(incomplete)"}`}
          </Text>
        </Box>
      </Box>
      {selection?.selected.includes(OTHER_VALUE) === true ? (
        <Box marginTop={1} borderStyle="round" paddingX={1}>
          <Text color={otherInputActive ? (theme.colors.accent as never) : undefined}>
            {`Other: ${selection.otherText ?? ""}${otherInputActive ? "_" : ""}`}
          </Text>
        </Box>
      ) : null}
      {focused?.preview ? (
        <Box marginTop={1} borderStyle="round" paddingX={1} flexDirection="column">
          <Text dim>preview</Text>
          <Text>{truncateLines(focused.preview, MAX_PREVIEW_LINES)}</Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text dim>
          {otherInputActive
            ? "Type answer · Enter saves · Esc returns"
            : "Enter selects · Space toggles multi-select · arrows navigate · Tab switches question · S submits · Esc cancels"}
        </Text>
      </Box>
    </Box>
  );
};

export default AskUserQuestionOverlay;
