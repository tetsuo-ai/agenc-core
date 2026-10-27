import { validateToolEffectDispositionEvidence } from "./effect-boundary.js";
import type { ToolDispatchResult } from "../tool-registry.js";

/** Caller-facing text only. Admission and physical settlement retain their evidence. */
export function interruptedExecReport(reason: unknown, result: ToolDispatchResult | null): Error | null {
  const disposition = validateToolEffectDispositionEvidence(result?.effectDisposition);
  if (disposition?.disposition === "confirmed_no_effect") return null;
  const metadata = result?.metadata;
  const observedStart = typeof metadata?.command === "string" &&
    typeof metadata?.durationMs === "number" && Number.isFinite(metadata.durationMs) && metadata.durationMs >= 0 &&
    typeof metadata?.stdout === "string" && typeof metadata?.stderr === "string";
  const reasonText = reason instanceof Error ? reason.message : String(reason);
  const interruption = /interrupt/iu.test(reasonText) ? "interrupted by the user" : "cancelled";
  let message: string;
  if (observedStart) {
    message = typeof metadata.exitCode === "number"
      ? result?.isError !== true
        ? `Command started and completed with exit status ${metadata.exitCode} before cancellation was observed.`
        : `Command started. Cancellation was requested after dispatch; observed exit status ${metadata.exitCode}. Partial effects may have occurred; do not assume it never ran or retry it automatically.`
      : `Command started and was ${interruption}. The final exit status is unknown. Partial effects may have occurred; do not assume it never ran or retry it automatically.`;
    const output = [metadata.stdout, metadata.stderr].filter((value): value is string => typeof value === "string" && value.length > 0).join("\n");
    if (output.length > 0) message += `\nOutput captured before interruption:\n${output.slice(0, 8192)}${output.length > 8192 ? "\n[partial output truncated]" : ""}`;
  } else {
    message = `Command dispatch was ${interruption}. Physical start, output and exit status are not yet confirmed; its effects are unknown. Do not assume it never ran or retry it automatically.`;
  }
  const error = new Error(message, { cause: reason });
  error.name = "AbortError";
  return error;
}
