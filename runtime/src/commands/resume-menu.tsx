import { basename } from "node:path";
import React from "react";

import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import type { SlashCommandContext } from "./types.js";
import type { RolloutEntry } from "./resume.js";

function formatTime(mtimeMs: number): string {
  const date = new Date(mtimeMs);
  if (!Number.isFinite(date.getTime())) return "unknown";
  return date.toISOString().slice(0, 16).replace("T", " ");
}

function shortId(sessionId: string): string {
  return sessionId.length > 18
    ? `${sessionId.slice(0, 8)}...${sessionId.slice(-6)}`
    : sessionId;
}

function ResumeMenuView({
  entries,
  onDone,
  requestResumeSession,
}: {
  readonly entries: readonly RolloutEntry[];
  readonly onDone: () => void;
  /**
   * Relaunch the TUI into the chosen session. Absent in headless/test or
   * older-dispatcher contexts — Enter then falls back to the printed
   * `agenc --resume <id>` instructions.
   */
  readonly requestResumeSession?: (sessionId: string) => void;
}): React.ReactNode {
  const [activeIndex, setActiveIndex] = React.useState(0);
  const rows =
    entries.length > 0
      ? entries
      : [{
          filePath: "",
          sessionId: "none",
          mtimeMs: Number.NaN,
          firstUserPreview: "No resumable sessions found for this project.",
        }];
  const canResume =
    entries.length > 0 && typeof requestResumeSession === "function";

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onDone();
      return;
    }
    if (key.return) {
      // Enter resumes the highlighted session by relaunching the TUI into
      // it (see tui/pending-resume.ts). Guarded on a live bridge + a real
      // entry; otherwise Enter is a no-op and the footer keeps showing the
      // shell-command fallback.
      if (canResume) {
        const target = rows[activeIndex] ?? rows[0];
        if (target && target.sessionId !== "none") {
          requestResumeSession(target.sessionId);
          onDone();
        }
      }
      return;
    }
    if (key.upArrow || input === "k") {
      setActiveIndex(index => previousMenuIndex(index, rows.length));
      return;
    }
    if (key.downArrow || input === "j") {
      setActiveIndex(index => nextMenuIndex(index, rows.length));
    }
  });

  const selected = rows[activeIndex] ?? rows[0];
  return (
    <MenuModal
      title="resume"
      count={`${entries.length}`}
      summary="recent sessions"
      headerRight="local"
      columns={[3, 18, 20, 48]}
      headers={["", "updated", "session", "preview"]}
      items={rows}
      activeIndex={activeIndex}
      renderRow={(row, _index, active) => [
        <ThemedText key="mark" color={entries.length > 0 ? "agenc" : "inactive"}>
          {active ? "◆" : "·"}
        </ThemedText>,
        <ThemedText key="time" color="subtle" wrap="truncate-end">
          {formatTime(row.mtimeMs)}
        </ThemedText>,
        <ThemedText key="id" color={active ? "agenc" : "text2"} wrap="truncate-middle">
          {shortId(row.sessionId)}
        </ThemedText>,
        <ThemedText key="preview" color="subtle" wrap="truncate-end">
          {row.firstUserPreview}
        </ThemedText>,
      ]}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc">Session Resume</ThemedText>
          <ThemedText color="text2" wrap="wrap">
            {canResume
              ? "Press enter to switch to the selected session."
              : "Resume from a shell with agenc --resume and the selected session id."}
          </ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            Session: {selected?.sessionId ?? "none"}
          </ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            File: {selected?.filePath ? basename(selected.filePath) : "none"}
          </ThemedText>
        </Box>
      }
      footer={
        canResume
          ? [
              { keyName: "up/down", label: "navigate" },
              { keyName: "enter", label: "resume" },
              { keyName: "q", label: "close" },
            ]
          : [
              { keyName: "up/down", label: "navigate" },
              { keyName: "q", label: "close" },
            ]
      }
      hint={canResume ? "enter resumes the selected session" : "agenc --resume <sessionId>"}
    />
  );
}

export function openResumeMenu(
  ctx: SlashCommandContext,
  entries: readonly RolloutEntry[],
): boolean {
  const requestResumeSession = ctx.appState?.requestResumeSession;
  return openLocalJsxCommand(ctx, close => (
    <ResumeMenuView
      entries={entries}
      onDone={close}
      {...(typeof requestResumeSession === "function"
        ? { requestResumeSession }
        : {})}
    />
  ));
}
