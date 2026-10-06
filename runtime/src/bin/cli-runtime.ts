import { applyBestEffortPreMainProcessHardening } from "../sandbox/hardening/index.js";
import { assertCanonicalEnvironmentIngress } from "../config/environment-ingress.js";

export function initializeCliRuntime(): void {
  // Apply pre-main process hardening before any I/O or subprocess spawn:
  // scrub LD_*/DYLD_* dynamic-loader env vars, drop RLIMIT_CORE to 0, and
  // disable core/ptrace dumping via PR_SET_DUMPABLE on Linux or
  // PT_DENY_ATTACH on macOS. Best-effort — failures are non-fatal so the
  // CLI still starts on platforms where the native binding is unavailable.
  applyBestEffortPreMainProcessHardening();
}


/** Shared CLI ingress, including the guarded detached daemon child. */
export function prepareCliRuntime(): number | null {
  try {
    assertCanonicalEnvironmentIngress(process.env);
  } catch (error) {
    process.stderr.write(
      `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  initializeCliRuntime();
  return null;
}
