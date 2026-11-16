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
 *   - Accounting totals use recorded usage and published peak rates (or a
 *     provider-reported charge). A separate billed estimate applies recorded
 *     off-peak schedules per call; neither figure is a provider invoice.
 *   - Per-agent $ is an ESTIMATE derived from the agent's total token count +
 *     model (the TUI surfaces only a total, not an input/output split). Every
 *     estimated figure is suffixed "est."; a dash is shown when a real number
 *     is genuinely unknown. We never fabricate a cost.
 *
 * Runs `immediate: true` — no LLM round-trip.
 *
 * @module
 */

import {
  estimateAgentCostUsd,
  formatTokenCount,
  formatUsdCost,
} from "../session/cost.js";
import { usageCachePercent } from "../session/usage-display.js";
import { asRecord } from "../utils/record.js";
import { isAdmissionUsageSummary } from "../session/usage-summary.js";
import type { UnpricedUsageCall } from "../budget/admission-types.js";
import { openAsyncLocalJsxCommand } from "./local-jsx-command.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

/** One per-model row of real, provider-reported usage. */
export interface CostModelRow {
  readonly modelCalls?: number;
  readonly cachedInputTokens?: number;
  readonly cacheInputTokens?: number;
  readonly cacheUnreportedCalls?: number;
  readonly billedEstimateUsd?: number;
  readonly planCalls?: number;
  readonly meteredCalls?: number;
  readonly apiEquivalentUsd?: number;
  readonly apiEquivalentUnknown?: boolean;
  readonly label: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly costEstimated?: boolean;
  readonly hasUnknownCost?: boolean;
}

/** One per-agent row. Tokens are real; cost is an estimate (or unknown). */
export interface CostAgentRow {
  readonly runId?: string;
  readonly costUsd?: number;
  readonly costEstimated?: boolean;
  readonly hasUnknownCost?: boolean;
  readonly label: string;
  readonly status: string;
  readonly tokenCount?: number;
  readonly toolUseCount?: number;
  /** Estimated USD cost; undefined when not derivable (no tokens/model). */
  readonly estimatedCostUsd?: number;
}

export interface CostReport {
  readonly planCalls?: number;
  readonly apiEquivalentUsd?: number;
  readonly apiEquivalentUnknown?: boolean;
  readonly agentModels?: readonly (CostModelRow & { readonly runId: string; readonly agentLabel: string })[];
  /** Accounting total, before recorded off-peak adjustments. */
  readonly totalCostUsd?: number;
  readonly billedEstimateUsd?: number;
  /**
   * True when the total includes estimated pricing. Surfaced as "est."
   * so we never present an estimate as a measured number.
   */
  readonly totalIsEstimated?: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly turns?: number;
  /** True when any model in the session has unknown pricing. */
  readonly hasUnknownCost: boolean;
  readonly unpricedCalls?: readonly UnpricedUsageCall[];
  readonly unpricedCallCount?: number;
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
    readonly planCalls?: number;
    readonly apiEquivalentUsd?: number;
    readonly apiEquivalentUnknown?: boolean;
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
      ...(usage.planCalls !== undefined ? { planCalls: usage.planCalls, apiEquivalentUsd: usage.apiEquivalentUsd, apiEquivalentUnknown: usage.apiEquivalentUnknown } : {}),
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
      ...(usage.planCalls !== undefined ? { planCalls: usage.planCalls, apiEquivalentUsd: usage.apiEquivalentUsd, apiEquivalentUnknown: usage.apiEquivalentUnknown } : {}),
      ...(usage.agentModels !== undefined ? { agentModels: usage.agentModels.map(row => ({
        ...row, label: row.provider ? `${row.provider}/${row.model}` : row.model,
        agentLabel: row.runId === usage.runId ? "lead" : agents.find(agent => agent.runId === row.runId)?.label ?? row.runId,
      })) } : {}),
      ...(usage.billedEstimateUsd !== undefined ? { billedEstimateUsd: usage.billedEstimateUsd } : {}),
      ...(usage.costEstimated ? { totalIsEstimated: true } : {}),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      hasUnknownCost: usage.hasUnknownCost,
      ...(usage.unpricedCalls !== undefined ? { unpricedCalls: usage.unpricedCalls } : {}),
      ...(usage.unpricedCallCount !== undefined ? { unpricedCallCount: usage.unpricedCallCount } : {}),
      models: usage.models.map((model) => ({
        ...model,
        label: model.provider ? `${model.provider}/${model.model}` : model.model,
        inputTokens: model.inputTokens,
        outputTokens: model.outputTokens,
        costUsd: model.costUsd,
        ...(model.hasUnknownCost ? { hasUnknownCost: true } : {}),
        ...(model.costEstimated ? { costEstimated: true } : {}),
      })),
      agents: usage.agents.map((agent) => {
        const metadata = agents.find((row) => row.runId === agent.runId);
        return {
          runId: agent.runId,
          label: metadata?.label ?? agent.runId,
          status: metadata?.status ?? "recorded",
          tokenCount: agent.totalTokens,
          costUsd: agent.costUsd,
          ...(agent.hasUnknownCost ? { hasUnknownCost: true } : {}),
          ...(agent.costEstimated ? { costEstimated: true } : {}),
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
    ...(totals.models.some(row => (row.planCalls ?? 0) > 0) ? {
      planCalls: totals.models.reduce((sum, row) => sum + (row.planCalls ?? 0), 0),
      apiEquivalentUsd: totals.models.reduce((sum, row) => sum + (row.apiEquivalentUsd ?? 0), 0),
      apiEquivalentUnknown: totals.models.some(row => row.apiEquivalentUnknown),
    } : {}),
    models: totals.models,
    agents,
  };
}

/**
 * Render a {@link CostReport} as the plain-text fallback (used when the TUI
 * JSX surface isn't available, and as the source the modal re-parses).
 */
export function unpricedCallDescription(call: UnpricedUsageCall): string {
  const model = call.provider && call.model ? `${call.provider}/${call.model}` : call.model ?? call.kind;
  const knownReasons: Readonly<Record<string, string>> = {
    missing_provider_usage: "provider returned no usage",
    provider_call_failed_after_dispatch: "provider call failed after dispatch; usage unavailable",
    reported_usage_cost_unknown: "reported usage has no price",
    missing_tool_usage: "tool returned no usage",
  };
  const reason = call.reason.startsWith("cancelled_after_dispatch:")
    ? `cancelled after dispatch (${call.reason.slice("cancelled_after_dispatch:".length)}); provider usage unavailable`
    : (knownReasons[call.reason] ?? call.reason.replaceAll("_", " "));
  return `${model} · ${call.kind === "model_turn" ? "model call" : call.kind} ${call.stepId} · ${reason}`;
}

export function costModelDetail(row: CostModelRow): string {
  const share = usageCachePercent(row);
  const cache = share === null ? "cache unknown" : `${share}% cached${(row.cacheUnreportedCalls ?? 0) > 0 ? " (reported calls only)" : ""}`;
  const billed = row.billedEstimateUsd ?? row.costUsd;
  return [
    row.modelCalls === undefined ? "calls unknown" : `${row.modelCalls} calls`,
    `${formatTokenCount(row.inputTokens)} in`, cache, `${formatTokenCount(row.outputTokens)} out`,
    `${row.hasUnknownCost ? "≥" : ""}${formatUsdCost(billed)} billed${row.costEstimated ? " est." : row.billedEstimateUsd === undefined ? " (peak est.)" : ""}`,
    (row.planCalls ?? 0) > 0 ? `plan (${row.planCalls} calls)` : "",
    (row.apiEquivalentUsd ?? 0) > 0 ? `${row.apiEquivalentUnknown ? "≥" : ""}${formatUsdCost(row.apiEquivalentUsd!)} API-equivalent`
      : row.apiEquivalentUnknown ? "API-equivalent unknown" : "",
  ].filter(Boolean).join(" · ");
}

export function formatCostReport(report: CostReport): string {
  const lines: string[] = [];
  if (report.totalCostUsd !== undefined) {
    const unknown = report.hasUnknownCost ? "≥" : "";
    const est = report.totalIsEstimated ? " est." : "";
    if ((report.planCalls ?? 0) > 0) lines.push(`Plan: ${report.planCalls} calls, no per-token charge`);
    if ((report.apiEquivalentUsd ?? 0) > 0) lines.push(`API-equivalent: ${report.apiEquivalentUnknown ? "≥" : ""}${formatUsdCost(report.apiEquivalentUsd!)} (reference only; not billed)`);
    if (report.apiEquivalentUnknown) lines.push("Some plan calls have unknown API-equivalent pricing.");
    lines.push(
      `Session cost: ${unknown}${formatUsdCost(report.totalCostUsd)}${est} (accounting; peak rates before off-peak discounts)`,
    );
    if (report.billedEstimateUsd !== undefined && !report.totalIsEstimated) {
      lines.push(`Billed estimate: ${unknown}${formatUsdCost(report.billedEstimateUsd)} (recorded per-call off-peak hours)`);
    }
  } else {
    lines.push("Session cost: unknown (cost tracking unavailable)");
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
        `  ${m.label}: ${costModelDetail(m)}`,

      );
    }
  }
  if (report.agentModels !== undefined) {
    lines.push("By agent / provider / model (lead and sub-agents):");
    for (const row of report.agentModels) lines.push(`  ${row.agentLabel} [${row.runId}] · ${row.label}: ${costModelDetail(row)}`);
  }
  if (report.agents.length > 0) {
    lines.push("Agents (accounting totals include tool charges):");
    for (const a of report.agents) {
      const tokens =
        a.tokenCount !== undefined ? `${formatTokenCount(a.tokenCount)} tokens` : "tokens unknown";
      const spend =
        a.costUsd !== undefined
          ? `${a.hasUnknownCost ? "≥" : ""}${formatUsdCost(a.costUsd)}${a.costEstimated ? " est." : ""}`
          : a.estimatedCostUsd !== undefined
          ? `${formatUsdCost(a.estimatedCostUsd)} est.`
          : "cost unknown";
      lines.push(`  ${a.status} ${a.label}: ${tokens} · ${spend}`);
    }
  } else if (report.agentModels === undefined) {
    lines.push("Agents: none active");
  }
  if (report.hasUnknownCost) {
    lines.push("Unpriced calls (excluded from the known cost):");
    for (const call of report.unpricedCalls ?? []) lines.push(`  ${unpricedCallDescription(call)} · run ${call.runId}`);
    const shown = report.unpricedCalls?.length ?? 0;
    if (report.unpricedCallCount !== undefined && report.unpricedCallCount > shown) {
      lines.push(`  Showing ${shown} of ${report.unpricedCallCount} unpriced calls.`);
    } else if (shown === 0) {
      lines.push("  Call details unavailable for this older session.");
    }
  }
  lines.push("Per-model rows count model calls. Session and agent totals also include separately reported tool charges.");
  lines.push("Input includes cache reads and writes. Cached share uses only calls with a reported cache count; missing counts are marked.");
  lines.push("Billed USD is an estimate. Plan calls have no per-token charge; API-equivalent is a reference value only.");
  lines.push("Billed estimates apply recorded schedules only; other discounts and holidays may be missing.");
  lines.push("Calls count reported attempts, including retries with usage. Failed attempts without usage are listed as unpriced. Old calls may lack billing-route or cache details.");
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
    const { createElement } = await import("react");
    return createElement(CostUsageModal, { report, onDone: close });
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
