import { asRecord } from "../../utils/record.js";
import { replaceSessionTaskTokenBudgetSnapshot } from "../../session/task-budget.js";
import type { Session } from "../../session/session.js";

/** Mirror only an accepted allowance published by the session authority. */
export function syncTaskBudgetEventToTuiSession(event: unknown, session: { readonly config?: unknown }): void {
  const raw = asRecord(event);
  const message = asRecord(raw?.msg) ?? raw;
  const payload = asRecord(message?.payload);
  if (message?.type !== "warning" || payload?.cause !== "task_budget_changed") return;
  const tokens = asRecord(payload.details)?.taskTokenBudget;
  if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0 || asRecord(session.config) === null) return;
  replaceSessionTaskTokenBudgetSnapshot(session as Pick<Session, "config">, tokens);
}
