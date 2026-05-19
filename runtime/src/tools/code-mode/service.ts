import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { FunctionCallOutputContentItem } from "../context.js";
import {
  DEFAULT_EXEC_YIELD_TIME_MS,
  DEFAULT_WAIT_YIELD_TIME_MS,
  type CodeModeExecuteRequest,
  type CodeModeNestedToolCall,
  type CodeModeRuntimeResponse,
  type CodeModeService,
  type CodeModeTurnHost,
  type CodeModeTurnWorker,
  type CodeModeWaitRequest,
} from "./types.js";
import { QUICKJS_CODE_MODE_WORKER_SOURCE } from "./runtime-worker-source.js";

const require = createRequire(import.meta.url);

type WorkerMessage =
  | { readonly type: "started" }
  | {
      readonly type: "content_item";
      readonly item: FunctionCallOutputContentItem;
    }
  | { readonly type: "yield_requested"; readonly id: string }
  | { readonly type: "notify"; readonly callId: string; readonly text: string }
  | {
      readonly type: "tool_call";
      readonly id: string;
      readonly name: string;
      readonly input?: unknown;
    }
  | {
      readonly type: "result";
      readonly storedValues?: Record<string, unknown>;
      readonly errorText?: string;
    };

interface PendingResponse {
  readonly resolve: (response: CodeModeRuntimeResponse) => void;
  timer?: NodeJS.Timeout;
}

interface CodeModeCell {
  readonly cellId: string;
  readonly toolCallId: string;
  readonly worker: Worker;
  readonly startedAtMs: number;
  readonly abortController: AbortController;
  contentItems: FunctionCallOutputContentItem[];
  pending?: PendingResponse;
  completed?: CodeModeRuntimeResponse;
}

export interface QuickJsCodeModeServiceOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly enabled?: boolean;
}

function quickJsAvailable(): boolean {
  try {
    require.resolve("quickjs-emscripten");
    return true;
  } catch {
    return false;
  }
}

function shouldEnableCodeMode(opts: QuickJsCodeModeServiceOptions): boolean {
  if (opts.enabled !== undefined) return opts.enabled;
  const raw = opts.env?.AGENC_CODE_MODE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

function cloneRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...value };
}

function serializable(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

function durationMs(cell: CodeModeCell): number {
  return Date.now() - cell.startedAtMs;
}

function missingCellResponse(cellId: string): CodeModeRuntimeResponse {
  return {
    type: "result",
    cellId,
    contentItems: [],
    storedValues: {},
    errorText: `exec cell ${cellId} not found`,
    durationMs: 0,
  };
}

export class QuickJsCodeModeService implements CodeModeService {
  private readonly available: boolean;
  private readonly active: boolean;
  private readonly cells = new Map<string, CodeModeCell>();
  private stored: Record<string, unknown> = {};
  private nextCell = 1;
  private host: CodeModeTurnHost | null = null;

  constructor(opts: QuickJsCodeModeServiceOptions = {}) {
    this.available = quickJsAvailable();
    this.active = shouldEnableCodeMode(opts) && this.available;
  }

  enabled(): boolean {
    return this.active;
  }

  async storedValues(): Promise<Readonly<Record<string, unknown>>> {
    return cloneRecord(this.stored);
  }

  async replaceStoredValues(
    values: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    this.stored = cloneRecord(values);
  }

  allocateCellId(): string {
    const id = String(this.nextCell);
    this.nextCell += 1;
    return id;
  }

  startTurnWorker(host: CodeModeTurnHost): CodeModeTurnWorker {
    const previous = this.host;
    this.host = host;
    return {
      dispose: () => {
        if (this.host === host) this.host = previous;
      },
    };
  }

  async execute(
    request: CodeModeExecuteRequest,
  ): Promise<CodeModeRuntimeResponse> {
    if (!this.enabled()) {
      return {
        type: "result",
        cellId: request.cellId,
        contentItems: [],
        storedValues: {},
        errorText: this.available
          ? "code mode is disabled; set AGENC_CODE_MODE=1 to enable exec/wait"
          : "code mode backend unavailable: quickjs-emscripten is not installed",
        durationMs: 0,
      };
    }

    const cell = this.spawnCell(request);
    this.cells.set(request.cellId, cell);
    return this.waitForCellResponse(
      cell,
      request.yieldTimeMs ?? DEFAULT_EXEC_YIELD_TIME_MS,
    );
  }

  async wait(request: CodeModeWaitRequest): Promise<CodeModeRuntimeResponse> {
    const cell = this.cells.get(request.cellId);
    if (!cell) return missingCellResponse(request.cellId);

    if (cell.completed) {
      const completed = cell.completed;
      this.cleanupCell(cell);
      return completed;
    }

    if (request.terminate === true) {
      cell.abortController.abort("terminated");
      cell.worker.postMessage({ type: "terminate" });
      void cell.worker.terminate();
      const response: CodeModeRuntimeResponse = {
        type: "terminated",
        cellId: cell.cellId,
        contentItems: this.takeContentItems(cell),
        durationMs: durationMs(cell),
      };
      this.cleanupCell(cell);
      return response;
    }

    cell.worker.postMessage({ type: "continue" });
    return this.waitForCellResponse(
      cell,
      request.yieldTimeMs ?? DEFAULT_WAIT_YIELD_TIME_MS,
    );
  }

  private spawnCell(request: CodeModeExecuteRequest): CodeModeCell {
    const worker = new Worker(QUICKJS_CODE_MODE_WORKER_SOURCE, {
      eval: true,
      workerData: {
        cellId: request.cellId,
        toolCallId: request.toolCallId,
        enabledTools: request.enabledTools,
        source: request.source,
        storedValues: request.storedValues,
      },
    });
    const cell: CodeModeCell = {
      cellId: request.cellId,
      toolCallId: request.toolCallId,
      worker,
      startedAtMs: Date.now(),
      abortController: new AbortController(),
      contentItems: [],
    };

    worker.on("message", (message: WorkerMessage) => {
      this.handleWorkerMessage(cell, message);
    });
    worker.on("error", (error: Error) => {
      this.completeCell(cell, {
        type: "result",
        cellId: cell.cellId,
        contentItems: this.takeContentItems(cell),
        storedValues: this.stored,
        errorText: error.message,
        durationMs: durationMs(cell),
      });
    });
    worker.on("exit", (code) => {
      if (cell.completed || !this.cells.has(cell.cellId)) return;
      if (code === 0) return;
      this.completeCell(cell, {
        type: "result",
        cellId: cell.cellId,
        contentItems: this.takeContentItems(cell),
        storedValues: this.stored,
        errorText: `exec runtime exited unexpectedly with code ${code}`,
        durationMs: durationMs(cell),
      });
    });

    return cell;
  }

  private handleWorkerMessage(
    cell: CodeModeCell,
    message: WorkerMessage,
  ): void {
    switch (message.type) {
      case "started":
        return;
      case "content_item":
        cell.contentItems.push(message.item);
        return;
      case "yield_requested":
        this.resolvePendingAsYielded(cell);
        return;
      case "notify":
        void this.host?.notify?.({
          cellId: cell.cellId,
          callId: message.callId,
          text: message.text,
        });
        return;
      case "tool_call":
        this.invokeNestedTool(cell, {
          cellId: cell.cellId,
          runtimeToolCallId: message.id,
          toolName: message.name,
          input: message.input,
        });
        return;
      case "result": {
        const response: CodeModeRuntimeResponse = {
          type: "result",
          cellId: cell.cellId,
          contentItems: this.takeContentItems(cell),
          storedValues: cloneRecord(message.storedValues ?? {}),
          ...(message.errorText !== undefined
            ? { errorText: message.errorText }
            : {}),
          durationMs: durationMs(cell),
        };
        this.replaceStoredValues(response.storedValues).catch(() => {});
        this.completeCell(cell, response);
      }
    }
  }

  private invokeNestedTool(
    cell: CodeModeCell,
    call: CodeModeNestedToolCall,
  ): void {
    const host = this.host;
    if (!host) {
      cell.worker.postMessage({
        type: "tool_error",
        id: call.runtimeToolCallId,
        error: "code mode nested tool host is not attached for this turn",
      });
      return;
    }

    host
      .invokeTool(call, cell.abortController.signal)
      .then((result) => {
        cell.worker.postMessage({
          type: "tool_response",
          id: call.runtimeToolCallId,
          result: serializable(result),
        });
      })
      .catch((error) => {
        cell.worker.postMessage({
          type: "tool_error",
          id: call.runtimeToolCallId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private waitForCellResponse(
    cell: CodeModeCell,
    yieldTimeMs: number,
  ): Promise<CodeModeRuntimeResponse> {
    if (cell.completed) {
      const completed = cell.completed;
      this.cleanupCell(cell);
      return Promise.resolve(completed);
    }

    return new Promise<CodeModeRuntimeResponse>((resolve) => {
      this.clearPendingTimer(cell);
      const pending: PendingResponse = {
        resolve,
      };
      pending.timer = setTimeout(() => {
        if (cell.pending !== pending) return;
        this.resolvePendingAsYielded(cell);
      }, Math.max(0, yieldTimeMs));
      cell.pending = pending;
    });
  }

  private resolvePendingAsYielded(cell: CodeModeCell): void {
    const pending = cell.pending;
    if (!pending) return;
    this.clearPendingTimer(cell);
    cell.pending = undefined;
    pending.resolve({
      type: "yielded",
      cellId: cell.cellId,
      contentItems: this.takeContentItems(cell),
      durationMs: durationMs(cell),
    });
  }

  private completeCell(
    cell: CodeModeCell,
    response: CodeModeRuntimeResponse,
  ): void {
    cell.completed = response;
    const pending = cell.pending;
    if (!pending) return;
    this.clearPendingTimer(cell);
    cell.pending = undefined;
    pending.resolve(response);
    if (response.type !== "yielded") this.cleanupCell(cell);
  }

  private takeContentItems(cell: CodeModeCell): FunctionCallOutputContentItem[] {
    const items = cell.contentItems;
    cell.contentItems = [];
    return items;
  }

  private clearPendingTimer(cell: CodeModeCell): void {
    if (cell.pending?.timer) {
      clearTimeout(cell.pending.timer);
      cell.pending.timer = undefined;
    }
  }

  private cleanupCell(cell: CodeModeCell): void {
    this.clearPendingTimer(cell);
    this.cells.delete(cell.cellId);
    cell.abortController.abort("closed");
    void cell.worker.terminate();
  }
}

export function createCodeModeService(
  opts: QuickJsCodeModeServiceOptions = {},
): CodeModeService {
  return new QuickJsCodeModeService(opts);
}
