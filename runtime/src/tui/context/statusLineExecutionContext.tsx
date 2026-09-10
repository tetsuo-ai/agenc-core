import { createContext, useContext } from "react";
import type {
  SessionStatusLineExecuteResult,
  SessionStatusLinePresentation,
} from "../../app-server/protocol/index.js";

export type DaemonStatusLineExecutor = (
  presentation: SessionStatusLinePresentation,
  signal?: AbortSignal,
) => Promise<SessionStatusLineExecuteResult>;

export const StatusLineExecutionContext = createContext<
  DaemonStatusLineExecutor | undefined
>(undefined);

export function useDaemonStatusLineExecutor(): DaemonStatusLineExecutor | undefined {
  return useContext(StatusLineExecutionContext);
}
