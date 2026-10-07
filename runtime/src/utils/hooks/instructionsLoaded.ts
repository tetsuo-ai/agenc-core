import { getRegisteredHooks } from "../../bootstrap/state.js";
import { shouldDisableAllHooksIncludingManaged } from "./hookExecutionPolicy.js";

/**
 * Check if InstructionsLoaded hooks are configured (without executing them).
 * Callers should check this before invoking executeInstructionsLoadedHooks to avoid
 * building hook inputs for every instruction file when no hook is configured.
 *
 * Checks registered plugin and SDK callback hooks. Session-derived hooks
 * (structured output enforcement etc.) are internal and not checked.
 */
export function hasInstructionsLoadedHook(): boolean {
  if (shouldDisableAllHooksIncludingManaged()) return false;
  const registeredHooks = getRegisteredHooks()?.["InstructionsLoaded"];
  if (registeredHooks && registeredHooks.length > 0) return true;
  return false;
}

