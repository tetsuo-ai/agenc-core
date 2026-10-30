/**
 * The hours a provider bills at its off-peak rate, for per-call display
 * estimates. Only routes whose hours AgenC records are here. Accounting
 * stays at the peak rates (see session/cost.ts).
 *
 * @module
 */

import { normalizeProviderMetadataIdentity } from "../provider-identity.js";

/** A provider's billing hours, by UTC weekday (0 is Sunday) and UTC hour. */
export interface OffPeakSchedule {
  readonly isPeakHour: (weekdayUtc: number, hourUtc: number) => boolean;
}

/**
 * DeepSeek API: peak 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday, and
 * every other hour bills half (docs/reference/providers.md;
 * https://api-docs.deepseek.com/quick_start/pricing/, read 2026-10-21).
 * DeepSeek also bills Chinese public holidays off-peak. Those dates are not
 * recorded, so display estimates can overstate charges on those days.
 */
const DEEPSEEK_API_HOURS: OffPeakSchedule = Object.freeze({
  isPeakHour: (weekday: number, hour: number) =>
    weekday >= 1 && weekday <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)),
});

/**
 * QwenCloud's DeepSeek rows: busy 08:00-22:00 UTC+8 (00:00-14:00 UTC) every
 * day, and idle hours bill half (llm/registry/qwen-current-models.ts).
 */
const QWEN_DEEPSEEK_HOURS: OffPeakSchedule = Object.freeze({
  isPeakHour: (_weekday: number, hour: number) => hour < 14,
});

/** The QwenCloud models the registry prices at busy-hour rates. */
const QWEN_OFF_PEAK_MODELS: ReadonlySet<string> = new Set([
  "deepseek-v4-flash-0731",
  "deepseek-v4-pro-0813",
  "deepseek-v4.1-flash",
]);

/**
 * The off-peak hours of a provider and model, or null when AgenC records
 * none. Ollama Cloud also bills its DeepSeek models half off-peak, but its
 * hours are not recorded, so its display estimate keeps the accounting rate.
 */
export function offPeakScheduleFor(
  provider: string | undefined,
  model: string | undefined,
): OffPeakSchedule | null {
  const id = normalizeProviderMetadataIdentity(provider);
  if (id === "deepseek") return DEEPSEEK_API_HOURS;
  if (id === "qwen" && QWEN_OFF_PEAK_MODELS.has(model?.trim().toLowerCase() ?? "")) {
    return QWEN_DEEPSEEK_HOURS;
  }
  return null;
}

/** Whether a call made at `nowMs` bills at the off-peak rate. */
export function isOffPeakAt(schedule: OffPeakSchedule, nowMs: number): boolean {
  const now = new Date(nowMs);
  return !schedule.isPeakHour(now.getUTCDay(), now.getUTCHours());
}

const HOUR_MS = 3_600_000;

/** Every recorded window starts and ends on a whole UTC hour. */
export function msUntilNextUtcHour(nowMs: number): number {
  return HOUR_MS - (((nowMs % HOUR_MS) + HOUR_MS) % HOUR_MS);
}
