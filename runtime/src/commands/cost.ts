/**
 * `/cost` — session cost & token transparency (alias `/stats`).
 *
 * Surfaces what the session has actually spent: cumulative USD cost, token
 * totals (input/output), per-model breakdown, and a per-agent breakdown for
 * any spawned fan-out agents currently in AppState. This is the discoverable
 * counterpart to Claude Code's `/usage` — agenc previously had no command that
 * answered "how much has this session cost?".
 *
 * Honesty contract:
 *   - Session $ and per-model $ are REAL (sourced from the CostSidecar, which
 *     tallies provider-reported token usage against the cost registry).
 *   - Per-agent $ is an ESTIMATE derived from the agent's total token count +
 *     model (the TUI surfaces only a total, not an input/output split). Every
 *     estimated figure is suffixed "est."; a dash is shown when a real number
 *     is genuinely unknown. We never fabricate a cost.
 *
 * Runs `immediate: true` — no LLM round-trip.
 *
 * @module
 */

import React from "react";

import {
  estimateAgentCostUsd,
  formatTokenCount,
  formatUsdCost,
} from "../session/cost.js";
import { asRecord } from "../utils/record.js";
import { isAdmissionUsageSummary } from "../session/usage-summary.js";
import { openAsyncLocalJsxCommand } from "./local-jsx-command.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

/** One per-model row of real, provider-reported usage. */
export interface CostModelRow {
  readonly label: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/** One per-agent row. Tokens are real; cost is an estimate (or unknown). */
export interface CostAgentRow {
  readonly runId?: string;
  readonly costUsd?: number;
  readonly label: string;
  readonly status: string;
  readonly tokenCount?: number;
  readonly toolUseCount?: number;
  /** Estimated USD cost; undefined when not derivable (no tokens/model). */
  readonly estimatedCostUsd?: number;
}

export interface CostReport {
  /** Real session total cost (USD), when the cost sidecar is available. */
  readonly totalCostUsd?: number;
  /**
   * True when {@link totalCostUsd}/{@link totalTokens} are not the sidecar's
   * real session figures but a fallback aggregated from the per-agent estimates
   * (e.g. a local/self-hosted model with no cost sidecar). Surfaced as "est."
   * so we never present an estimate as a measured number.
   */
  readonly totalIsEstimated?: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly turns?: number;
  /** True when any model in the session has unknown pricing. */
  readonly hasUnknownCost: boolean;
  readonly models: readonly CostModelRow[];
  readonly agents: readonly CostAgentRow[];
}

interface CostSidecarLike {
  getTotalCostUsd?: () => number;
  getTotalInputTokens?: () => number;
  getTotalOutputTokens?: () => number;
  getTotalTurns?: () => number;
  hasUnknownModelCost?: () => boolean;
  getSessionModelUsage?: () => ReadonlyArray<{
    readonly model: string;
    readonly provider?: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly costUsd: number;
  }>;
}

function readCostSidecar(session: unknown): CostSidecarLike | null {
  const services = asRecord(asRecord(session)?.services);
  const sidecar = services?.costSidecar;
  return asRecord(sidecar) as CostSidecarLike | null;
}

function callNumber(fn: (() => number) | undefined, receiver: CostSidecarLike): number | undefined {
  if (typeof fn !== "function") return undefined;
  const value = fn.call(receiver);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readSessionTotals(sidecar: CostSidecarLike | null): {
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  turns?: number;
  hasUnknownCost: boolean;
  models: CostModelRow[];
} {
  if (sidecar === null) {
    return { hasUnknownCost: false, models: [] };
  }
  const models: CostModelRow[] = (sidecar.getSessionModelUsage?.() ?? []).map(
    (usage) => ({
      label: usage.provider
        ? `${usage.provider}/${usage.model}`
        : usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
    }),
  );
  return {
    ...(callNumber(sidecar.getTotalCostUsd, sidecar) !== undefined
      ? { totalCostUsd: callNumber(sidecar.getTotalCostUsd, sidecar) }
      : {}),
    ...(callNumber(sidecar.getTotalInputTokens, sidecar) !== undefined
      ? { inputTokens: callNumber(sidecar.getTotalInputTokens, sidecar) }
      : {}),
    ...(callNumber(sidecar.getTotalOutputTokens, sidecar) !== undefined
      ? { outputTokens: callNumber(sidecar.getTotalOutputTokens, sidecar) }
      : {}),
    ...(callNumber(sidecar.getTotalTurns, sidecar) !== undefined
      ? { turns: callNumber(sidecar.getTotalTurns, sidecar) }
      : {}),
    hasUnknownCost:
      typeof sidecar.hasUnknownModelCost === "function"
        ? sidecar.hasUnknownModelCost() === true
        : false,
    models,
  };
}

function readAgentRows(appState: unknown): CostAgentRow[] {
  const tasks = asRecord(asRecord(appState)?.tasks);
  if (tasks === null) return [];
  const rows: CostAgentRow[] = [];
  for (const value of Object.values(tasks)) {
    const task = asRecord(value);
    if (task === null || task.type !== "local_agent") continue;
    // Skip the main-session pseudo-task; it is the orchestrator, surfaced
    // separately as the session totals, not a spawned fan-out agent.
    if (task.agentType === "main-session") continue;
    const progress = asRecord(task.progress);
    const tokenCount =
      typeof progress?.tokenCount === "number" ? progress.tokenCount : undefined;
    const toolUseCount =
      typeof progress?.toolUseCount === "number"
        ? progress.toolUseCount
        : undefined;
    const model = typeof task.model === "string" ? task.model : undefined;
    const estimate = estimateAgentCostUsd({ totalTokens: tokenCount, model });
    const name =
      typeof task.description === "string" && task.description.trim().length > 0
        ? task.description.trim()
        : typeof task.agentId === "string"
          ? task.agentId
          : "agent";
    const role = typeof task.agentType === "string" ? task.agentType : "agent";
    rows.push({
      ...(typeof task.agentId === "string" ? { runId: task.agentId } : {}),
      label: `${truncate(name, 40)} · ${role}`,
      status: typeof task.status === "string" ? task.status : "unknown",
      ...(tokenCount !== undefined ? { tokenCount } : {}),
      ...(toolUseCount !== undefined ? { toolUseCount } : {}),
      ...(estimate !== null ? { estimatedCostUsd: estimate.costUsd } : {}),
    });
  }
  return rows;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Build the cost report from a slash-command context. Pure aside from the two
 * read-only accessors (`session.services.costSidecar`, `appState.getAppState`)
 * — exported so tests can feed known usage and assert the rendered numbers.
 */
export function buildCostReport(ctx: SlashCommandContext): CostReport {
  const getAppState = ctx.appState?.getAppState;
  const agents =
    typeof getAppState === "function" ? readAgentRows(getAppState()) : [];

  const usage = ctx.appState?.getSessionUsage?.() ??
    ctx.session.services?.executionAdmission?.getUsageSummary?.();
  if (isAdmissionUsageSummary(usage)) {
    return {
      totalCostUsd: usage.costUsd,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      hasUnknownCost: usage.hasUnknownCost,
      models: usage.models.map((model) => ({
        label: model.provider ? `${model.provider}/${model.model}` : model.model,
        inputTokens: model.inputTokens,
        outputTokens: model.outputTokens,
        costUsd: model.costUsd,
      })),
      agents: usage.agents.map((agent) => {
        const metadata = agents.find((row) => row.runId === agent.runId);
        return {
          runId: agent.runId,
          label: metadata?.label ?? agent.runId,
          status: metadata?.status ?? "recorded",
          tokenCount: agent.totalTokens,
          costUsd: agent.costUsd,
          ...(metadata?.toolUseCount !== undefined ? { toolUseCount: metadata.toolUseCount } : {}),
        };
      }),
    };
  }

  const totals = readSessionTotals(readCostSidecar(ctx.session));
  const totalCostUsd = totals.totalCostUsd;
  const totalTokens =
    totals.inputTokens !== undefined && totals.outputTokens !== undefined
      ? totals.inputTokens + totals.outputTokens
      : undefined;

  return {
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
    ...(totals.inputTokens !== undefined
      ? { inputTokens: totals.inputTokens }
      : {}),
    ...(totals.outputTokens !== undefined
      ? { outputTokens: totals.outputTokens }
      : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(totals.turns !== undefined ? { turns: totals.turns } : {}),
    hasUnknownCost: totals.hasUnknownCost || agents.length > 0,
    models: totals.models,
    agents,
  };
}

/**
 * Render a {@link CostReport} as the plain-text fallback (used when the TUI
 * JSX surface isn't available, and as the source the modal re-parses).
 */
export function formatCostReport(report: CostReport): string {
  const lines: string[] = [];
  if (report.totalCostUsd !== undefined) {
    const unknown = report.hasUnknownCost ? " (some pricing unknown)" : "";
    const est = report.totalIsEstimated ? " est. (from agent tokens)" : "";
    lines.push(
      `Session cost: ${formatUsdCost(report.totalCostUsd)}${est}${unknown}`,
    );
  } else {
    lines.push("Session cost: — (cost tracking unavailable)");
  }
  const input = report.inputTokens;
  const output = report.outputTokens;
  if (input !== undefined || output !== undefined) {
    lines.push(
      `  • tokens: ${formatTokenCount(input ?? 0)} in / ${formatTokenCount(output ?? 0)} out` +
        (report.turns !== undefined ? ` · turns=${report.turns}` : ""),
    );
  } else if (report.totalTokens !== undefined) {
    lines.push(
      `  • tokens: ${formatTokenCount(report.totalTokens)} total${report.totalIsEstimated ? " est." : ""}`,
    );
  }
  if (report.models.length > 0) {
    lines.push("Models:");
    for (const m of report.models) {
      lines.push(
        `  ${m.label}: ${formatTokenCount(m.inputTokens)} in, ${formatTokenCount(m.outputTokens)} out (${formatUsdCost(m.costUsd)})`,
      );
    }
  }
  if (report.agents.length > 0) {
    lines.push("Agents:");
    for (const a of report.agents) {
      const tokens =
        a.tokenCount !== undefined ? `${formatTokenCount(a.tokenCount)} tokens` : "—";
      const spend =
        a.costUsd !== undefined
          ? formatUsdCost(a.costUsd)
          : a.estimatedCostUsd !== undefined
          ? `${formatUsdCost(a.estimatedCostUsd)} est.`
          : "—";
      lines.push(`  ${a.status} ${a.label}: ${tokens} · ${spend}`);
    }
  } else {
    lines.push("Agents: none active");
  }
  lines.push("Agent costs use recorded usage when available; estimates are marked est.");
  return lines.join("\n");
}

async function openCostModal(
  ctx: SlashCommandContext,
  report: CostReport,
): Promise<boolean> {
  return openAsyncLocalJsxCommand(ctx, async (close) => {
    const { CostUsageModal } = await import(
      "../tui/components/v2/CostUsageModal.js"
    );
    return React.createElement(CostUsageModal, { report, onDone: close });
  });
}

export const costCommand: SlashCommand = {
  name: "cost",
  aliases: ["stats"],
  description: "Show session cost, token usage, and per-agent spend",
  supportedSurfaces: ["runtime", "daemon-tui"],
  immediate: true,
  supportsNonInteractive: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const report = buildCostReport(ctx);
      const text = formatCostReport(report);
      if (await openCostModal(ctx, report)) {
        return { kind: "skip" };
      }
      return { kind: "text", text };
    }),
};
