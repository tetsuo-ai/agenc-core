import type { FunctionCallOutputContentItem } from "../context.js";
import type { Tool } from "../types.js";

export const CODE_MODE_EXEC_TOOL_NAME = "exec";
export const CODE_MODE_WAIT_TOOL_NAME = "wait";
export const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
export const DEFAULT_WAIT_YIELD_TIME_MS = 10_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;

export type CodeModeToolKind = "function" | "freeform";

export interface CodeModeToolDefinition {
  readonly name: string;
  readonly globalName: string;
  readonly description: string;
  readonly kind: CodeModeToolKind;
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
}

export interface CodeModeExecuteRequest {
  readonly cellId: string;
  readonly toolCallId: string;
  readonly enabledTools: readonly CodeModeToolDefinition[];
  readonly source: string;
  readonly storedValues: Readonly<Record<string, unknown>>;
  readonly yieldTimeMs?: number;
  readonly maxOutputTokens?: number;
}

export interface CodeModeWaitRequest {
  readonly cellId: string;
  readonly yieldTimeMs?: number;
  readonly maxOutputTokens?: number;
  readonly terminate?: boolean;
}

export type CodeModeRuntimeResponse =
  | {
      readonly type: "yielded";
      readonly cellId: string;
      readonly contentItems: readonly FunctionCallOutputContentItem[];
      readonly durationMs: number;
    }
  | {
      readonly type: "terminated";
      readonly cellId: string;
      readonly contentItems: readonly FunctionCallOutputContentItem[];
      readonly durationMs: number;
    }
  | {
      readonly type: "result";
      readonly cellId: string;
      readonly contentItems: readonly FunctionCallOutputContentItem[];
      readonly storedValues: Readonly<Record<string, unknown>>;
      readonly errorText?: string;
      readonly durationMs: number;
    };

export interface CodeModeNestedToolCall {
  readonly cellId: string;
  readonly runtimeToolCallId: string;
  readonly toolName: string;
  readonly input?: unknown;
}

export interface CodeModeTurnHost {
  readonly invokeTool: (
    call: CodeModeNestedToolCall,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly notify?: (opts: {
    readonly cellId: string;
    readonly callId: string;
    readonly text: string;
  }) => Promise<void> | void;
}

export interface CodeModeTurnWorker {
  dispose(): void;
}

export interface CodeModeService {
  enabled(): boolean;
  storedValues(): Promise<Readonly<Record<string, unknown>>>;
  replaceStoredValues(values: Readonly<Record<string, unknown>>): Promise<void>;
  allocateCellId(): string;
  execute(request: CodeModeExecuteRequest): Promise<CodeModeRuntimeResponse>;
  wait(request: CodeModeWaitRequest): Promise<CodeModeRuntimeResponse>;
  startTurnWorker(host: CodeModeTurnHost): CodeModeTurnWorker;
}

export interface CodeModeToolFactoryOptions {
  readonly service: CodeModeService;
  readonly getEnabledTools: () => readonly Tool[];
  readonly descriptionTools?: readonly Tool[];
  readonly stringArgumentFields?: Readonly<Record<string, string>>;
}
