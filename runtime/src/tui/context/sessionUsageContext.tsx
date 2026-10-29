import { createContext, useContext } from "react";
import type { AdmissionUsageSummary } from "../../budget/admission-types.js";

export type SessionUsageSnapshot = Pick<AdmissionUsageSummary, "costUsd" | "hasUnknownCost" | "costEstimated" | "billedEstimateUsd">;

export const SessionUsageContext = createContext<SessionUsageSnapshot | null | undefined>(undefined);

export function useSessionUsage(): SessionUsageSnapshot | null | undefined {
  return useContext(SessionUsageContext);
}
