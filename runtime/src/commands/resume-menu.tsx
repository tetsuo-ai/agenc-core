import { basename } from "node:path";
import React from "react";

import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
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
}: {
  readonly entries: readonly RolloutEntry[];
  readonly onDone: () => void;
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

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onDone();
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
            Resume from a shell with agenc --resume and the selected session id.
          </ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            Session: {selected?.sessionId ?? "none"}
          </ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            File: {selected?.filePath ? basename(selected.filePath) : "none"}
          </ThemedText>
        </Box>
      }
      footer={[
        { keyName: "up/down", label: "navigate" },
        { keyName: "q", label: "close" },
      ]}
      hint="agenc --resume <sessionId>"
    />
  );
}

export function openResumeMenu(
  ctx: SlashCommandContext,
  entries: readonly RolloutEntry[],
): boolean {
  const setToolJSX = ctx.appState?.setToolJSX;
  if (typeof setToolJSX !== "function") return false;
  const close = () => {
    setToolJSX({
      jsx: null,
      shouldHidePromptInput: false,
      clearLocalJSX: true,
    });
  };
  setToolJSX({
    isLocalJSXCommand: true,
    shouldHidePromptInput: true,
    jsx: <ResumeMenuView entries={entries} onDone={close} />,
  });
  return true;
}
