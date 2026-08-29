import type { AgentRuntimeOptions } from "../session/runtime-options.js";
import { isBareMode } from "../utils/envUtils.js";

/** Immutable session authority that controls whether hook effects may run. */
export type HookRuntimeAuthority = Pick<AgentRuntimeOptions, "simpleMode">;

/**
 * Return whether every hook extension point is suppressed for the owning run.
 *
 * Explicit owner authority wins over ambient lookup so detached work cannot
 * accidentally inherit another session's mode inside a multi-session daemon.
 */
export function isHookExecutionSuppressed(
  runtimeOptions?: HookRuntimeAuthority,
): boolean {
  return runtimeOptions?.simpleMode ?? isBareMode();
}
