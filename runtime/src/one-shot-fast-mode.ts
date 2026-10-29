import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentRuntimeOptions } from "./session/runtime-options.js";
import type { Session } from "./session/session.js";
import type { TurnContext } from "./session/turn-context.js";

const active = new AsyncLocalStorage<{ readonly sessionId?: string }>();
/** Never inferred from environment variables or ordinary permission bypass. */
export function oneShotFastModeSelected(
  options: Partial<AgentRuntimeOptions> | undefined,
  config: { readonly bypassFastMode?: boolean },
): boolean {
  return options?.dangerouslyBypassApprovalsAndSandbox === true &&
    options.nonInteractive === true && options.relaxedOneShot === true &&
    // The canonical loop owns deadline reminders, tool-result timestamps,
    // the final-check reserve and deadline cancellation. A time-bounded run
    // must enter it before the first request or tool effect.
    options.deadlineAt === undefined && config.bypassFastMode !== false;
}
export function bypassFastModeEnabled(session: Session, ctx: TurnContext): boolean {
  const scope = active.getStore();
  // A nested session cannot turn its inherited root options into a new grant.
  if (scope !== undefined && scope.sessionId !== String(session.conversationId)) return false;
  return oneShotFastModeSelected(session.services.runtimeOptions, ctx.config) &&
    ctx.permissionMode === "bypassPermissions" && ctx.sandboxPolicy.value === "danger_full_access" &&
    session.services.configStore?.current().bypassFastMode !== false;
}
export function requiresAtomicSpendAdmission(session: Session): boolean {
  const scope = session.services.executionAdmission?.scope;
  return scope?.hasHardCostCap === true || scope?.hasHardTokenCap === true ||
    scope?.maxCostUsd !== undefined || scope?.maxTokens !== undefined ||
    scope?.maxModelCalls !== undefined;
}
/** With an id, grants authority only to the session that entered this scope. */
export function oneShotFastModeActive(sessionId?: string): boolean {
  const scope = active.getStore();
  return scope !== undefined && (sessionId === undefined || scope.sessionId === sessionId);
}
export function withOneShotFastMode<T>(run: () => T, sessionId?: string): T {
  return active.run({ sessionId }, run);
}


/** The print loss window belongs to the selected root, never to its children. */
export function runtimeOptionsForChildSession(options: AgentRuntimeOptions): AgentRuntimeOptions {
  return options.relaxedOneShot === true ? { ...options, relaxedOneShot: false } : options;
}
