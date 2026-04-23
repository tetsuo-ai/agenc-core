/**
 * Operator-grade approval overlay for the AgenC TUI.
 *
 * The overlay intentionally keeps the control flow narrow — a single
 * request in, a single approval decision out — while surfacing enough
 * queue and request context for fast operator review:
 *
 *   - compact tool-specific preview
 *   - explicit queue position / backlog visibility
 *   - focus-safe detail tabs (summary / preview / raw / queue)
 *   - richer file / command drilldowns without leaving the modal
 *
 * Decision handling still routes through `onResolve` exactly once.
 */

import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import Box from "../ink/components/Box.js";
import StdinContext from "../ink/components/StdinContext.js";
import Text from "../ink/components/Text.js";
import type { InputEvent } from "../ink/events/input-event.js";
import type { Color } from "../ink/styles.js";
import { theme } from "../theme.js";
import { useOptionalAgenCAppState } from "../state/AppState.js";
import {
  useKeybinding,
  useSetKeybindingContext,
} from "../keybindings/KeybindingContext.js";
import { getDisplayForCommand } from "../keybindings/shortcutFormat.js";
import type { PendingPermissionRequest } from "../../permissions/context.js";

export type ApprovalBehavior = "allow" | "allow-session" | "deny" | "abort";
type FocusZone = "decision" | "details";
type DetailTab = "summary" | "preview" | "raw" | "queue";
type RiskLevel = "low" | "medium" | "high";

export interface ApprovalDecision {
  readonly behavior: ApprovalBehavior;
  readonly addRule?: boolean;
}

export interface ApprovalOverlayRequest {
  readonly requestId: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly workspacePath: string;
  readonly reason?: string;
  readonly turnId: string;
}

export interface ApprovalOverlayProps {
  readonly request: ApprovalOverlayRequest;
  readonly onResolve: (decision: ApprovalDecision) => void;
  readonly abortSignal: AbortSignal;
}

const MAX_PREVIEW_LINES = 8;
const MAX_ARGS_LINES = 18;
const DETAIL_TABS: readonly DetailTab[] = [
  "summary",
  "preview",
  "raw",
  "queue",
];

function truncateLines(source: string, maxLines: number): string {
  if (typeof source !== "string" || source.length === 0) return "";
  const lines = source.split("\n");
  if (lines.length <= maxLines) return source;
  return `${lines.slice(0, maxLines).join("\n")}\n…`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "<unserializable>";
  }
}

function coerceString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function countLines(value: string): number {
  return value.length === 0 ? 0 : value.split("\n").length;
}

function byteSize(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateInline(value: string, max = 64): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function humanizeAge(submittedAt: number | undefined): string {
  if (!submittedAt || !Number.isFinite(submittedAt)) return "now";
  const ageMs = Math.max(0, Date.now() - submittedAt);
  if (ageMs < 1000) return "now";
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m`;
  return `${Math.round(ageMs / 3_600_000)}h`;
}

function extractPath(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  return coerceString(
    record.path ??
      record.file_path ??
      record.filePath ??
      record.target ??
      record.cwd,
  );
}

function extractCommand(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  return coerceString(record.command ?? record.cmd);
}

function summarizeScope(tool: string, args: unknown): string {
  const command = extractCommand(args);
  if (command.length > 0) {
    return truncateInline(command.split("\n")[0] ?? command, 72);
  }
  const path = extractPath(args);
  if (path.length > 0) {
    return truncateInline(path, 72);
  }
  return tool;
}

function inferRisk(tool: string, args: unknown): {
  readonly level: RiskLevel;
  readonly label: string;
  readonly notes: readonly string[];
} {
  const lowerTool = tool.toLowerCase();
  const path = extractPath(args).toLowerCase();
  const command = extractCommand(args).toLowerCase();
  const notes: string[] = [];

  if (
    lowerTool.includes("delete") ||
    lowerTool.includes("edit") ||
    lowerTool.includes("write")
  ) {
    notes.push("mutates filesystem state");
  }
  if (path.includes(".env") || path.includes("config")) {
    notes.push("touches configuration");
  }
  if (
    /(^|\s)(rm|mv|chmod|chown|sudo|git reset|git clean|docker|kubectl|terraform|npm publish|pnpm publish|yarn publish)\b/.test(
      command,
    )
  ) {
    notes.push("destructive or privileged shell command");
    return { level: "high", label: "HIGH", notes };
  }
  if (
    lowerTool.includes("edit") ||
    lowerTool.includes("write") ||
    /(^|\s)(curl|wget|scp|ssh|rsync)\b/.test(command)
  ) {
    if (command.length > 0 && !notes.includes("mutates filesystem state")) {
      notes.push("shell command with external side effects");
    }
    return { level: "medium", label: "MED", notes };
  }
  if (command.length > 0 || lowerTool.includes("bash")) {
    notes.push("shell execution");
  }
  return {
    level: notes.length > 0 ? "medium" : "low",
    label: notes.length > 0 ? "MED" : "LOW",
    notes,
  };
}

function tabLabel(tab: DetailTab): string {
  switch (tab) {
    case "summary":
      return "Summary";
    case "preview":
      return "Preview";
    case "raw":
      return "Raw";
    case "queue":
      return "Queue";
  }
}

function riskColor(level: RiskLevel): Color {
  switch (level) {
    case "high":
      return theme.colors.error as Color;
    case "medium":
      return theme.colors.warning as Color;
    case "low":
      return theme.colors.success as Color;
  }
}

function queueEntryLabel(request: PendingPermissionRequest): string {
  return `${request.toolName} · ${summarizeScope(
    request.toolName,
    request.toolInput,
  )}`;
}

function queuePositionLabel(index: number, total: number): string {
  if (total <= 0) return "Queue 0/0";
  return `Queue ${index + 1}/${total}`;
}

function sanitizeMessage(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export const BashRequest: React.FC<{ args: unknown }> = ({ args }) => {
  const command = extractCommand(args);
  const preview = truncateLines(command, MAX_PREVIEW_LINES);
  return (
    <Box flexDirection="column">
      <Text dim>{`command · ${countLines(command)} lines`}</Text>
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text>{preview.length > 0 ? preview : "(empty)"}</Text>
      </Box>
    </Box>
  );
};

export const WriteFileRequest: React.FC<{ args: unknown }> = ({ args }) => {
  const record = (args ?? {}) as Record<string, unknown>;
  const path = extractPath(args);
  const content = coerceString(record.content);
  const preview = truncateLines(content, MAX_PREVIEW_LINES);
  return (
    <Box flexDirection="column">
      <Text dim>{`path · ${path || "(none)"}`}</Text>
      <Text dim>{`payload · ${countLines(content)} lines · ${byteSize(content)} bytes`}</Text>
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text>{preview.length > 0 ? preview : "(empty)"}</Text>
      </Box>
    </Box>
  );
};

export const EditFileRequest: React.FC<{ args: unknown }> = ({ args }) => {
  const record = (args ?? {}) as Record<string, unknown>;
  const path = extractPath(args);
  const oldText = coerceString(record.oldText ?? record.old_text);
  const newText = coerceString(record.newText ?? record.new_text);
  const oldPreview = truncateLines(oldText, 4);
  const newPreview = truncateLines(newText, 4);
  return (
    <Box flexDirection="column">
      <Text dim>{`path · ${path || "(none)"}`}</Text>
      <Text dim>{`diff · -${countLines(oldText)} / +${countLines(newText)} lines`}</Text>
      <Text dim>before</Text>
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text>{oldPreview.length > 0 ? oldPreview : "(empty)"}</Text>
      </Box>
      <Text dim>after</Text>
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text>{newPreview.length > 0 ? newPreview : "(empty)"}</Text>
      </Box>
    </Box>
  );
};

export const GenericRequest: React.FC<{ args: unknown }> = ({ args }) => {
  const preview = truncateLines(safeStringify(args ?? {}), MAX_ARGS_LINES);
  return (
    <Box flexDirection="column">
      <Text dim>args</Text>
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Text>{preview}</Text>
      </Box>
    </Box>
  );
};

function renderToolBody(tool: string, args: unknown): React.ReactElement {
  switch (tool) {
    case "Bash":
    case "system.bash":
      return <BashRequest args={args} />;
    case "write_file":
    case "system.writeFile":
      return <WriteFileRequest args={args} />;
    case "edit_file":
    case "system.editFile":
      return <EditFileRequest args={args} />;
    default:
      return <GenericRequest args={args} />;
  }
}

export const ApprovalOverlay: React.FC<ApprovalOverlayProps> = ({
  request,
  onResolve,
  abortSignal,
}) => {
  const appState = useOptionalAgenCAppState();
  const stdin = useContext(StdinContext);
  const [focusZone, setFocusZone] = useState<FocusZone>("decision");
  const [detailTab, setDetailTab] = useState<DetailTab>("summary");
  const resolvedRef = useRef(false);

  const queue = appState?.permissionQueue ?? [];
  const queueIndex = queue.findIndex((entry) => entry.requestId === request.requestId);
  const activeQueueEntry =
    queueIndex >= 0
      ? queue[queueIndex]
      : ({
          requestId: request.requestId,
          toolName: request.tool,
          toolInput: request.args,
          turnId: request.turnId,
          message: request.reason ?? "",
          submittedAt: Date.now(),
        } as PendingPermissionRequest);
  const queuePosition = queueIndex >= 0 ? queueIndex : 0;
  const queuedCount = queue.length > 0 ? queue.length : 1;
  const queuedBehind = Math.max(0, queuedCount - queuePosition - 1);
  const risk = useMemo(
    () => inferRisk(request.tool, request.args),
    [request.args, request.tool],
  );
  const warningColor = theme.colors.warning as Color;
  const accentColor = theme.colors.accent as Color;
  const focusColor =
    focusZone === "decision"
      ? (theme.colors.primary as Color)
      : (theme.colors.secondary as Color);
  const detailTabs = useMemo(() => DETAIL_TABS.slice(), []);
  const confirmKey = getDisplayForCommand("modal:confirm", "modal") ?? "Enter";
  const denyKey = getDisplayForCommand("modal:deny", "modal") ?? "D";
  const allowSessionKey =
    getDisplayForCommand("modal:allowSession", "modal") ?? "A";
  const cancelKey = getDisplayForCommand("modal:cancel", "modal") ?? "Esc";
  const rawPreview = useMemo(
    () => truncateLines(safeStringify(request.args ?? {}), MAX_ARGS_LINES),
    [request.args],
  );
  const queuePreview = useMemo(
    () => queue.slice(queuePosition, queuePosition + 4),
    [queue, queuePosition],
  );
  const requestMessage = useMemo(() => {
    const message = sanitizeMessage(activeQueueEntry.message);
    if (message.length === 0) return "";
    if (message === sanitizeMessage(request.reason)) return "";
    return message;
  }, [activeQueueEntry.message, request.reason]);

  const resolveOnce = useCallback(
    (decision: ApprovalDecision) => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      onResolve(decision);
    },
    [onResolve],
  );

  const setActiveContext = useSetKeybindingContext();
  useEffect(() => {
    setActiveContext("modal");
    return () => {
      setActiveContext("chat");
    };
  }, [setActiveContext]);

  useEffect(() => {
    if (!abortSignal) return;
    if (abortSignal.aborted) {
      queueMicrotask(() => resolveOnce({ behavior: "abort" }));
      return;
    }
    const handler = (): void => {
      resolveOnce({ behavior: "abort" });
    };
    abortSignal.addEventListener("abort", handler);
    return () => {
      abortSignal.removeEventListener("abort", handler);
    };
  }, [abortSignal, resolveOnce]);

  const onAllow = useCallback(() => {
    if (focusZone !== "decision") return;
    resolveOnce({ behavior: "allow" });
  }, [focusZone, resolveOnce]);

  const onAllowSession = useCallback(() => {
    if (focusZone !== "decision") return;
    resolveOnce({ behavior: "allow-session", addRule: true });
  }, [focusZone, resolveOnce]);

  const onDeny = useCallback(() => {
    if (focusZone !== "decision") {
      setFocusZone("decision");
      return;
    }
    resolveOnce({ behavior: "deny" });
  }, [focusZone, resolveOnce]);

  const onAbort = useCallback(() => {
    resolveOnce({ behavior: "abort" });
  }, [resolveOnce]);

  useKeybinding("modal:confirm", onAllow, "modal");
  useKeybinding("modal:yes", onAllow, "modal");
  useKeybinding("modal:allowSession", onAllowSession, "modal");
  useKeybinding("modal:deny", onDeny, "modal");
  useKeybinding("modal:no", onDeny, "modal");
  useKeybinding("modal:cancel", onDeny, "modal");

  const cycleDetailTab = useCallback((delta: number) => {
    setDetailTab((current) => {
      const currentIndex = detailTabs.indexOf(current);
      const nextIndex =
        (currentIndex + delta + detailTabs.length) % detailTabs.length;
      return detailTabs[nextIndex] ?? current;
    });
  }, [detailTabs]);

  useEffect(() => {
    const emitter = stdin.internal_eventEmitter;
    if (!emitter) return;
    const listener = (event: InputEvent): void => {
      if (resolvedRef.current) return;
      if (!event.key.ctrl && !event.key.meta && event.input === "c") {
        onAbort();
        return;
      }
      if (event.key.tab) {
        setFocusZone((current) =>
          current === "decision" ? "details" : "decision",
        );
        return;
      }
      if (focusZone !== "details") return;
      if (event.key.escape) {
        setFocusZone("decision");
        return;
      }
      if (
        event.key.leftArrow ||
        event.key.upArrow ||
        (!event.key.ctrl && !event.key.meta && (event.input === "h" || event.input === "k"))
      ) {
        cycleDetailTab(-1);
        return;
      }
      if (
        event.key.rightArrow ||
        event.key.downArrow ||
        (!event.key.ctrl && !event.key.meta && (event.input === "j" || event.input === "l"))
      ) {
        cycleDetailTab(1);
      }
    };
    emitter.on("input", listener);
    return () => {
      emitter.removeListener("input", listener);
    };
  }, [cycleDetailTab, focusZone, onAbort, stdin]);

  const body = renderToolBody(request.tool, request.args);

  return (
    <Box
      borderStyle="double"
      padding={1}
      flexDirection="column"
      borderColor={focusColor}
    >
      <Box justifyContent="space-between">
        <Text color={warningColor}>{`Approval needed · ${request.tool}`}</Text>
        <Text color={riskColor(risk.level)}>{`${risk.label} RISK`}</Text>
      </Box>
      <Text dim>
        {`${queuePositionLabel(queuePosition, queuedCount)} · ${humanizeAge(
          activeQueueEntry.submittedAt,
        )} old · turn ${request.turnId}`}
      </Text>
      <Text dim>{`workspace · ${request.workspacePath}`}</Text>
      <Text dim>{`scope · ${summarizeScope(request.tool, request.args)}`}</Text>
      {request.reason ? <Text dim>{`reason · ${request.reason}`}</Text> : null}
      {requestMessage ? <Text dim>{`message · ${requestMessage}`}</Text> : null}
      {activeQueueEntry.blockedPath ? (
        <Text dim>{`blocked path · ${activeQueueEntry.blockedPath}`}</Text>
      ) : null}
      {activeQueueEntry.suggestions && activeQueueEntry.suggestions.length > 0 ? (
        <Text dim>{`suggestions · ${activeQueueEntry.suggestions.length} policy updates available`}</Text>
      ) : null}
      {risk.notes.length > 0 ? (
        <Text dim>{`signal · ${risk.notes.join(" · ")}`}</Text>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Text color={accentColor}>
          {detailTabs
            .map((tab) =>
              tab === detailTab ? `[${tabLabel(tab)}]` : tabLabel(tab),
            )
            .join("  ")}
        </Text>
        <Text dim>
          {focusZone === "details"
            ? `Details focused · Tab/${cancelKey} returns to actions · arrows or H/J/K/L switch tabs`
            : `Actions focused · ${confirmKey} allows · ${allowSessionKey} allows for session · ${denyKey} denies · C aborts`}
        </Text>
      </Box>

      <Box
        marginTop={1}
        borderStyle="round"
        borderColor={focusZone === "details" ? focusColor : warningColor}
        paddingX={1}
        flexDirection="column"
      >
        {detailTab === "summary" ? (
          <Box flexDirection="column">
            <Text>{`queue · ${queuedBehind} waiting behind this request`}</Text>
            <Text>{`tool · ${request.tool}`}</Text>
            <Text>{`request id · ${request.requestId}`}</Text>
            <Text>{`cwd · ${request.workspacePath}`}</Text>
            <Text>{`age · ${humanizeAge(activeQueueEntry.submittedAt)}`}</Text>
            {requestMessage ? <Text>{`message · ${requestMessage}`}</Text> : null}
            {activeQueueEntry.blockedPath ? (
              <Text>{`blocked path · ${activeQueueEntry.blockedPath}`}</Text>
            ) : null}
          </Box>
        ) : null}
        {detailTab === "preview" ? body : null}
        {detailTab === "raw" ? (
          <Box flexDirection="column">
            <Text dim>raw args</Text>
            <Text>{rawPreview}</Text>
          </Box>
        ) : null}
        {detailTab === "queue" ? (
          <Box flexDirection="column">
            {queuePreview.map((entry, index) => (
              <Text key={entry.requestId}>
                {`${index === 0 ? ">" : " "} ${queuePosition + index + 1}. ${queueEntryLabel(
                  entry,
                )} · ${humanizeAge(entry.submittedAt)}`}
              </Text>
            ))}
            {queuePreview.length === 0 ? (
              <Text>{`> 1. ${request.tool} · ${summarizeScope(
                request.tool,
                request.args,
              )}`}</Text>
            ) : null}
          </Box>
        ) : null}
      </Box>

      <Box
        marginTop={1}
        borderStyle="round"
        borderColor={focusZone === "decision" ? focusColor : accentColor}
        paddingX={1}
        flexDirection="column"
      >
        <Text>{`[Y] Allow once${focusZone === "decision" ? "  <Enter>" : ""}`}</Text>
        <Text>[A] Allow this session</Text>
        <Text>{`[D] Deny${focusZone === "decision" ? "  <N / Esc>" : "  <Esc returns to actions>"}`}</Text>
        <Text>[C] Abort without approving</Text>
      </Box>
    </Box>
  );
};

export default ApprovalOverlay;
