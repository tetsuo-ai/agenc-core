import { classifyTurnTerminal } from "../contracts/turn-terminal.js";
import { EMPTY_PROMPT_CACHE_TALLY, addPromptCacheUsage, promptCacheSharePercent } from "../session/prompt-cache-share.js";
import { formatDuration } from "../utils/format.js";
import { stringWidth } from "./ink/stringWidth.js";

export interface RequestUsage {
  readonly inputTokens: number;
  readonly outputTokens: number | null;
  /** Null means cache usage was not reported. */
  readonly cachedInputTokens: number | null;
}

export interface TurnEfficiency {
  readonly modelCalls: number;
  readonly usage: RequestUsage | null;
  readonly lastRequest: RequestUsage | null;
}

export interface TurnEfficiencyState {
  readonly turnId: string | null;
  readonly current: Omit<TurnEfficiency, "modelCalls"> | null;
}

export const EMPTY_TURN_EFFICIENCY: TurnEfficiencyState = { turnId: null, current: null };

/** Display projection only. It consumes the events the TUI already receives. */
export function advanceTurnEfficiency(
  state: TurnEfficiencyState,
  type: string,
  payload: Record<string, unknown>,
): TurnEfficiencyState {
  if (type === "history_cleared" || type === "history_replaced") return EMPTY_TURN_EFFICIENCY;
  if (type === "turn_started" || type === "turn_start") {
    const turnId = typeof payload.turnId === "string" ? payload.turnId : null;
    if (turnId !== null && turnId === state.turnId && state.current !== null) return state;
    return { turnId, current: { usage: null, lastRequest: null } };
  }
  if (state.current === null) return state;
  if (type === "turn_complete" || type === "turn_aborted" || type === "turn_failed") {
    return classifyTurnTerminal({ type, payload }, { expectedTurnId: state.turnId ?? undefined }) !== undefined
      ? EMPTY_TURN_EFFICIENCY : state;
  }
  if (type !== "token_count") return state;
  const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  const hasOutput = isCount(payload.completionTokens) || isCount(payload.reasoningOutputTokens);
  if (!isCount(payload.promptTokens) && !(isCount(payload.totalTokens) && hasOutput)) return state;
  // Reuse the status line's provider-aware input accounting. Some providers
  // report cache reads and writes outside promptTokens, others include them.
  const tally = addPromptCacheUsage(EMPTY_PROMPT_CACHE_TALLY, payload);
  const totals = Object.values(tally.providers)[0]!;
  const count = (value: unknown): number => isCount(value) ? Math.max(0, Math.trunc(value)) : 0;
  const lastRequest: RequestUsage = {
    inputTokens: totals.inputTokens,
    outputTokens: hasOutput ? Math.max(count(payload.completionTokens), count(payload.reasoningOutputTokens)) : null,
    cachedInputTokens: promptCacheSharePercent(tally) === null ? null : totals.cachedInputTokens,
  };
  const before = state.current.usage;
  const usage: RequestUsage = before === null ? lastRequest : {
    inputTokens: before.inputTokens + lastRequest.inputTokens,
    outputTokens: before.outputTokens === null || lastRequest.outputTokens === null
      ? null : before.outputTokens + lastRequest.outputTokens,
    cachedInputTokens: before.cachedInputTokens === null || lastRequest.cachedInputTokens === null
      ? null : before.cachedInputTokens + lastRequest.cachedInputTokens,
  };
  return { ...state, current: { ...state.current, usage, lastRequest } };
}

export function formatEfficiencyTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  const divisor = tokens >= 999_950 ? 1_000_000 : 1_000;
  return `${Number((tokens / divisor).toFixed(1))}${divisor === 1_000 ? "K" : "M"}`;
}

function cachedShare(usage: RequestUsage): number | null {
  if (usage.cachedInputTokens === null || usage.inputTokens <= 0) return null;
  const percent = Math.round(Math.min(usage.cachedInputTokens, usage.inputTokens) / usage.inputTokens * 100);
  return usage.cachedInputTokens < usage.inputTokens ? Math.min(percent, 99) : 100;
}

function usageFields(usage: RequestUsage | null): string[] {
  if (usage === null) return [];
  const cached = cachedShare(usage);
  return [`input ${formatEfficiencyTokens(usage.inputTokens)}`, ...(cached === null ? [] : [`cached ${cached}%`])];
}

function callsField(calls: number): string {
  return `${calls} ${calls === 1 ? "call" : "calls"}`;
}

/** Keep complete fields, dropping the rightmost field until one line fits. */
function fitFields(fields: readonly string[], width: number): string {
  const visible = [...fields];
  while (visible.length > 0 && stringWidth(visible.join(" · ")) > width) visible.pop();
  return visible.join(" · ");
}

export function formatLiveEfficiency(turn: TurnEfficiency, width: number): string {
  return fitFields([
    callsField(turn.modelCalls),
    ...usageFields(turn.lastRequest),
  ], width);
}

export function formatTurnEfficiency(
  turn: { readonly modelCalls?: number; readonly usage: RequestUsage | null },
  durationMs: number,
  width: number,
  suffix = "",
): string {
  const core = [...(turn.modelCalls === undefined ? [] : [callsField(turn.modelCalls)]), ...usageFields(turn.usage)];
  const duration = `done in ${formatDuration(durationMs)}`;
  const output = turn.usage?.outputTokens == null ? [] : [`output ${formatEfficiencyTokens(turn.usage.outputTokens)}`];
  const full = [duration, ...core, ...output].join(" · ") + suffix;
  if (stringWidth(full) <= width) return full;
  // Preserve the existing duration's leading position. Output goes first,
  // then wall time, before sacrificing input or cache information.
  const withoutOutput = [duration, ...core].join(" · ") + suffix;
  if (stringWidth(withoutOutput) <= width) return withoutOutput;
  return fitFields([...core, ...(suffix ? [suffix.replace(/^ · /, "")] : [])], width);
}
