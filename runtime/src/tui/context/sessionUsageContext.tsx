import { createContext, useContext } from "react";

export type SessionUsageSnapshot = import("../../session/usage-display.js").DisplayUsage;

export const SessionUsageContext = createContext<SessionUsageSnapshot | null | undefined>(undefined);

export function useSessionUsage(): SessionUsageSnapshot | null | undefined {
  return useContext(SessionUsageContext);
}
