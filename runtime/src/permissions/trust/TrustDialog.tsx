import React, { useCallback, useRef, useState } from "react";
import useInput from "../../tui/ink/hooks/use-input.js";

export interface TrustDialogProps {
  readonly workspaceRoot: string;
  readonly riskSources?: readonly string[];
  readonly bypassPermissionsRequested?: boolean;
  readonly onAccept: () => void | Promise<void>;
  readonly onReject: () => void | Promise<void>;
}

type TrustChoice = "trust" | "exit";

export const YOLO_TRUST_COPY =
  "--yolo skips tool approval prompts and uses danger-full-access sandbox mode after trust; project trust still requires confirmation.";

export function trustDialogOptionLabel(
  id: TrustChoice,
  choice: TrustChoice | null,
  pending: boolean,
): string {
  if (!pending) {
    return id === "trust" ? "Yes, I trust this project" : "No, exit";
  }
  if (choice === "trust") {
    return id === "trust" ? "Accepting..." : "No, exit";
  }
  if (choice === "exit") {
    return id === "exit" ? "Exiting..." : "Yes, I trust this project";
  }
  return id === "trust" ? "Yes, I trust this project" : "No, exit";
}

export function TrustDialog(props: TrustDialogProps): React.ReactElement {
  // No pre-selected option. The user must explicitly pick one with
  // arrow / tab / explicit y / n before Enter is meaningful. Pressing
  // Enter on launch (the most common reflex) should not commit a
  // destructive action; it just sits waiting for an actual choice.
  const [choice, setChoice] = useState<TrustChoice | null>(null);
  const [pending, setPending] = useState(false);
  const choiceRef = useRef<TrustChoice | null>(null);
  const pendingRef = useRef(false);

  const setSelectedChoice = useCallback((next: TrustChoice | null) => {
    choiceRef.current = next;
    setChoice(next);
  }, []);

  const submit = useCallback(
    async (next: TrustChoice | null = choiceRef.current) => {
      if (pendingRef.current) return;
      if (next === null) return;
      pendingRef.current = true;
      setPending(true);
      try {
        if (next === "trust") {
          await props.onAccept();
        } else {
          await props.onReject();
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
    if (key.upArrow || key.downArrow || key.tab) {
      const current = choiceRef.current;
      setSelectedChoice(
        current === null ? "trust" : current === "trust" ? "exit" : "trust",
      );
      return;
    }
    // Single-letter shortcuts so the user can pick directly without
    // first navigating: `y` selects trust, `n` selects exit. The
    // user still has to press Enter afterwards to commit.
    if (input === "y" || input === "Y") {
      setSelectedChoice("trust");
      return;
    }
    if (input === "n" || input === "N") {
      setSelectedChoice("exit");
      return;
    }
    if (key.return) {
      // Enter is a no-op until the user has made a choice. Without
      // this guard, a stray Enter from the launching shell or any
      // reflexive keystroke would commit "exit" and bounce the
      // user out of the tool they just launched.
      void submit();
      return;
    }
    if (key.escape) {
      void submit("exit");
    }
  });

  const h = React.createElement;
  const option = (id: TrustChoice, label: string) =>
    h(
      "ink-text",
      {
        key: id,
        textStyles: { bold: choice === id },
      },
      `${choice === id ? ">" : " "} ${label}`,
    );

  return h(
    "ink-box",
    {
      style: {
        flexDirection: "column",
        paddingX: 1,
        paddingY: 1,
        gap: 1,
      },
    },
    h("ink-text", { textStyles: { bold: true } }, "Trust this project?"),
    h("ink-text", null, props.workspaceRoot),
    h(
      "ink-text",
      null,
      "AgenC can read files, edit files, and run commands in trusted projects.",
    ),
    props.bypassPermissionsRequested
      ? h(
          "ink-text",
          { textStyles: { dimColor: true } },
          YOLO_TRUST_COPY,
        )
      : null,
    props.riskSources && props.riskSources.length > 0
      ? h(
          "ink-box",
          { style: { flexDirection: "column" } },
          h("ink-text", { textStyles: { bold: true } }, "Project-local signals:"),
          ...props.riskSources.map((source) =>
            h("ink-text", { key: source }, `- ${source}`),
          ),
        )
      : null,
    h(
      "ink-box",
      { style: { flexDirection: "column" } },
      option("trust", trustDialogOptionLabel("trust", choice, pending)),
      option("exit", trustDialogOptionLabel("exit", choice, pending)),
    ),
    h(
      "ink-text",
      { textStyles: { dimColor: true } },
      choice === null
        ? "Use ↑ ↓ or y / n to choose, then Enter to confirm."
        : "Press Enter to confirm, or ↑ ↓ to switch.",
    ),
  );
}

export default TrustDialog;
