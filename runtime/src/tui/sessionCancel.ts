type TuiTurnCancelReason = "interrupted"

type TuiTurnCancelableSession = {
  readonly cancelActiveTurn?: (reason?: TuiTurnCancelReason) => Promise<void> | void
  readonly abortAllTasks?: (reason: TuiTurnCancelReason) => Promise<void> | void
}

export function requestTuiSessionTurnCancel(
  session: TuiTurnCancelableSession,
  reason: TuiTurnCancelReason = "interrupted",
): void {
  if (session.cancelActiveTurn !== undefined) {
    void Promise.resolve(session.cancelActiveTurn(reason)).catch(() => {})
    return
  }
  if (session.abortAllTasks !== undefined) {
    void Promise.resolve(session.abortAllTasks(reason)).catch(() => {})
  }
}
