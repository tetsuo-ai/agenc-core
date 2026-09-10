import { createContext, useContext } from "react";
import type { AdmissionUsageTotals } from "../../budget/admission-types.js";

export type SessionUsageSnapshot = Pick<AdmissionUsageTotals, "costUsd" | "hasUnknownCost">;

export const SessionUsageContext = createContext<SessionUsageSnapshot | null | undefined>(undefined);

export function useSessionUsage(): SessionUsageSnapshot | null | undefined {
  return useContext(SessionUsageContext);
}
