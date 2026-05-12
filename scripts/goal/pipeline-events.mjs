import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export const COMPLETION_PIPELINE_EVENT_LOG_ENV = "AGENC_TUI_COMPLETION_PIPELINE_LOG";
export const COMPLETION_PIPELINE_EVENT_LOG_PATH = ".tmp/agenc-tui-completion-pipeline/events.jsonl";

export const COMPLETION_PIPELINE_GATE_IDS = [
  "prep",
  "branch_shape",
  "branding",
  "shape_evidence",
  "item_specific",
  "typecheck",
  "tui_validate",
  "review",
  "local_merge",
];

export const COMPLETION_PIPELINE_STATUSES = [
  "started",
  "succeeded",
  "failed",
  "cancelled",
  "completed",
];

let nextSequence = Date.now() * 1000;

export function resolveCompletionPipelineEventLogPath({
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const configured = env[COMPLETION_PIPELINE_EVENT_LOG_ENV];
  return path.resolve(
    cwd,
    configured && configured.trim() !== ""
      ? configured
      : COMPLETION_PIPELINE_EVENT_LOG_PATH,
  );
}

function boundText(value, max = 240) {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length === 0) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function createCompletionPipelineEvent({
  pipelineId,
  gateId,
  status,
  message,
  detail,
  sequence,
  timestamp,
}) {
  if (!pipelineId || typeof pipelineId !== "string") {
    throw new Error("completion pipeline event requires pipelineId");
  }
  if (!COMPLETION_PIPELINE_STATUSES.includes(status)) {
    throw new Error(`invalid completion pipeline status: ${status}`);
  }
  const gateIndex = COMPLETION_PIPELINE_GATE_IDS.indexOf(gateId);
  return {
    pipelineId,
    sequence: Number.isInteger(sequence) ? sequence : ++nextSequence,
    gateId,
    gateIndex: gateIndex >= 0 ? gateIndex : COMPLETION_PIPELINE_GATE_IDS.length,
    status,
    ...(boundText(message, 160) !== undefined ? { message: boundText(message, 160) } : {}),
    ...(boundText(detail) !== undefined ? { detail: boundText(detail) } : {}),
    timestamp: timestamp ?? new Date().toISOString(),
  };
}

export function emitCompletionPipelineEvent(event, options = {}) {
  const eventLogPath =
    options.eventLogPath ??
    resolveCompletionPipelineEventLogPath({
      env: options.env ?? process.env,
      cwd: options.cwd ?? process.cwd(),
    });
  try {
    mkdirSync(path.dirname(eventLogPath), { recursive: true });
    appendFileSync(eventLogPath, `${JSON.stringify(event)}\n`, "utf8");
  } catch (error) {
    if (options.throwOnWrite) throw error;
  }
  return event;
}

export function startCompletionPipelineGate(gateId, options = {}) {
  const pipelineId = options.pipelineId ?? process.argv[2] ?? "manual";
  let finalized = false;
  const emit = (status, detail) =>
    emitCompletionPipelineEvent(
      createCompletionPipelineEvent({
        pipelineId,
        gateId,
        status,
        message: options.message,
        detail,
      }),
      options,
    );
  emit("started");
  return {
    get finalized() {
      return finalized;
    },
    succeeded(detail) {
      if (finalized) return;
      finalized = true;
      emit("succeeded", detail);
    },
    failed(detail) {
      if (finalized) return;
      finalized = true;
      emit("failed", detail);
    },
    cancelled(detail) {
      if (finalized) return;
      finalized = true;
      emit("cancelled", detail);
    },
  };
}
