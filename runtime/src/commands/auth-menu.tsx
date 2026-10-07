import { Box, Text } from "../tui/ink.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import type { SlashCommandContext } from "./types.js";

export function showBrowserLoginNotice(
  ctx: SlashCommandContext,
  url: string,
  userCode: string | undefined,
): void {
  openLocalJsxCommand(
    ctx,
    () => (
      <Box flexDirection="column" paddingX={1} borderStyle="round">
        <Text>Sign in with Google to continue.</Text>
        <Text dimColor>Browser opened. Finish sign in there, then return here.</Text>
        {userCode ? <Text dimColor>Code: {userCode}</Text> : null}
        <Text dimColor>URL: {url}</Text>
      </Box>
    ),
    { shouldHidePromptInput: false },
  );
}

export function showCopyUrlLoginNotice(
  ctx: SlashCommandContext,
  url: string,
  userCode: string | undefined,
): void {
  openLocalJsxCommand(
    ctx,
    () => (
      <Box flexDirection="column" paddingX={1} borderStyle="round">
        <Text>Sign in with Google to continue.</Text>
        <Text dimColor>Open this URL in your browser:</Text>
        {userCode ? <Text dimColor>Code: {userCode}</Text> : null}
        <Text dimColor>URL: {url}</Text>
      </Box>
    ),
    { shouldHidePromptInput: false },
  );
}
