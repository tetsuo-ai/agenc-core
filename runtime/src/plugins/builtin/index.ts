import type { Command } from "../../types/command.js";
import { getBuiltinPluginSkillCommands as readRegisteredSkillCommands } from "../builtinPlugins.js";

let initialized = false;

/**
 * Register the plugins that ship inside the runtime package.
 *
 * Deliberately empty: the runtime keeps a single catalog. Capabilities
 * that used to double-ship here (zeroday-hunter) are distributed only
 * through the signed plugin marketplace now, so the same skill can never
 * exist twice under one name with diverging versions. The registry and
 * this seam stay so a future first-party plugin can ship in-package
 * without rebuilding the plumbing.
 *
 * Idempotent: the daemon and the CLI both reach startup paths that call it.
 */
export function initBuiltinPlugins(): void {
  if (initialized) return;
  initialized = true;
}

/** Test seam: allows a suite to re-register against a fresh registry. */
export function resetBuiltinPluginInit(): void {
  initialized = false;
}

/**
 * Command-source entry point. Registration is lazy and idempotent so the
 * registry is never read empty.
 */
export function getBuiltinPluginSkillCommands(): Command[] {
  initBuiltinPlugins();
  return readRegisteredSkillCommands();
}
