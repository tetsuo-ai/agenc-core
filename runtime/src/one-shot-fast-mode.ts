import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentRuntimeOptions } from "./session/runtime-options.js";
import type { Session } from "./session/session.js";
import type { TurnContext } from "./session/turn-context.js";

const active = new AsyncLocalStorage<boolean>();
/** Never inferred from environment variables or ordinary permission bypass. */
export function oneShotFastModeSelected(
  options: Partial<AgentRuntimeOptions> | undefined,
  config: { readonly bypassFastMode?: boolean },
): boolean {
  return options?.dangerouslyBypassApprovalsAndSandbox === true &&
    options.nonInteractive === true && options.relaxedOneShot === true && config.bypassFastMode !== false;
}
export function bypassFastModeEnabled(session: Session, ctx: TurnContext): boolean {
  return oneShotFastModeSelected(session.services.runtimeOptions, ctx.config) &&
    ctx.permissionMode === "bypassPermissions" && ctx.sandboxPolicy.value === "danger_full_access" &&
    session.services.configStore?.current().bypassFastMode !== false;
}
export function oneShotFastModeActive(): boolean { return active.getStore() === true; }
export function withOneShotFastMode<T>(run: () => T): T { return active.run(true, run); }
