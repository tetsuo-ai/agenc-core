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
import { cacheUnknownNote, planLabelFor, usageCachePercent } from "../session/usage-display.js";
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
  /** `tools`: an agent's paid tool work in one row; `toolCharges` counts those charges. */
  readonly kind?: "tools";
  readonly toolCharges?: number;
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
  /** The subscription that covers the plan calls, by name ("ChatGPT plan"). */
  readonly planLabel?: string;
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
  /** `agentLabel`: the name of the agent that made the call ("lead", "Monowire"). */
  readonly unpricedCalls?: readonly (UnpricedUsageCall & { readonly agentLabel?: string })[];
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
 * One row per agent and model, the lead first, then the sub-agents in ledger
 * order. Agents go by name; a run id (its first 8 characters) is added only
 * where two agents share a name.
 */
function agentModelRows(
  rows: NonNullable<import("../budget/admission-types.js").AdmissionUsageSummary["agentModels"]>,
  leadRunId: string,
  agentLabel: (runId: string) => string,
): NonNullable<CostReport["agentModels"]> {
  const named = rows.map(row => ({
    ...row, label: row.kind === "tools" ? "tool charges" : row.provider ? `${row.provider}/${row.model}` : row.model,
    agentLabel: agentLabel(row.runId),
  }));
  return [...named.filter(row => row.runId === leadRunId), ...named.filter(row => row.runId !== leadRunId)];
}

/**
 * The name of each agent of a session: "lead", or the sub-agent's name. A run
 * id (its first 8 characters) is added only where two agents share a name.
 */
function agentNamer(runIds: readonly string[], leadRunId: string, agents: readonly CostAgentRow[]): (runId: string) => string {
  // The task label is "name · role"; the report names the agent only. A
  // sub-agent the session has no name for any more (a cancelled one leaves
  // the task list) is numbered in ledger order, never shown by its id.
  const unnamed = new Map<string, string>();
  for (const runId of runIds) {
    if (runId !== leadRunId && !agents.some(agent => agent.runId === runId) && !unnamed.has(runId)) {
      unnamed.set(runId, `sub-agent ${unnamed.size + 1}`);
    }
  }
  const nameOf = (runId: string): string =>
    runId === leadRunId ? "lead" : agents.find(agent => agent.runId === runId)?.label.split(" · ")[0] ?? unnamed.get(runId) ?? "a sub-agent";
  const runsByName = new Map<string, Set<string>>();
  for (const runId of runIds) runsByName.set(nameOf(runId), (runsByName.get(nameOf(runId)) ?? new Set()).add(runId));
  return runId => {
    const name = nameOf(runId);
    return (runsByName.get(name)?.size ?? 1) > 1 ? `${name} [${runId.slice(0, 8)}]` : name;
  };
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
    const agentLabel = agentNamer([...(usage.agentModels ?? []).map(row => row.runId),
      ...(usage.unpricedCalls ?? []).map(call => call.runId)], usage.runId, agents);
    return {
      totalCostUsd: usage.costUsd,
      ...(usage.planCalls !== undefined ? { planCalls: usage.planCalls, apiEquivalentUsd: usage.apiEquivalentUsd, apiEquivalentUnknown: usage.apiEquivalentUnknown } : {}),
      ...((usage.planCalls ?? 0) > 0 ? { planLabel: planLabelFor(usage.models.filter(row => (row.planCalls ?? 0) > 0).map(row => row.provider)) } : {}),
      ...(usage.agentModels !== undefined ? { agentModels: agentModelRows(usage.agentModels, usage.runId, agentLabel) } : {}),
      ...(usage.billedEstimateUsd !== undefined ? { billedEstimateUsd: usage.billedEstimateUsd } : {}),
      ...(usage.costEstimated ? { totalIsEstimated: true } : {}),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      hasUnknownCost: usage.hasUnknownCost,
      ...(usage.unpricedCalls !== undefined ? { unpricedCalls: usage.unpricedCalls.map(call => ({ ...call, agentLabel: agentLabel(call.runId) })) } : {}),
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
      planLabel: planLabelFor(totals.models.filter(row => (row.planCalls ?? 0) > 0)
        .map(row => (row.label.includes("/") ? row.label.slice(0, row.label.indexOf("/")) : undefined))),
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
/**
 * One call without reported usage: the agent's name, the model and a plain
 * reason. Step and run ids stay in the ledger; they mean nothing to a reader.
 */
export function unpricedCallDescription(call: UnpricedUsageCall & { readonly agentLabel?: string }): string {
  const model = call.provider && call.model ? `${call.provider}/${call.model}` : call.model ?? call.provider;
  const what = call.kind === "model_turn" ? "model call" : call.kind === "tool_exec" ? "tool call" : call.kind.replaceAll("_", " ");
  const knownReasons: Readonly<Record<string, string>> = {
    missing_provider_usage: "the provider reported no usage",
    provider_call_failed_after_dispatch: "failed after it was sent, no usage reported",
    reported_usage_cost_unknown: "usage reported, but no price is known",
    missing_tool_usage: "the tool reported no usage",
  };
  const reason = call.reason.startsWith("cancelled_after_dispatch:")
    ? `cancelled after it was sent (${call.reason.slice("cancelled_after_dispatch:".length).replaceAll("_", " ")}), no usage reported`
    : (knownReasons[call.reason] ?? call.reason.replaceAll("_", " "));
  // A plan call has no per-token charge, so a missing usage report cannot hide money.
  const plan = call.plan ? `; ${planLabelFor([call.provider])} call, nothing billed` : "";
  return `${call.agentLabel ?? "an agent"} · ${model ? `${model} ` : ""}${what} · ${reason}${plan}`;
}

export function costModelDetail(row: CostModelRow): string {
  if (row.kind === "tools") {
    // Tool fees are not discounted off-peak: billed is what they cost.
    const charges = row.toolCharges ?? 0;
    return `${charges} ${charges === 1 ? "charge" : "charges"} · ${row.hasUnknownCost ? "≥" : ""}${formatUsdCost(row.billedEstimateUsd ?? row.costUsd)} billed`;
  }
  const share = usageCachePercent(row);
  const unknown = cacheUnknownNote(row.cacheUnreportedCalls);
  const cache = share === null ? "cache unknown" : `${share}% cached${unknown ? ` ${unknown}` : ""}`;
  const billed = row.billedEstimateUsd ?? row.costUsd;
  const planCalls = row.planCalls ?? 0;
  const plan = planCalls > 0 ? planLabelFor([row.label.includes("/") ? row.label.slice(0, row.label.indexOf("/")) : undefined]) : "";
  return [
    row.modelCalls === undefined ? "calls unknown" : `${row.modelCalls} calls`,
    `${formatTokenCount(row.inputTokens)} in`, cache, `${formatTokenCount(row.outputTokens)} out`,
    `${row.hasUnknownCost ? "≥" : ""}${formatUsdCost(billed)} billed${row.costEstimated ? " est." : row.billedEstimateUsd === undefined ? " (peak est.)" : ""}`,
    // Named only where the row is not all plan calls ("ChatGPT plan, 3 of 5 calls").
    plan ? (row.modelCalls !== undefined && planCalls < row.modelCalls ? `${plan}, ${planCalls} of ${row.modelCalls} calls` : plan) : "",
    (row.apiEquivalentUsd ?? 0) > 0 ? `${row.apiEquivalentUnknown ? "≥" : ""}${formatUsdCost(row.apiEquivalentUsd!)} on an API key`
      : row.apiEquivalentUnknown ? "API price unknown" : "",
  ].filter(Boolean).join(" · ");
}

/** "ChatGPT plan: 15 calls, covered by your subscription". */
export function costPlanLine(report: CostReport): string | null {
  return (report.planCalls ?? 0) > 0
    ? `${report.planLabel ?? "Subscription plan"}: ${report.planCalls} ${report.planCalls === 1 ? "call" : "calls"}, covered by your subscription`
    : null;
}

/** "Same calls on an API key: $0.075 (for comparison, not billed)". */
export function costApiKeyLine(report: CostReport): string | null {
  return (report.apiEquivalentUsd ?? 0) > 0
    ? `Same calls on an API key: ${report.apiEquivalentUnknown ? "≥" : ""}${formatUsdCost(report.apiEquivalentUsd!)} (for comparison, not billed)`
    : null;
}

/** The two closing sentences of both /cost surfaces. */
export const COST_FOOTNOTE = "Billed is an estimate. Plan calls are not charged per token.";

/** Heading of the list of calls that reported no usage. */
export function unpricedCallsHeading(report: CostReport): string {
  return report.hasUnknownCost ? "Calls without reported usage (their cost is not in the totals):"
    : "Calls without reported usage (plan calls, nothing billed):";
}

export function formatCostReport(report: CostReport): string {
  const lines: string[] = [];
  if (report.totalCostUsd !== undefined) {
    const unknown = report.hasUnknownCost ? "≥" : "";
    const est = report.totalIsEstimated ? " est." : "";
    if (report.billedEstimateUsd !== undefined && !report.totalIsEstimated) {
      lines.push(`Billed estimate: ${unknown}${formatUsdCost(report.billedEstimateUsd)} (recorded per-call off-peak hours)`);
    }
    const planLine = costPlanLine(report);
    if (planLine !== null) lines.push(planLine);
    const apiKeyLine = costApiKeyLine(report);
    if (apiKeyLine !== null) lines.push(apiKeyLine);
    if (report.apiEquivalentUnknown) lines.push("Some plan calls have no known API price.");
    lines.push(
      `Session cost: ${unknown}${formatUsdCost(report.totalCostUsd)}${est} (accounting; peak rates before off-peak discounts)`,
    );
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
    lines.push("By agent (the lead, then its sub-agents):");
    for (const row of report.agentModels) lines.push(`  ${row.agentLabel} · ${row.label}: ${costModelDetail(row)}`);
  } else if (report.agents.length > 0) {
    lines.push("Agents (at peak rates, tool charges included):");
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
  if (report.hasUnknownCost || (report.unpricedCalls?.length ?? 0) > 0) {
    lines.push(unpricedCallsHeading(report));
    for (const call of report.unpricedCalls ?? []) lines.push(`  ${unpricedCallDescription(call)}`);
    const shown = report.unpricedCalls?.length ?? 0;
    if (report.unpricedCallCount !== undefined && report.unpricedCallCount > shown) {
      lines.push(`  Showing ${shown} of ${report.unpricedCallCount} unpriced calls.`);
    } else if (shown === 0) {
      lines.push("  Call details unavailable for this older session.");
    }
  }
  lines.push(COST_FOOTNOTE);
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
