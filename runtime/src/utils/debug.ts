/**
 * Re-export shim for the upstream-mirrored debug helpers.
 *
 * Several upstream-ported files import these helpers via the
 * historical path `../utils/debug.js` (relative) or `src/utils/debug.js`
 * (path-mapped). The actual implementation lives at
 * `runtime/src/agenc/upstream/utils/debug.ts`. Without this file the
 * bundler emits unresolved references (the bundle still builds, but
 * functions like `logForDebugging` end up undefined at runtime, and
 * the upstream `enableConfigs` chain crashes with
 * `ReferenceError: logForDebugging is not defined`).
 *
 * Forwarding the public surface here keeps the upstream module the
 * single source of truth and resolves both the historical import path
 * and the path-mapped one at the same time.
 */

export {
  enableDebugLogging,
  flushDebugLogs,
  getDebugFilePath,
  getDebugFilter,
  getDebugLogPath,
  getHasFormattedOutput,
  getMinDebugLogLevel,
  isDebugMode,
  isDebugToStdErr,
  logAntError,
  logForDebugging,
  setHasFormattedOutput,
} from "../agenc/upstream/utils/debug.js";
export type { DebugLogLevel } from "../agenc/upstream/utils/debug.js";
