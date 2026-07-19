import { useCallback, useState } from "react";

import { Box, Text, useInput } from "../ink.js";
import { Markdown } from "./markdown/Markdown.js";
import { getDisplayPath } from "../../utils/file.js";

export interface PlanApprovalOverlayProps {
  readonly planContent?: string;
  readonly planFilePath?: string;
  onApprove(mode: "acceptEdits" | "default"): void;
  onKeepPlanning(): void;
}

interface PlanOption {
  readonly label: string;
  readonly suffix: string;
}

const OPTIONS: readonly PlanOption[] = [
  {
    label: "yes, and auto-accept edits",
    suffix: "apply edits without prompts",
  },
  {
    label: "yes, and manually approve edits",
    suffix: "review each edit first",
  },
  {
    label: "no, keep planning",
    suffix: "stay in plan mode, refine",
  },
];

/** Rendered plan lines shown before the clamp hint kicks in. */
const PLAN_PREVIEW_LINES = 14;

/**
 * Lighter-inline plan-approval overlay. Pure presentational: all approval
 * mechanics live in the container (PlanApprovalContainer in
 * permission-requests.tsx). The three options map to one mechanism — both
 * approve choices call onApprove with a permission mode; keep-planning calls
 * onKeepPlanning, which the container turns into a revise approval so the tool
 * stays in plan mode.
 */
export function PlanApprovalOverlay({
  planContent,
  planFilePath,
  onApprove,
  onKeepPlanning,
}: PlanApprovalOverlayProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  // The plan can run 100+ rendered lines; dumping it whole pushes the
  // approval options off-screen (the "unstructured wall of text" complaint).
  // Clamp the preview so the options stay visible; ctrl+o toggles the full
  // plan — the same expand idiom the transcript uses.
  const [expanded, setExpanded] = useState(false);

  const confirm = useCallback(
    (index: number): void => {
      if (index === 0) {
        onApprove("acceptEdits");
        return;
      }
      if (index === 1) {
        onApprove("default");
        return;
      }
      onKeepPlanning();
    },
    [onApprove, onKeepPlanning],
  );

  useInput((input, key, event) => {
    if (key.ctrl && input === "o") {
      event.stopImmediatePropagation();
      setExpanded((value) => !value);
      return;
    }
    if (input === "1") {
      event.stopImmediatePropagation();
      setSelectedIndex(0);
      onApprove("acceptEdits");
      return;
    }
    if (input === "2") {
      event.stopImmediatePropagation();
      setSelectedIndex(1);
      onApprove("default");
      return;
    }
    if (input === "3" || key.escape) {
      event.stopImmediatePropagation();
      setSelectedIndex(2);
      onKeepPlanning();
      return;
    }
    if (key.upArrow) {
      event.stopImmediatePropagation();
      setSelectedIndex((index) => (index + OPTIONS.length - 1) % OPTIONS.length);
      return;
    }
    if (key.downArrow) {
      event.stopImmediatePropagation();
      setSelectedIndex((index) => (index + 1) % OPTIONS.length);
      return;
    }
    if (key.return) {
      event.stopImmediatePropagation();
      confirm(selectedIndex);
    }
  });

  const hasPlan =
    typeof planContent === "string" && planContent.trim().length > 0;
  const planLineCount = hasPlan
    ? (planContent as string).split("\n").length
    : 0;
  const clamped = hasPlan && !expanded && planLineCount > PLAN_PREVIEW_LINES;

  return (
    <Box flexDirection="column" gap={0}>
      <Box>
        <Text color="planMode" bold={true}>
          plan ready for review
        </Text>
        {typeof planFilePath === "string" && planFilePath.length > 0 ? (
          <Text color="muted3">{`  saved · ${getDisplayPath(planFilePath)}`}</Text>
        ) : null}
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
        {...(clamped ? { height: PLAN_PREVIEW_LINES, overflow: "hidden" as const } : {})}
      >
        {hasPlan ? (
          <Markdown>{planContent as string}</Markdown>
        ) : (
          <Text color="muted3">(no plan content)</Text>
        )}
      </Box>
      {hasPlan && planLineCount > PLAN_PREVIEW_LINES ? (
        <Box>
          <Text color="muted3">
            {expanded
              ? `ctrl+o collapse · ${planLineCount} lines`
              : `first ${PLAN_PREVIEW_LINES} of ${planLineCount} lines · ctrl+o to expand`}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color="text2">would you like to proceed?</Text>
      </Box>
      <Box flexDirection="column">
        {OPTIONS.map((option, index) => {
          const selected = index === selectedIndex;
          const number = index + 1;
          if (selected) {
            return (
              <Box key={option.label}>
                <Text color="planMode" bold={true}>
                  {`❯ ${number}  ${option.label}`}
                </Text>
                <Text color="muted3">{`  ${option.suffix}`}</Text>
              </Box>
            );
          }
          return (
            <Box key={option.label}>
              <Text color="muted3">
                {`   ${number}  ${option.label}  ${option.suffix}`}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color="muted3">
          1·2·3 choose   ↑↓ move   ⏎ confirm   esc keep planning
        </Text>
      </Box>
    </Box>
  );
}
