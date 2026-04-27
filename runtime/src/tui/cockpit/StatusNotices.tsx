import React, { useMemo } from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import type { Color } from "../ink/styles.js";
import { theme } from "../theme.js";
import type { TranscriptMessage } from "../transcript/MessageList.js";
import type { SessionLike as StatusLineSessionLike } from "./StatusLineConfig.js";

export interface StatusNoticesProps {
  readonly session: StatusLineSessionLike;
  readonly messages: readonly TranscriptMessage[];
  readonly pendingApprovalCount?: number;
}

interface Notice {
  readonly id: string;
  readonly tone: "warning" | "info" | "error";
  readonly text: string;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function usageNotice(session: StatusLineSessionLike): Notice | null {
  if (
    typeof session.contextPercent === "number" &&
    session.contextPercent >= 85
  ) {
    return {
      id: "context",
      tone: session.contextPercent >= 95 ? "error" : "warning",
      text: `Context ${Math.round(session.contextPercent)}% full`,
    };
  }
  return null;
}

function budgetNotice(session: StatusLineSessionLike): Notice | null {
  if (
    typeof session.budgetUsd !== "number" ||
    typeof session.costUsd !== "number" ||
    session.budgetUsd <= 0
  ) {
    return null;
  }
  const used = session.costUsd / session.budgetUsd;
  if (used < 0.8) return null;
  const remaining =
    typeof session.budgetRemainingUsd === "number"
      ? session.budgetRemainingUsd
      : Math.max(0, session.budgetUsd - session.costUsd);
  return {
    id: "budget",
    tone: used >= 1 ? "error" : "warning",
    text: `Budget ${formatUsd(session.costUsd)}/${formatUsd(
      session.budgetUsd,
    )}; ${formatUsd(remaining)} remaining`,
  };
}

function outputNotice(session: StatusLineSessionLike): Notice | null {
  if (typeof session.outputTokens !== "number" || session.outputTokens < 16_000) {
    return null;
  }
  return {
    id: "output",
    tone: "info",
    text: `${session.outputTokens.toLocaleString()} output tokens this session`,
  };
}

function warningNotice(messages: readonly TranscriptMessage[]): Notice | null {
  const warning = [...messages]
    .reverse()
    .find((message) => {
      if (message.kind !== "warning" && message.kind !== "error") return false;
      const text = `${message.label ?? ""} ${message.content}`.toLowerCase();
      return (
        text.includes("lsp") ||
        text.includes("plugin") ||
        text.includes("settings") ||
        text.includes("model migration") ||
        text.includes("rate limit")
      );
    });
  if (!warning) return null;
  return {
    id: `warning:${warning.id}`,
    tone: warning.kind === "error" ? "error" : "warning",
    text: warning.content,
  };
}

function approvalNotice(count: number | undefined): Notice | null {
  if (count === undefined || count <= 0) return null;
  return {
    id: "approvals",
    tone: "warning",
    text:
      count === 1
        ? "1 approval waiting"
        : `${count} approvals waiting`,
  };
}

function noticeColor(tone: Notice["tone"]): Color {
  switch (tone) {
    case "error":
      return theme.colors.error as Color;
    case "warning":
      return theme.colors.warning as Color;
    case "info":
      return theme.colors.secondary as Color;
  }
}

export function buildStatusNotices(
  props: StatusNoticesProps,
): readonly Notice[] {
  return [
    usageNotice(props.session),
    budgetNotice(props.session),
    outputNotice(props.session),
    warningNotice(props.messages),
    approvalNotice(props.pendingApprovalCount),
  ].filter((notice): notice is Notice => notice !== null);
}

export const StatusNotices: React.FC<StatusNoticesProps> = (props) => {
  const notices = useMemo(
    () => buildStatusNotices(props),
    [props.messages, props.pendingApprovalCount, props.session],
  );
  if (notices.length === 0) return null;
  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      {notices.slice(0, 3).map((notice) => (
        <Box key={notice.id} flexDirection="row" paddingX={1}>
          <Text color={noticeColor(notice.tone)}>{"⚠ "}</Text>
          <Text color={noticeColor(notice.tone)} wrap="truncate">
            {notice.text}
          </Text>
        </Box>
      ))}
    </Box>
  );
};

export default StatusNotices;
