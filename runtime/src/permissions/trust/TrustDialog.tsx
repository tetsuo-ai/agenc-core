import React, { useCallback, useContext, useRef, useState } from "react";
import useInput from "../../tui/ink/hooks/use-input.js";
import { TerminalSizeContext } from "../../tui/ink/components/TerminalSizeContext.js";

/** Floor for the path width budget so a tiny/unknown terminal still truncates. */
const MIN_TRUST_PATH_WIDTH = 24;
/** Default width assumed when the terminal columns are unknown. */
const DEFAULT_TRUST_PATH_WIDTH = 80;

/**
 * Render the project path for the trust dialog as a single clean line that fits
 * the available width WITHOUT a hard mid-segment wrap.
 *
 * When the full path fits, it is returned verbatim. When it is too long, the
 * MIDDLE is elided with `…` while the meaningful tail (the deepest path
 * segments — e.g. `…/visualqa/frames-build/sandbox`) and the leading root are
 * preserved, so the box never wraps a path component across two lines. A single
 * over-long segment degrades to a plain middle-character truncation rather than
 * a hard cut.
 *
 * Pure + width-parameterized so it is unit-testable without the terminal.
 */
export function formatTrustPath(path: string, maxWidth: number): string {
  const budget = Math.max(MIN_TRUST_PATH_WIDTH, Math.trunc(maxWidth));
  if (path.length <= budget) return path;

  const ELLIPSIS = "…";
  // Keep as much of the tail (deepest, most meaningful segments) as fits,
  // breaking only at "/" boundaries so no segment is ever split.
  const segments = path.split("/");
  // Reserve room for the ellipsis prefix joiner "…/".
  let tail = "";
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i] ?? "";
    const candidate = tail.length === 0 ? segment : `${segment}/${tail}`;
    // +2 for the leading "…/" we will prepend.
    if (candidate.length + ELLIPSIS.length + 1 > budget) break;
    tail = candidate;
  }
  if (tail.length > 0) {
    return `${ELLIPSIS}/${tail}`;
  }
  // Even the last segment alone overflows — fall back to a middle truncation of
  // that segment so the tail end (often the unique part) still shows.
  const last = segments[segments.length - 1] ?? path;
  const keep = Math.max(1, budget - ELLIPSIS.length);
  const headLen = Math.ceil(keep / 2);
  const tailLen = keep - headLen;
  return `${last.slice(0, headLen)}${ELLIPSIS}${tailLen > 0 ? last.slice(last.length - tailLen) : ""}`;
}

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
  const terminalSize = useContext(TerminalSizeContext);
  // Width budget for the framed path: terminal columns minus the dialog's
  // paddingX (1 each side), the path frame border (1 each side) and the frame's
  // own paddingX (1 each side). Falls back to a sane default off-terminal.
  const columns =
    terminalSize && Number.isFinite(terminalSize.columns)
      ? terminalSize.columns
      : DEFAULT_TRUST_PATH_WIDTH;
  const pathBudget = columns - 6;
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
    // Present the project path as a clear, framed element consistent with the
    // rest of the boxed TUI — and elide the middle (keeping the meaningful tail)
    // instead of hard-wrapping a path segment across two lines.
    h(
      "ink-box",
      {
        style: {
          flexDirection: "column",
          borderStyle: "round",
          paddingX: 1,
          alignSelf: "flex-start",
        },
      },
      h(
        "ink-text",
        { style: { textWrap: "truncate-middle" } },
        formatTrustPath(props.workspaceRoot, pathBudget),
      ),
    ),
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
