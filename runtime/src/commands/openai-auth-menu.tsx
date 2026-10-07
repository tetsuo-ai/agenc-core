import { Box, Text } from "../tui/ink.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import type { SlashCommandContext } from "./types.js";

export function showLoginNotice(
  ctx: SlashCommandContext,
  info: { heading: string; url: string },
): void {
  openLocalJsxCommand(
    ctx,
    () => (
      <Box flexDirection="column" paddingX={1} borderStyle="round">
        <Text>{info.heading}</Text>
        <Text dimColor>URL: {info.url}</Text>
      </Box>
    ),
    { shouldHidePromptInput: false },
  );
}
