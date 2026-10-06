/** Shared startup option scope; reading it does not load option parsing. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentRuntimeOptions } from "./runtime-options.js";

const scopedRuntimeOptions = new AsyncLocalStorage<AgentRuntimeOptions>();

/** Bind startup work and all async descendants to one immutable option set. */
export function runWithAgentRuntimeOptions<T>(
  options: AgentRuntimeOptions,
  operation: () => T,
): T {
  return scopedRuntimeOptions.run(options, operation);
}

/** Read the session/startup binding without consulting process-global env. */
export function peekAgentRuntimeOptions(): AgentRuntimeOptions | undefined {
  return scopedRuntimeOptions.getStore();
}
