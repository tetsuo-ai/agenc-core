import type { JsonObject } from "../app-server/protocol/index.js";
import type { ApprovalCtx } from "../tools/orchestrator.js";
import { isRecord } from "../utils/record.js";

export function daemonFileWritePreview(value: unknown): NonNullable<ApprovalCtx["fileWritePreview"]> | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "missing") return { kind: "missing" };
  if (value.kind === "existing" && typeof value.content === "string" &&
    Buffer.byteLength(value.content, "utf8") <= 256 * 1024) {
    return { kind: "existing", content: value.content };
  }
  if (value.kind === "unavailable" && typeof value.reason === "string") {
    return { kind: "unavailable", reason: value.reason.slice(0, 200) };
  }
  return undefined;
}

export function buildDaemonApprovalCtx(
  session: object,
  payload: JsonObject,
  toolName: string,
  signal: AbortSignal,
): ApprovalCtx {
  const callId = payload.callId as string;
  const input = isRecord(payload.input) ? payload.input : {};
  const fileWritePreview = daemonFileWritePreview(payload.fileWritePreview);
  return {
    invocation: {
      session,
      turn: {
        subId: typeof payload.turnId === "string" ? payload.turnId : callId,
      },
      tracker: {
        appendFileDiff() {},
        snapshot: () => [],
        clear() {},
      },
      callId,
      toolName: { name: toolName },
      payload: {
        kind: "function",
        arguments: JSON.stringify(input),
      },
      source: "direct",
    } as unknown as ApprovalCtx["invocation"],
    callId,
    toolName,
    signal,
    ...(fileWritePreview === undefined ? {} : { fileWritePreview }),
    turnId: typeof payload.turnId === "string" ? payload.turnId : callId,
    ...(typeof payload.reason === "string"
      ? { retryReason: payload.reason }
      : {}),
    ...(typeof payload.planContent === "string"
      ? { planContent: payload.planContent }
      : {}),
    ...(typeof payload.planFilePath === "string"
      ? { planFilePath: payload.planFilePath }
      : {}),
  };
}
