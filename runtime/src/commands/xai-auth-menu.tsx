import { useContext, useState } from "react";
import { Box, Text, useInput } from "../tui/ink.js";
import { setClipboard } from "../tui/ink/termio/osc.js";
import { TerminalWriteContext } from "../tui/ink/useTerminalNotification.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import type { SlashCommandContext } from "./types.js";

type LoginNoticeInfo = {
  heading: string;
  url: string;
  userCode?: string;
  onCancel?: () => void;
};

function LoginNotice(info: LoginNoticeInfo) {
  const writeRaw = useContext(TerminalWriteContext);
  const [copied, setCopied] = useState(false);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      info.onCancel?.();
      return;
    }
    // The fullscreen TUI owns the mouse, so the URL cannot be selected with a
    // plain drag. `c` sends it to the clipboard (OSC 52 / tmux buffer), which
    // also reaches the local clipboard over SSH.
    if (input === "c" && !key.ctrl && !key.meta && info.url) {
      void setClipboard(info.url)
        .then((sequence) => {
          if (sequence) writeRaw?.(sequence);
          setCopied(true);
        })
        .catch(() => {});
    }
  }, { isActive: info.onCancel !== undefined });
  return (
    <Box flexDirection="column" paddingX={1} borderStyle="round">
      <Text>{info.heading}</Text>
      <Text dimColor>
        The consent page may say "Grok Build". That is xAI's shared sign-in.
      </Text>
      {info.userCode ? <Text>Code: {info.userCode}</Text> : null}
      {info.url ? <Text>URL: {info.url}</Text> : null}
      {info.url ? (
        <Text dimColor>
          {copied ? "URL copied to the clipboard." : "Press c to copy the URL."}
        </Text>
      ) : null}
      {info.onCancel ? (
        <Text dimColor>
          Waiting for the sign-in to finish; typing is paused. Esc or Ctrl+C cancels.
        </Text>
      ) : null}
    </Box>
  );
}

export function showLoginNotice(
  ctx: SlashCommandContext,
  info: LoginNoticeInfo,
): void {
  openLocalJsxCommand(
    ctx,
    () => <LoginNotice {...info} />,
    { shouldHidePromptInput: false },
  );
}
