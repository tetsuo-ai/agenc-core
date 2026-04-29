import React, { useMemo } from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import type { Color } from "../ink/styles.js";
import { theme } from "../theme.js";
import type { TranscriptMessage } from "../transcript/MessageList.js";
import type { SessionLike as StatusLineSessionLike } from "./StatusLineConfig.js";

/**
 * Footer notices are intentionally backed only by local codex runtime state:
 * usage sidecars, transcript warnings, budget settings, and pending approval
 * counts. OpenClaude account-rate-limit, remote/cloud, and IDE plugin notices
 * are omitted here until AgenC exposes equivalent live signals; rendering
 * guessed state in the footer is worse than saying nothing.
 */
export interface StatusNoticesProps {
  readonly session: StatusLineSessionLike;
  readonly messages: readonly TranscriptMessage[];
  readonly pendingApprovalCount?: number;
  readonly configWarnings?: readonly string[];
  readonly projectMemoryWarnings?: readonly string[];
  readonly agentDefinitionWarnings?: readonly string[];
}

export interface Notice {
  readonly id: string;
  readonly tone: "warning" | "info" | "error";
  readonly text: string;
  readonly priority: number;
}

export interface ActiveNoticeInput extends Partial<StatusNoticesProps> {
  readonly configWarnings?: readonly string[];
  readonly projectMemoryWarnings?: readonly string[];
  readonly agentDefinitionWarnings?: readonly string[];
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
      priority: session.contextPercent >= 95 ? 15 : 30,
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
    priority: used >= 1 ? 10 : 35,
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
    priority: 60,
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
    priority: warning.kind === "error" ? 5 : 20,
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
    priority: 12,
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
  ]
    .filter((notice): notice is Notice => notice !== null)
    .sort((a, b) => a.priority - b.priority);
}

function noticesFromWarnings(
  idPrefix: string,
  tone: Notice["tone"],
  priority: number,
  warnings: readonly string[] | undefined,
): readonly Notice[] {
  return (warnings ?? [])
    .filter((warning) => typeof warning === "string" && warning.trim().length > 0)
    .map((warning, index) => ({
      id: `${idPrefix}:${index}`,
      tone,
      text: warning,
      priority,
    }));
}

export function getActiveNotices(input: ActiveNoticeInput): readonly Notice[] {
  const session = input.session ?? {};
  const messages = input.messages ?? [];
  return [
    ...buildStatusNotices({
      session,
      messages,
      pendingApprovalCount: input.pendingApprovalCount,
    }),
    ...noticesFromWarnings("config", "warning", 25, input.configWarnings),
    ...noticesFromWarnings(
      "project-memory",
      "warning",
      26,
      input.projectMemoryWarnings,
    ),
    ...noticesFromWarnings(
      "agent-definition",
      "warning",
      27,
      input.agentDefinitionWarnings,
    ),
  ].sort((a, b) => a.priority - b.priority);
}

function readWarningArray(
  source: unknown,
  keys: readonly string[],
): readonly string[] | undefined {
  if (!source || typeof source !== "object") return undefined;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    const warnings = value.filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    );
    if (warnings.length > 0) return warnings;
  }
  return undefined;
}

function isAgentDefinitionLike(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.agentType === "string" && record.agentType.length > 0;
}

function readAgentDefinitionWarnings(
  source: unknown,
): readonly string[] | undefined {
  if (!source || typeof source !== "object") return undefined;
  const record = source as {
    readonly agentDefinitions?: { readonly activeAgents?: unknown };
  };
  if (record.agentDefinitions === undefined) return undefined;
  const activeAgents = record.agentDefinitions.activeAgents;
  if (activeAgents === undefined) return undefined;
  if (!Array.isArray(activeAgents)) {
    return ["Agent definition catalog is not readable"];
  }
  const malformedCount = activeAgents.filter(
    (entry) => !isAgentDefinitionLike(entry),
  ).length;
  if (malformedCount === 0) return undefined;
  return [
    malformedCount === 1
      ? "1 agent definition was ignored because it is malformed"
      : `${malformedCount} agent definitions were ignored because they are malformed`,
  ];
}

export function readRuntimeStatusNoticeWarnings(
  source: unknown,
): Pick<
  ActiveNoticeInput,
  "projectMemoryWarnings" | "agentDefinitionWarnings"
> {
  const projectMemoryWarnings = readWarningArray(source, [
    "projectMemoryWarnings",
    "projectMemoryWarningMessages",
    "memoryWarnings",
    "memoryWarningMessages",
  ]);
  const agentDefinitionWarnings =
    readAgentDefinitionWarnings(source) ??
    readWarningArray(source, [
      "agentDefinitionWarnings",
      "agentDefinitionWarningMessages",
      "agentWarnings",
      "agentWarningMessages",
    ]);
  return {
    ...(projectMemoryWarnings !== undefined ? { projectMemoryWarnings } : {}),
    ...(agentDefinitionWarnings !== undefined
      ? { agentDefinitionWarnings }
      : {}),
  };
}

export const StatusNotices: React.FC<StatusNoticesProps> = (props) => {
  const notices = useMemo(
    () => getActiveNotices(props),
    [
      props.agentDefinitionWarnings,
      props.configWarnings,
      props.messages,
      props.pendingApprovalCount,
      props.projectMemoryWarnings,
      props.session,
    ],
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
