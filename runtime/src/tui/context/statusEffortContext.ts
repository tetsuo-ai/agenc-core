import { createContext, useContext } from "react";
import type { ZeroDataRetentionStatus } from "../../llm/zero-data-retention.js";
import type { OffPeakSchedule } from "../../session/off-peak-pricing.js";

/**
 * The effort the session runs at, for the status line ("high effort"). Null
 * when the model has no effort levels. App resolves it because only App knows
 * the session's provider; the status line just shows it.
 */
export const StatusEffortContext = createContext<string | null>(null);

export function useStatusEffort(): string | null {
  return useContext(StatusEffortContext);
}

/** Resident usage shared by /context and the footer; null until known. */
export const StatusContextUsageContext = createContext<number | null>(null);
export function useStatusContextUsage(): number | null {
  return useContext(StatusContextUsageContext);
}

/** Changes only at turn/shell boundaries, so chrome can refresh filesystem facts. */
export const StatusTurnBusyContext = createContext(false);
export function useStatusTurnBusy(): boolean {
  return useContext(StatusTurnBusyContext);
}

/** Percent of the session's input served from prompt cache; null hides it. */
export const StatusPromptCacheContext = createContext<number | null>(null);
export function useStatusPromptCache(): number | null {
  return useContext(StatusPromptCacheContext);
}

/** Off-peak hours of the selected provider and model; null when none are recorded. */
export const StatusOffPeakContext = createContext<OffPeakSchedule | null>(null);
export function useStatusOffPeakSchedule(): OffPeakSchedule | null {
  return useContext(StatusOffPeakContext);
}

/** Manual web search, read from the same config and session environment as the picker. */
export const StatusWebSearchContext = createContext(false);
export function useStatusWebSearch(): boolean {
  return useContext(StatusWebSearchContext);
}

/**
 * Zero data retention of the provider and model a call made now would use,
 * for the status line's ZDR badge. Null until the session's provider is known.
 */
export const StatusZdrContext = createContext<ZeroDataRetentionStatus | null>(null);
export function useStatusZdr(): ZeroDataRetentionStatus | null {
  return useContext(StatusZdrContext);
}
