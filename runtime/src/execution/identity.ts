import { MAX_TOOL_CALL_ID_UTF8_BYTES, MAX_TOOL_RESULT_SCOPE_ID_BYTES } from "../session/tool-result-integrity.js";
import { ExecutionEnvironmentError, type ExecutionOperationIdentity } from "./types.js";

export function validExecutionOwner(value: string): boolean {
  return validIdentity(value, MAX_TOOL_RESULT_SCOPE_ID_BYTES);
}

export function validateExecutionIdentity(identity: ExecutionOperationIdentity): void {
  if (!identity || !Number.isSafeInteger(identity.attempt) || identity.attempt < 1 ||
      !validIdentity(identity.runId, MAX_TOOL_RESULT_SCOPE_ID_BYTES) || !validIdentity(identity.callId, MAX_TOOL_CALL_ID_UTF8_BYTES) ||
      (identity.operationIndex !== undefined && (!Number.isSafeInteger(identity.operationIndex) || identity.operationIndex < 0))) {
    throw new ExecutionEnvironmentError("invalid_request", "Execution requires a valid admitted call and operation index", false);
  }
}

function validIdentity(value: string, maximumBytes: number): boolean {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= maximumBytes &&
    Buffer.from(value, "utf8").toString("utf8") === value;
}
