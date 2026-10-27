import React, { useCallback, useContext, useRef, useState } from "react";
import useInput from "../tui/ink/hooks/use-input.js";
import { TerminalSizeContext } from "../tui/ink/components/TerminalSizeContext.js";
import { Box } from "../tui/ink.js";
import { applyTextStyles } from "../tui/ink/colorize.js";
import type { Color } from "../tui/ink/styles.js";
import { useTheme } from "../tui/components/design-system/ThemeProvider.js";
import ThemedBox from "../tui/components/design-system/ThemedBox.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { getTheme } from "../utils/theme.js";

/**
 * The one-time card shown before the first interactive session on Windows,
 * where AgenC has no sandbox yet. It is a pre-TUI startup card like the trust
 * card shown right after it (permissions/trust/TrustDialog.tsx) and uses the
 * same frame: the title sits in the border, nothing is preselected, y and n
 * answer at once.
 */
export const WINDOWS_SANDBOX_CARD_COPY = Object.freeze({
  title: "No sandbox on Windows",
  warning: "AgenC has no sandbox on Windows yet.",
  body: "If you continue, the commands and file edits you approve run with your full Windows permissions. AgenC asks before each one.",
  note: "Saved for next time. For a sandbox, run AgenC in WSL2.",
});

export interface WindowsSandboxDialogProps {
  readonly onContinue: () => void | Promise<void>;
  readonly onQuit: () => void | Promise<void>;
}

type WindowsSandboxChoice = "continue" | "quit";

const MIN_CARD_WIDTH = 44;
const MAX_CARD_WIDTH = 76;
const DEFAULT_COLUMNS = 80;

export function windowsSandboxOptionLabel(
  id: WindowsSandboxChoice,
  choice: WindowsSandboxChoice | null,
  pending: boolean,
): string {
  if (pending && choice === id) {
    return id === "continue" ? "Saving..." : "Quitting...";
  }
  return id === "continue" ? "Continue" : "Quit";
}

export function WindowsSandboxDialog(
  props: WindowsSandboxDialogProps,
): React.ReactElement {
  const terminalSize = useContext(TerminalSizeContext);
  const [themeName] = useTheme();
  const columns =
    terminalSize && Number.isFinite(terminalSize.columns)
      ? terminalSize.columns
      : DEFAULT_COLUMNS;
  const cardWidth = Math.max(
    MIN_CARD_WIDTH,
    Math.min(MAX_CARD_WIDTH, columns - 2),
  );
  const [choice, setChoice] = useState<WindowsSandboxChoice | null>(null);
  const [pending, setPending] = useState(false);
  const choiceRef = useRef<WindowsSandboxChoice | null>(null);
  const pendingRef = useRef(false);

  const select = useCallback((next: WindowsSandboxChoice | null) => {
    choiceRef.current = next;
    setChoice(next);
  }, []);

  const submit = useCallback(
    async (next: WindowsSandboxChoice | null = choiceRef.current) => {
      if (pendingRef.current || next === null) return;
      pendingRef.current = true;
      setPending(true);
      try {
        if (next === "continue") {
          await props.onContinue();
        } else {
          await props.onQuit();
        }
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [props],
  );

  useInput((input, key) => {
    if (pending) return;
    if (input === "y" || input === "Y") {
      select("continue");
      void submit("continue");
      return;
    }
    if (input === "n" || input === "N") {
      select("quit");
      void submit("quit");
      return;
    }
    // Quit on the left, Continue on the right, as on the trust card.
    if (key.leftArrow) {
      select("quit");
      return;
    }
    if (key.rightArrow) {
      select("continue");
      return;
    }
    if (key.upArrow || key.downArrow || key.tab) {
      select(choiceRef.current === "continue" ? "quit" : "continue");
      return;
    }
    if (key.return) {
      // A stray Enter from the launching shell answers nothing.
      void submit();
      return;
    }
    if (key.escape) {
      select("quit");
      void submit("quit");
    }
  });

  const theme = getTheme(themeName);
  const title = applyTextStyles(` ${WINDOWS_SANDBOX_CARD_COPY.title} `, {
    bold: true,
    color: theme.text as Color,
  });

  const button = (id: WindowsSandboxChoice, shortcut: string): React.ReactElement => {
    const text = `${windowsSandboxOptionLabel(id, choice, pending)}  ${shortcut}`;
    if (choice === id) {
      return (
        <ThemedText key={id} backgroundColor="text" color="inverseText" bold>
          {`  ${text}  `}
        </ThemedText>
      );
    }
    return (
      <ThemedText key={id} color="inactive">
        {`[ ${text} ]`}
      </ThemedText>
    );
  };

  return (
    <ThemedBox
      flexDirection="column"
      width={cardWidth}
      borderStyle="round"
      borderColor="subtle"
      borderText={{ content: title, position: "top", align: "start", offset: 1 }}
      paddingX={2}
      paddingTop={1}
    >
      {/* wrap-trim drops the space a soft wrap would carry to the next line. */}
      <ThemedText color="text" bold wrap="wrap-trim">
        {WINDOWS_SANDBOX_CARD_COPY.warning}
      </ThemedText>
      <Box marginTop={1}>
        <ThemedText color="text" wrap="wrap-trim">
          {WINDOWS_SANDBOX_CARD_COPY.body}
        </ThemedText>
      </Box>
      <Box marginTop={1}>
        <ThemedText color="inactive" wrap="wrap-trim">
          {WINDOWS_SANDBOX_CARD_COPY.note}
        </ThemedText>
      </Box>
      <Box marginTop={1} flexDirection="row" justifyContent="flex-end">
        {button("quit", "n")}
        <ThemedText>{"  "}</ThemedText>
        {button("continue", "y")}
      </Box>
    </ThemedBox>
  );
}
