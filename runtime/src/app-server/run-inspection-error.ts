export type AgenCDaemonRunInspectionErrorCode =
  | "INVALID_ARGUMENT"
  | "RUN_ID_AMBIGUOUS"
  | "RUN_NOT_FOUND"
  | "RUN_NOT_TERMINAL";

export class AgenCDaemonRunInspectionError extends Error {
  readonly code: AgenCDaemonRunInspectionErrorCode;

  constructor(code: AgenCDaemonRunInspectionErrorCode, message: string) {
    super(message);
    this.name = "AgenCDaemonRunInspectionError";
    this.code = code;
  }
}
