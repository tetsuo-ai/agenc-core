import type { UnifiedExecRuntimeSandbox } from "../../unified-exec/types.js";
import { PROCESS_DISCOVERY_GUIDANCE } from "./local-server-guidance.js";

// This diagnoses visibility, not command success. Even `ps ... || true` can
// return zero with no matching host process. No process-table access is widened.
const PROCESS_PROBE = /(?:^|[\s;&|()])(?:\/[^\s;&|()]+\/)?(?:ps|pgrep|pidof)(?=\s|$)/u;

export function execProcessNamespaceNotice(params: {
  readonly command: string;
  readonly runtimeSandbox?: UnifiedExecRuntimeSandbox;
}): string | null {
  if (process.platform !== "linux" || params.runtimeSandbox === undefined ||
      (params.runtimeSandbox.preference ?? "require") !== "require" ||
      !PROCESS_PROBE.test(params.command)) return null;
  return "[sandbox] " + PROCESS_DISCOVERY_GUIDANCE;
}
