import { basename } from "node:path";
import React, { useCallback, useContext, useRef, useState } from "react";
import useInput from "../../tui/ink/hooks/use-input.js";
import { TerminalSizeContext } from "../../tui/ink/components/TerminalSizeContext.js";
import { Box } from "../../tui/ink.js";
import { applyTextStyles } from "../../tui/ink/colorize.js";
import type { Color } from "../../tui/ink/styles.js";
import { useTheme } from "../../tui/components/design-system/ThemeProvider.js";
import ThemedBox from "../../tui/components/design-system/ThemedBox.js";
import ThemedText from "../../tui/components/design-system/ThemedText.js";
import { getTheme } from "../../utils/theme.js";
import type { ProjectTrustItem, ProjectTrustReview } from "./trust-sources.js";

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

/** A folder that holds far more than one project. */
export type TrustLocation = "home" | "root";

export interface TrustDialogProps {
  readonly workspaceRoot: string;
  /** What trusting the root turns on. Empty or absent means nothing listed. */
  readonly review?: ProjectTrustReview;
  readonly location?: TrustLocation;
  readonly bypassPermissionsRequested?: boolean;
  readonly bypassSandboxRequested?: boolean;
  readonly onAccept: () => void | Promise<void>;
  readonly onReject: () => void | Promise<void>;
}

type TrustChoice = "trust" | "exit";

/** Card width bounds: wide enough for the buttons, narrow enough to scan. */
const MIN_CARD_WIDTH = 44;
const MAX_CARD_WIDTH = 76;
/** Border (2 columns) plus paddingX 2 on each side. */
const CARD_CHROME_WIDTH = 6;
/** Values shown per row before the rest collapse into "+N more". */
const MAX_VALUES_PER_ITEM = 4;
const MIN_LABEL_WIDTH = 12;

export function trustDialogOptionLabel(
  id: TrustChoice,
  choice: TrustChoice | null,
  pending: boolean,
): string {
  if (pending && choice === id) {
    return id === "trust" ? "Trusting..." : "Exiting...";
  }
  return id === "trust" ? "Trust" : "Exit";
}

export function trustLocationWarning(
  location: TrustLocation | undefined,
): string | undefined {
  if (location === "home") {
    return "This is your home folder. AgenC can work on every file in it.";
  }
  if (location === "root") {
    return "This is the root of the disk. AgenC can work on every file on it.";
  }
  return undefined;
}

export function trustReviewLead(
  review: ProjectTrustReview | undefined,
): string | undefined {
  const repo = (review?.repoItems.length ?? 0) > 0;
  const user = (review?.userItems.length ?? 0) > 0;
  if (repo && user) return "Trusting turns these on in this folder:";
  if (repo) return "Trusting turns on the AgenC settings this repo ships:";
  if (user) return "Trusting lets your own setup run in this folder:";
  return undefined;
}

export function trustSafetyNote(
  bypassPermissionsRequested: boolean,
  bypassSandboxRequested: boolean,
): string {
  if (bypassSandboxRequested) {
    return "Approvals and the sandbox are off for this run.";
  }
  if (bypassPermissionsRequested) {
    return "Approvals are off for this run. The sandbox still applies.";
  }
  return "Approvals and the sandbox still apply.";
}

/** Rows for the card table, with long value lists collapsed. */
export function trustItemRows(
  items: readonly ProjectTrustItem[],
): Array<{ readonly label: string; readonly value: string; readonly more: boolean }> {
  const rows: Array<{ label: string; value: string; more: boolean }> = [];
  for (const item of items) {
    const shown = item.values.slice(0, MAX_VALUES_PER_ITEM);
    shown.forEach((value, index) => {
      rows.push({ label: index === 0 ? item.label : "", value, more: false });
    });
    const hidden = item.values.length - shown.length;
    if (hidden > 0) rows.push({ label: "", value: `+${hidden} more`, more: true });
  }
  return rows;
}

export function TrustDialog(props: TrustDialogProps): React.ReactElement {
  // No pre-selected option. The user must explicitly pick one with y / n,
  // the arrows or Tab before Enter means anything: Enter on launch (the most
  // common reflex) must not commit either choice.
  const terminalSize = useContext(TerminalSizeContext);
  const [themeName] = useTheme();
  const columns =
    terminalSize && Number.isFinite(terminalSize.columns)
      ? terminalSize.columns
      : DEFAULT_TRUST_PATH_WIDTH;
  const cardWidth = Math.max(
    MIN_CARD_WIDTH,
    Math.min(MAX_CARD_WIDTH, columns - 2),
  );
  const innerWidth = cardWidth - CARD_CHROME_WIDTH;
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
    // y and n answer at once; the button they name is shown as pressed.
    if (input === "y" || input === "Y") {
      setSelectedChoice("trust");
      void submit("trust");
      return;
    }
    if (input === "n" || input === "N") {
      setSelectedChoice("exit");
      void submit("exit");
      return;
    }
    // The buttons sit in a row: Exit on the left, Trust on the right.
    if (key.leftArrow) {
      setSelectedChoice("exit");
      return;
    }
    if (key.rightArrow) {
      setSelectedChoice("trust");
      return;
    }
    if (key.upArrow || key.downArrow || key.tab) {
      const current = choiceRef.current;
      setSelectedChoice(current === "trust" ? "exit" : "trust");
      return;
    }
    if (key.return) {
      // A no-op until a button is selected, so a stray Enter from the
      // launching shell neither trusts the folder nor bounces the user out.
      void submit();
      return;
    }
    if (key.escape) {
      setSelectedChoice("exit");
      void submit("exit");
    }
  });

  // Terminals can't change font SIZE, so the card builds hierarchy from
  // weight and ink intensity: the title sits in the border in bold, the
  // folder name is bold, copy is full ink, labels are bold, values are a
  // step down, and the path, note and idle buttons are muted.
  const theme = getTheme(themeName);
  const title = applyTextStyles(" Trust this project? ", {
    bold: true,
    color: theme.text as Color,
  });
  const name = basename(props.workspaceRoot) || props.workspaceRoot;
  const path = formatTrustPath(props.workspaceRoot, innerWidth);
  const warning = trustLocationWarning(props.location);
  const lead = trustReviewLead(props.review);
  const items = [
    ...(props.review?.repoItems ?? []),
    ...(props.review?.userItems ?? []),
  ];
  const rows = trustItemRows(items);
  const labelWidth = Math.max(
    MIN_LABEL_WIDTH,
    ...items.map((item) => item.label.length + 2),
  );
  const valueWidth = Math.max(8, innerWidth - labelWidth);
  const bypass = props.bypassPermissionsRequested === true;
  const note = trustSafetyNote(bypass, props.bypassSandboxRequested === true);

  const button = (id: TrustChoice, shortcut: string): React.ReactElement => {
    const text = `${trustDialogOptionLabel(id, choice, pending)}  ${shortcut}`;
    if (choice === id) {
      return (
        <ThemedText
          key={id}
          backgroundColor="text"
          color="inverseText"
          bold
        >
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
      <ThemedText color="text" bold wrap="truncate-end">
        {name}
      </ThemedText>
      {path !== name ? (
        <ThemedText color="inactive" wrap="truncate-middle">
          {path}
        </ThemedText>
      ) : null}

      {warning !== undefined ? (
        <Box marginTop={1}>
          <ThemedText color="text" bold>
            {warning}
          </ThemedText>
        </Box>
      ) : null}

      {lead !== undefined ? (
        <Box flexDirection="column" marginTop={1}>
          <ThemedText color="text">{lead}</ThemedText>
          <Box flexDirection="column" marginTop={1}>
            {rows.map((row, index) => (
              <Box key={`${row.label}-${index}`} flexDirection="row">
                <Box width={labelWidth} flexShrink={0}>
                  <ThemedText color="text" bold>
                    {row.label}
                  </ThemedText>
                </Box>
                <Box width={valueWidth}>
                  <ThemedText
                    color={row.more ? "inactive" : "text2"}
                    wrap="truncate-end"
                  >
                    {row.value}
                  </ThemedText>
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <ThemedText color={bypass ? "text" : "inactive"} bold={bypass}>
          {note}
        </ThemedText>
      </Box>

      <Box marginTop={1} flexDirection="row" justifyContent="flex-end">
        {button("exit", "n")}
        <ThemedText>{"  "}</ThemedText>
        {button("trust", "y")}
      </Box>
    </ThemedBox>
  );
}
