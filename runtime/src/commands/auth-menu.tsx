import { Box, Text, useInput } from "../tui/ink.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import type { SlashCommandContext } from "./types.js";

function LoginNotice(info: { url: string; userCode?: string; onCancel?: () => void; copyUrl: boolean }) {
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) info.onCancel?.();
  }, { isActive: info.onCancel !== undefined });
  return (
    <Box flexDirection="column" paddingX={1} borderStyle="round">
      <Text>Sign in with Google to continue.</Text>
      <Text dimColor>{info.copyUrl ? "Open this URL in your browser:" : "Browser opened. Finish sign in there, then return here."}</Text>
      {info.userCode ? <Text dimColor>Code: {info.userCode}</Text> : null}
      <Text dimColor>URL: {info.url}</Text>
      {info.onCancel ? <Text dimColor>Esc or Ctrl+C cancels sign-in.</Text> : null}
    </Box>
  );
}

export function showBrowserLoginNotice(ctx: SlashCommandContext, url: string, userCode: string | undefined, onCancel?: () => void): void {
  openLocalJsxCommand(ctx, () => <LoginNotice url={url} userCode={userCode} onCancel={onCancel} copyUrl={false} />, { shouldHidePromptInput: false });
}

export function showCopyUrlLoginNotice(ctx: SlashCommandContext, url: string, userCode: string | undefined, onCancel?: () => void): void {
  openLocalJsxCommand(ctx, () => <LoginNotice url={url} userCode={userCode} onCancel={onCancel} copyUrl />, { shouldHidePromptInput: false });
}
