import React from "react";
import { Box, useInput } from "../tui/ink.js";
import TextInput from "../tui/components/TextInput.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import { TASK_BUDGET_LEVELS, taskBudgetLabel, type TaskBudgetLevel } from "../config/task-budget.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import type { SlashCommandContext, SlashCommandResult } from "./types.js";

const levels = Object.keys(TASK_BUDGET_LEVELS) as TaskBudgetLevel[];
const choices = [...levels, "custom"] as const;
/** What each choice means for the user, shown under the list. */
const BUDGET_CHOICE_DESCRIPTIONS: Record<string, string> = {
  eco: "the cheapest. Fine for small fixes and questions; long jobs stop early.",
  balanced: "the default. Enough room for most coding tasks.",
  max: "no limit. For hard or very long jobs; cost grows with the work.",
  custom: "pick your own limit per task.",
};
function BudgetMenu({ current, currentBudget, apply, close }: {
  current: number; currentBudget: () => number; apply: (choice: string) => Promise<SlashCommandResult>; close: () => void;
}) {
  const [index, setIndex] = React.useState(() => {
    const named = levels.findIndex(level => TASK_BUDGET_LEVELS[level] === current);
    return named === -1 ? levels.length : named;
  });
  const selectedIndex = React.useRef(index);
  const [message, setMessage] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [active, setActive] = React.useState(current);
  const [custom, setCustom] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [cursorOffset, setCursorOffset] = React.useState(0);
  const applyChoice = (choice: string): void => {
    if (busy) return;
    setBusy(true);
    void apply(choice).then(result => {
      setBusy(false);
      setFailed(result.kind === "error");
      setMessage(result.kind === "text" ? result.text : result.kind === "error" ? result.message : "Budget applied.");
      if (result.kind === "text") { setActive(currentBudget()); setCustom(false); }
    }, error => { setBusy(false); setFailed(true); setMessage(String(error)); });
  };
  useInput((input, key) => {
    if (busy) return;
    if (key.escape) {
      if (custom) { setCustom(false); setMessage(null); } else close();
      return;
    }
    if (custom) return;
    if (input === "q") { close(); return; }
    if (key.upArrow) {
      selectedIndex.current = previousMenuIndex(selectedIndex.current, choices.length);
      setIndex(selectedIndex.current);
    }
    if (key.downArrow) {
      selectedIndex.current = nextMenuIndex(selectedIndex.current, choices.length);
      setIndex(selectedIndex.current);
    }
    if (key.return) {
      const choice = choices[selectedIndex.current]!;
      if (choice === "custom") {
        setValue(""); setCursorOffset(0); setMessage(null); setCustom(true);
      } else applyChoice(choice);
    }
  });
  const highlighted = choices[index] ?? "custom";
  const highlightedLabel = highlighted === "custom" ? "custom" : highlighted;
  return <MenuModal title="budget" summary={`now ${taskBudgetLabel(active)}`} columns={[18, 40]} headers={["level", "limit per task"]}
    items={choices} activeIndex={index} renderRow={choice => {
      const isCustom = choice === "custom";
      const isCurrent = isCustom ? !levels.some(level => TASK_BUDGET_LEVELS[level] === active) : TASK_BUDGET_LEVELS[choice] === active;
      return [
        <ThemedText key="level" color="text">{isCustom ? "custom" : choice}{isCurrent ? " (current)" : ""}</ThemedText>,
        <ThemedText key="allowance" color="text2">{isCustom ? "your own number" : TASK_BUDGET_LEVELS[choice] === 0 ? "no limit" : `${TASK_BUDGET_LEVELS[choice].toLocaleString("en-US")} tokens`}</ThemedText>,
      ];
    }} detail={<Box flexDirection="column" gap={1}>
      <ThemedText color="text" wrap="wrap">{highlightedLabel}: {BUDGET_CHOICE_DESCRIPTIONS[highlighted]}</ThemedText>
      <ThemedText color="text2" wrap="wrap">A budget caps the tokens one task can use. Near the cap the agent wraps up and stops cleanly. Your choice applies now and to new sessions.</ThemedText>
      {custom ? <Box flexDirection="column">
        <ThemedText color="text2">Type a limit like 3000000, 3m or 500k. Use 0 for no limit.</ThemedText>
        <TextInput value={value} onChange={setValue} onSubmit={applyChoice} cursorOffset={cursorOffset} onChangeCursorOffset={setCursorOffset}
          columns={60} focus={!busy} showCursor={!busy} multiline={false} placeholder="token number" />
      </Box> : null}
      {message ? <ThemedText color={failed ? "error" : "text2"} wrap="wrap">{message}</ThemedText> : null}
    </Box>}
    footer={[{ keyName: custom ? "type" : "↑↓", label: custom ? "a number" : "choose" }, { keyName: "enter", label: "apply" }, { keyName: "esc", label: custom ? "back" : "close" }]} />;
}
export function openBudgetMenu(ctx: SlashCommandContext, current: number, apply: (choice: string) => Promise<SlashCommandResult>): boolean {
  return openLocalJsxCommand(ctx, close => <BudgetMenu current={current} currentBudget={() => ctx.session.config?.taskTokenBudget ?? current} apply={apply} close={close} />);
}
