import type { RunIdAmbiguousReason, RunInspectionErrorCode } from "./protocol/index.js";

export type AgenCDaemonRunInspectionErrorCode = RunInspectionErrorCode;

export class AgenCDaemonRunInspectionError extends Error {
  readonly code: AgenCDaemonRunInspectionErrorCode;
  /** Why the run id is ambiguous; set with `RUN_ID_AMBIGUOUS` only. */
  readonly reason?: RunIdAmbiguousReason;

  constructor(code: AgenCDaemonRunInspectionErrorCode, message: string, reason?: RunIdAmbiguousReason) {
    super(message);
    this.name = "AgenCDaemonRunInspectionError";
    this.code = code;
    if (reason !== undefined) this.reason = reason;
  }
}
