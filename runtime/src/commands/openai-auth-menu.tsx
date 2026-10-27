import { Box, Text, useInput } from "../tui/ink.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import type { SlashCommandContext } from "./types.js";

type LoginNoticeInfo = { heading: string; url: string; onCancel?: () => void };

function LoginNotice(info: LoginNoticeInfo) {
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) info.onCancel?.();
  }, { isActive: info.onCancel !== undefined });
  return (
    <Box flexDirection="column" paddingX={1} borderStyle="round">
      <Text>{info.heading}</Text>
      <Text dimColor>URL: {info.url}</Text>
      {info.onCancel ? <Text dimColor>Esc or Ctrl+C cancels sign-in.</Text> : null}
    </Box>
  );
}

export function showLoginNotice(ctx: SlashCommandContext, info: LoginNoticeInfo): void {
  openLocalJsxCommand(ctx, () => <LoginNotice {...info} />, { shouldHidePromptInput: false });
}
