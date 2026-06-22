import React from "react";

import { Box, useInput } from "../tui/ink.js";
import ThemedBox from "../tui/components/design-system/ThemedBox.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { KeyHint } from "../tui/components/v2/primitives.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import type { SlashCommandContext } from "./types.js";

function rowsFromText(text: string): readonly string[] {
  const rows = text.split(/\r?\n/u).map(line => line.trimEnd());
  return rows.length > 0 ? rows : ["No context usage estimate available."];
}

function CompactStatusModal({
  message,
  contextText,
  onDone,
}: {
  readonly message: string;
  readonly contextText: string;
  readonly onDone: () => void;
}): React.ReactNode {
  const rows = React.useMemo(() => rowsFromText(contextText), [contextText]);
  useInput((input, key) => {
    if (key.escape || input === "q") onDone();
  });

  return (
    <ThemedBox
      flexDirection="column"
      borderStyle="single"
      borderColor="worker"
      backgroundColor="clawd_background"
      overflow="hidden"
    >
      <ThemedBox flexDirection="row" borderBottom borderBottomColor="worker" paddingX={1} gap={2}>
        <ThemedText color="worker">COMPACT</ThemedText>
        <ThemedText color="subtle" wrap="truncate-end">manual compaction</ThemedText>
      </ThemedBox>
      <Box flexDirection="column" paddingX={2} paddingY={1} gap={1}>
        <ThemedText color="worker" wrap="wrap">
          {message}
        </ThemedText>
        {rows.slice(0, 8).map((row, index) => (
          <Box key={index} flexDirection="row" gap={1}>
            <ThemedText color="muted3">{String(index + 1).padStart(2, "0")}</ThemedText>
            <ThemedText color="text2" wrap="truncate-end">{row.length > 0 ? row : " "}</ThemedText>
          </Box>
        ))}
      </Box>
      <ThemedBox flexDirection="row" borderTop borderTopColor="lineSoft" paddingX={1} gap={2}>
        <KeyHint k="/context" label="inspect usage" />
        <KeyHint k="q" label="close" />
        <Box flexGrow={1} />
        <KeyHint k="esc" label="dismiss" />
      </ThemedBox>
    </ThemedBox>
  );
}

export function openCompactStatusModal(
  ctx: SlashCommandContext,
  params: {
    readonly message: string;
    readonly contextText: string;
  },
): boolean {
  return openLocalJsxCommand(ctx, close => (
    <CompactStatusModal
      message={params.message}
      contextText={params.contextText}
      onDone={close}
    />
  ));
}
