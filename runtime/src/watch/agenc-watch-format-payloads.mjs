/**
 * Payload formatting helpers for the watch TUI: sessions, status, tools,
 * history, logs, run detail, and usage summaries.
 *
 * Pure functions — no watch state or side-effect dependencies.
 */

import {
  formatCompactNumber,
  sanitizeDisplayText,
  sanitizeInlineText,
  sanitizeLargeText,
  truncate,
  tryPrettyJson,
} from "./agenc-watch-text-utils.mjs";
import {
  resolveWatchSessionLabel,
} from "./agenc-watch-session-indexing.mjs";
import { normalizeSessionValue } from "./agenc-watch-session-utils.mjs";

export function formatCommandPaletteText(command, colorPalette) {
  const aliasSuffix =
    Array.isArray(command.aliases) && command.aliases.length > 0
      ? `  ${colorPalette.fog}${command.aliases.join(", ")}${colorPalette.reset}`
      : "";
  return `${colorPalette.magenta}${command.usage}${colorPalette.reset}${aliasSuffix}\n${colorPalette.softInk}${command.description}${colorPalette.reset}`;
}

export function formatSessionSummaries(payload, {
  sessionLabels = null,
  activeSessionId = null,
} = {}) {
  if (!Array.isArray(payload) || payload.length === 0) {
    return "No resumable sessions found.";
  }
  const normalizedActiveSessionId = normalizeSessionValue(activeSessionId);
  return payload
    .map((session) => {
      const sessionId = session?.sessionId ?? "unknown";
      const localLabel = resolveWatchSessionLabel(sessionId, sessionLabels);
      const when = session?.lastActiveAt
        ? new Date(session.lastActiveAt).toLocaleString("en-US", {
          hour12: false,
        })
        : "unknown";
      const lines = [
        `session: ${sessionId}${normalizeSessionValue(sessionId) === normalizedActiveSessionId ? " [active]" : ""}`,
        `label: ${session?.label ?? "n/a"}`,
      ];
      if (localLabel) {
        lines.push(`local label: ${localLabel}`);
      }
      if (session?.workspaceRoot || session?.cwd) {
        lines.push(`workspace: ${session?.workspaceRoot ?? session?.cwd}`);
      }
      if (session?.model || session?.provider) {
        lines.push(
          `model: ${[session?.model, session?.provider ? `via ${session.provider}` : null]
            .filter(Boolean)
            .join(" ")}`,
        );
      }
      lines.push(
        `messages: ${session?.messageCount ?? 0}`,
        `last active: ${when}`,
      );
      return lines.join("\n");
    })
    .join("\n\n");
}

export function formatHistoryPayload(payload) {
  if (!Array.isArray(payload) || payload.length === 0) {
    return "No history for this session.";
  }
  return payload
    .map((entry) => {
      const stamp = entry?.timestamp
        ? new Date(entry.timestamp).toLocaleTimeString("en-US", {
          hour12: false,
        })
        : "--:--:--";
      const sender = String(entry?.sender ?? "unknown").toUpperCase();
      const content = sanitizeDisplayText(entry?.content ?? "(empty)");
      return `${stamp} ${sender}\n${content}`;
    })
    .join("\n\n");
}

export function formatStatusPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return tryPrettyJson(payload ?? {});
  }
  const heapUsedMB = Number(payload.memoryUsage?.heapUsedMB);
  const rssMB = Number(payload.memoryUsage?.rssMB);
  const backgroundRuns = payload.backgroundRuns;
  const connectorStatuses = Array.isArray(payload.channelStatuses)
    ? payload.channelStatuses
    : [];
  return [
    `state: ${payload.state ?? "unknown"}`,
    `uptime: ${formatCompactNumber(payload.uptimeMs) ?? payload.uptimeMs ?? "n/a"} ms`,
    `active sessions: ${payload.activeSessions ?? "n/a"}`,
    `control plane: ${payload.controlPlanePort ?? "n/a"}`,
    `pid: ${payload.pid ?? "n/a"}`,
    `heap: ${Number.isFinite(heapUsedMB) ? `${heapUsedMB.toFixed(2)} MB` : "n/a"}`,
    `rss: ${Number.isFinite(rssMB) ? `${rssMB.toFixed(2)} MB` : "n/a"}`,
    `llm: ${payload.llmProvider && payload.llmModel ? `${payload.llmProvider}:${payload.llmModel}` : "n/a"}`,
    `agent: ${payload.agentName ?? "n/a"}`,
    `channels: ${Array.isArray(payload.channels) ? payload.channels.join(", ") : "n/a"}`,
    `connectors: ${connectorStatuses.length > 0
      ? connectorStatuses
          .map((entry) => {
            const mode = typeof entry.mode === "string" ? `/${entry.mode}` : "";
            const pending = entry.pendingRestart ? ",restart" : "";
            return `${entry.name}:${entry.active ? entry.health : entry.enabled ? "configured" : "disabled"}${mode}${pending}`;
          })
          .join(", ")
      : "n/a"}`,
    `durable runs: ${!backgroundRuns
      ? "pending"
      : backgroundRuns.enabled
        ? "enabled"
        : `disabled (${backgroundRuns.disabledReason ?? backgroundRuns.disabledCode ?? "unknown"})`}`,
    `durable operator: ${!backgroundRuns
      ? "pending"
      : backgroundRuns.operatorAvailable
        ? "ready"
        : backgroundRuns.disabledReason ?? "unavailable"}`,
    `active durable runs: ${Number.isFinite(Number(backgroundRuns?.activeTotal))
      ? Number(backgroundRuns.activeTotal)
      : "n/a"}`,
    `queued wake signals: ${Number.isFinite(Number(backgroundRuns?.queuedSignalsTotal))
      ? Number(backgroundRuns.queuedSignalsTotal)
      : "n/a"}`,
  ].join("\n");
}

export function statusFeedFingerprint(payload) {
  if (!payload || typeof payload !== "object") {
    return "none";
  }
  return JSON.stringify({
    state: typeof payload.state === "string" ? payload.state : null,
    agentName: typeof payload.agentName === "string" ? payload.agentName : null,
    pid: Number.isFinite(Number(payload.pid)) ? Number(payload.pid) : null,
    activeSessions: Number.isFinite(Number(payload.activeSessions))
      ? Number(payload.activeSessions)
      : null,
    activeRuns: Number.isFinite(Number(payload.backgroundRuns?.activeTotal))
      ? Number(payload.backgroundRuns.activeTotal)
      : null,
    queuedSignals: Number.isFinite(Number(payload.backgroundRuns?.queuedSignalsTotal))
      ? Number(payload.backgroundRuns.queuedSignalsTotal)
      : null,
    durableRunsEnabled:
      typeof payload.backgroundRuns?.enabled === "boolean"
        ? payload.backgroundRuns.enabled
        : null,
    durableOperatorAvailable:
      typeof payload.backgroundRuns?.operatorAvailable === "boolean"
        ? payload.backgroundRuns.operatorAvailable
        : null,
    durableDisabledCode:
      typeof payload.backgroundRuns?.disabledCode === "string"
        ? payload.backgroundRuns.disabledCode
        : null,
    channelStatuses: Array.isArray(payload.channelStatuses)
      ? payload.channelStatuses.map((entry) => ({
          name: typeof entry?.name === "string" ? entry.name : null,
          configured: entry?.configured === true,
          enabled: entry?.enabled === true,
          active: entry?.active === true,
          health: typeof entry?.health === "string" ? entry.health : null,
          mode: typeof entry?.mode === "string" ? entry.mode : null,
          pendingRestart: entry?.pendingRestart === true,
        }))
      : null,
  });
}

export function cockpitFeedFingerprint(payload) {
  if (!payload || typeof payload !== "object") {
    return "none";
  }
  return JSON.stringify({
    sessionId:
      typeof payload.session?.sessionId === "string"
        ? payload.session.sessionId
        : null,
    workflowStage:
      typeof payload.session?.workflowStage === "string"
        ? payload.session.workflowStage
        : null,
    repoBranch:
      typeof payload.repo?.branch === "string" ? payload.repo.branch : null,
    repoHead:
      typeof payload.repo?.head === "string" ? payload.repo.head : null,
    dirtyCounts:
      payload.repo?.dirtyCounts && typeof payload.repo.dirtyCounts === "object"
        ? payload.repo.dirtyCounts
        : null,
    worktreeCount: Array.isArray(payload.worktrees?.entries)
      ? payload.worktrees.entries.length
      : 0,
    reviewStatus:
      typeof payload.review?.status === "string" ? payload.review.status : null,
    verificationStatus:
      typeof payload.verification?.status === "string"
        ? payload.verification.status
        : null,
    verificationVerdict:
      typeof payload.verification?.verdict === "string"
        ? payload.verification.verdict
        : null,
    approvalCount: Number.isFinite(Number(payload.approvals?.count))
      ? Number(payload.approvals.count)
      : 0,
    ownershipCount: Array.isArray(payload.ownership) ? payload.ownership.length : 0,
  });
}

export function formatLogPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return tryPrettyJson(payload ?? {});
  }
  if (Array.isArray(payload.lines) && payload.lines.length > 0) {
    return payload.lines.join("\n");
  }
  if (typeof payload.text === "string" && payload.text.trim()) {
    return payload.text;
  }
  return tryPrettyJson(payload);
}

export function summarizeUsage(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const parts = [];
  const prompt = formatCompactNumber(payload.promptTokens);
  const effectiveWindow = formatCompactNumber(
    payload.effectiveContextWindowTokens ?? payload.contextWindowTokens,
  );
  const percentUsed =
    typeof payload.contextPercentUsed === "number" &&
    Number.isFinite(payload.contextPercentUsed)
      ? `${payload.contextPercentUsed.toFixed(payload.contextPercentUsed >= 10 ? 0 : 1)}% used`
      : null;
  const maxOutput = formatCompactNumber(payload.maxOutputTokens);
  if (prompt) parts.push(`${prompt} current`);
  if (effectiveWindow) parts.push(`${effectiveWindow} effective`);
  if (percentUsed) parts.push(percentUsed);
  if (maxOutput) parts.push(`${maxOutput} max out`);
  if (payload.compacted) parts.push("compacted");
  return parts.length > 0 ? parts.join(" / ") : null;
}

export function firstMeaningfulLine(value) {
  if (typeof value !== "string") return null;
  const line = sanitizeLargeText(value)
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ? truncate(line, 160) : null;
}

export function contentPreviewLines(value, maxLines = 3) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }
  return sanitizeLargeText(value)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\r/g, "").trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, maxLines)
    .map((line) => truncate(line, 160));
}

export function compactSessionToken(value, maxChars = 8) {
  const text = sanitizeInlineText(String(value ?? ""));
  if (!text) return null;
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

export function buildToolSummary(parsed) {
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? [parsed]
      : [];
  if (entries.length === 0) {
    return [];
  }
  const lines = [];
  const seen = new Set();
  const add = (key, value) => {
    if (value === undefined || value === null || value === "" || seen.has(key)) {
      return;
    }
    lines.push(`${key}: ${String(value)}`);
    seen.add(key);
  };
  for (const parsedEntry of entries) {
    add("state", parsedEntry.executor_state ?? parsedEntry.state);
    add("status", parsedEntry.status);
    add("ready", parsedEntry.ready);
    add("label", parsedEntry.label);
    add("serverId", parsedEntry.serverId);
    add("processId", parsedEntry.processId);
    add("sessionId", parsedEntry.sessionId);
    add("port", parsedEntry.port);
    add("url", parsedEntry.healthUrl ?? parsedEntry.currentUrl ?? parsedEntry.url);
    add("title", parsedEntry.title);
    add("pid", parsedEntry.pid);
    add("exitCode", parsedEntry.exitCode);
    add("scenario", parsedEntry.scenario);
    add("god mode", parsedEntry.god_mode_enabled);
    add("artifact", parsedEntry.mimeType);
    if (typeof parsedEntry.error === "string") {
      add("error", sanitizeInlineText(parsedEntry.error));
    }
    if (typeof parsedEntry.message === "string") {
      add("message", sanitizeInlineText(parsedEntry.message));
    }
    if (typeof parsedEntry.stderr === "string" && parsedEntry.stderr.trim()) {
      add("stderr", sanitizeInlineText(parsedEntry.stderr.split("\n")[0]));
    }
    if (Array.isArray(parsedEntry.objectives) && parsedEntry.objectives.length > 0) {
      add("objective", parsedEntry.objectives[0]?.type);
    }
    if (
      parsedEntry.objective &&
      typeof parsedEntry.objective === "object" &&
      !Array.isArray(parsedEntry.objective)
    ) {
      add("objective", parsedEntry.objective.type);
    }
    if (
      parsedEntry.game_variables &&
      typeof parsedEntry.game_variables === "object" &&
      !Array.isArray(parsedEntry.game_variables)
    ) {
      add("health", parsedEntry.game_variables.HEALTH);
      add("armor", parsedEntry.game_variables.ARMOR);
      add("kills", parsedEntry.game_variables.KILLCOUNT);
    }
    if (
      typeof parsedEntry.recentOutput === "string" &&
      parsedEntry.recentOutput.trim()
    ) {
      lines.push(`recent output: ${truncate(sanitizeInlineText(parsedEntry.recentOutput.trim()), 180)}`);
    }
  }
  return lines.slice(0, 8);
}

export function summarizeRunDetail(detail, watchState) {
  if (!detail || typeof detail !== "object") {
    return null;
  }
  const lines = [];
  const add = (label, value) => {
    if (value === undefined || value === null || value === "") return;
    lines.push(`${label}: ${String(value)}`);
  };
  const completionState =
    typeof detail.completionState === "string" && detail.completionState.trim()
      ? detail.completionState.trim()
      : null;
  const remainingRequirements = Array.isArray(detail.remainingRequirements)
    ? detail.remainingRequirements
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean)
    : [];
  add("objective", detail.objective ?? watchState.currentObjective);
  add("phase", detail.currentPhase ?? watchState.runPhase);
  add("completion state", completionState ?? watchState.runState);
  if (!completionState || completionState !== detail.state) {
    add("state", detail.state ?? watchState.runState);
  }
  if (remainingRequirements.length > 0) {
    add("remaining requirements", remainingRequirements.join(", "));
  }
  add("explanation", detail.explanation);
  add("last update", detail.lastUserUpdate);
  add("verified evidence", detail.lastToolEvidence);
  add("carry-forward", detail.carryForwardSummary);
  add("blocker", detail.blockerSummary);
  add(
    "run controls",
    detail.availability?.controlAvailable === false ? "unavailable" : "available",
  );
  add(
    "checkpoint retry",
    detail.checkpointAvailable === false ? "unavailable" : "available",
  );
  add("next check", detail.nextCheckAt ? new Date(detail.nextCheckAt).toLocaleTimeString("en-US", { hour12: false }) : undefined);
  add("next heartbeat", detail.nextHeartbeatAt ? new Date(detail.nextHeartbeatAt).toLocaleTimeString("en-US", { hour12: false }) : undefined);
  add("pending signals", detail.pendingSignals);
  add("watches", detail.watchCount);
  return lines.slice(0, 10);
}
