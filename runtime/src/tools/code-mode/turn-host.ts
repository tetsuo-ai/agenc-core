import type { Session } from "../../session/session.js";
import type { ToolRegistry } from "../../tool-registry.js";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  type CodeModeNestedToolCall,
  type CodeModeService,
  type CodeModeTurnWorker,
} from "./types.js";

type CodeModeWorkerServices = {
  readonly registry: Pick<
    ToolRegistry,
    "dispatch" | "dispatchCodeModeNestedTool"
  >;
  readonly codeModeService?: CodeModeService;
};

export interface CodeModeWorkerSession {
  readonly services: CodeModeWorkerServices;
  nextInternalSubId(): string;
  emit(event: Parameters<Session["emit"]>[0]): void;
}

async function invokeNestedCodeModeTool(
  session: CodeModeWorkerSession,
  call: CodeModeNestedToolCall,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    call.toolName === CODE_MODE_EXEC_TOOL_NAME ||
    call.toolName === CODE_MODE_WAIT_TOOL_NAME
  ) {
    throw new Error(`${CODE_MODE_EXEC_TOOL_NAME} cannot invoke itself`);
  }

  const id = `${CODE_MODE_EXEC_TOOL_NAME}-${call.runtimeToolCallId}`;
  if (session.services.registry.dispatchCodeModeNestedTool === undefined) {
    throw new Error(
      "code-mode nested tool dispatch is unavailable for this session",
    );
  }
  const result = await session.services.registry.dispatchCodeModeNestedTool({
    id,
    name: call.toolName,
    input: call.input,
    abortSignal: signal,
  });
  if (result.isError === true) {
    throw new Error(result.content);
  }
  if (result.codeModeResult !== undefined) {
    return result.codeModeResult;
  }
  try {
    return JSON.parse(result.content) as unknown;
  } catch {
    return result.content;
  }
}

function emitCodeModeNotify(
  session: CodeModeWorkerSession,
  callId: string,
  text: string,
): void {
  if (text.trim().length === 0) return;
  session.emit({
    id: session.nextInternalSubId(),
    msg: {
      type: "tool_progress",
      payload: {
        callId,
        toolName: CODE_MODE_EXEC_TOOL_NAME,
        chunk: text,
        stream: "status",
      },
    },
  });
}

function emitMissingCodeModeServiceWarning(session: CodeModeWorkerSession): void {
  session.emit({
    id: session.nextInternalSubId(),
    msg: {
      type: "warning",
      payload: {
        cause: "code_mode_service_missing",
        message:
          "CodeMode service is missing from SessionServices; " +
          "code-mode tools are disabled for this turn.",
      },
    },
  });
}

export function startCodeModeTurnWorker(
  session: CodeModeWorkerSession,
): CodeModeTurnWorker {
  const codeModeService = session.services.codeModeService;
  if (codeModeService === undefined) {
    emitMissingCodeModeServiceWarning(session);
    return { dispose: () => undefined };
  }

  return codeModeService.startTurnWorker({
    invokeTool: (call: CodeModeNestedToolCall, signal: AbortSignal) =>
      invokeNestedCodeModeTool(session, call, signal),
    notify: ({ callId, text }) => {
      emitCodeModeNotify(session, callId, text);
    },
  });
}
