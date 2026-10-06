import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkSession } from "../../fixtures.js";
import { normalizeMcpToolOutput } from "../../../src/mcp-client/tool-output.js";
import { readDisplayArtifact } from "../../../src/session/display-artifact-store.js";
import type { ToolRegistry } from "../../../src/tool-registry.js";
import {
  startCodeModeTurnWorker,
  type CodeModeWorkerSession,
} from "./turn-host.js";
import type {
  CodeModeExecuteRequest,
  CodeModeRuntimeResponse,
  CodeModeService,
  CodeModeTurnHost,
  CodeModeWaitRequest,
} from "./types.js";

class CapturingCodeModeService implements CodeModeService {
  host: CodeModeTurnHost | undefined;

  enabled(): boolean {
    return true;
  }

  async storedValues(): Promise<Readonly<Record<string, unknown>>> {
    return {};
  }

  async replaceStoredValues(): Promise<void> {
    return undefined;
  }

  allocateCellId(): string {
    return "1";
  }

  async execute(
    request: CodeModeExecuteRequest,
  ): Promise<CodeModeRuntimeResponse> {
    return {
      type: "result",
      cellId: request.cellId,
      contentItems: [],
      storedValues: {},
      durationMs: 0,
    };
  }

  async wait(request: CodeModeWaitRequest): Promise<CodeModeRuntimeResponse> {
    return {
      type: "result",
      cellId: request.cellId,
      contentItems: [],
      storedValues: {},
      durationMs: 0,
    };
  }

  startTurnWorker(host: CodeModeTurnHost): { dispose(): void } {
    this.host = host;
    return {
      dispose: () => {
        if (this.host === host) this.host = undefined;
      },
    };
  }
}

function makeSession(
  dispatchCodeModeNestedTool = vi.fn(async () => ({ content: "{}" })),
) {
  const service = new CapturingCodeModeService();
  const events: unknown[] = [];
  let nextId = 0;
  return {
    service,
    events,
    dispatchCodeModeNestedTool,
    session: {
      services: {
        codeModeService: service,
        registry: {
          dispatch: vi.fn(),
          dispatchCodeModeNestedTool,
        } as unknown as CodeModeWorkerSession["services"]["registry"],
      },
      nextInternalSubId: () => `internal-${nextId++}`,
      emit: (event) => {
        events.push(event);
      },
    },
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("code-mode turn host", () => {
  test("persists attachments from an actual nested call without a manually emitted completion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "code-mode-attachment-"));
    try {
      const normalized = await normalizeMcpToolOutput({
        raw: { content: [{ type: "resource", annotations: { audience: ["user"] }, resource: { uri: "agenc:test", mimeType: "application/vnd.agenc.table+json", text: JSON.stringify({ version: 1, title: "T", columns: [{ key: "name", label: "Name" }], rows: [{ name: "A" }] }) } }] },
        serverName: "fixture", toolName: "show", callId: "nested", environment: {}, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      const service = new CapturingCodeModeService();
      const registry = { dispatchCodeModeNestedTool: vi.fn(async () => normalized) } as unknown as ToolRegistry;
      const { session, events } = mkSession({ registry, services: { codeModeService: service } });
      session.rolloutStore = { store: { sessionDir: directory }, append: vi.fn(() => true) } as unknown as typeof session.rolloutStore;
      startCodeModeTurnWorker(session);
      const result = await service.host!.invokeTool({ cellId: "1", runtimeToolCallId: "nested", toolName: "mcp.fixture.show", input: {} }, signal());
      expect(JSON.stringify(result)).toContain("Shown to the user");
      const completed = events.find(event => event.msg.type === "tool_call_completed");
      expect(completed?.msg).toMatchObject({ payload: { displayAttachments: [expect.objectContaining({ kind: "table" })] } });
      if (completed?.msg.type !== "tool_call_completed") throw new Error("missing completion");
      const item = completed.msg.payload.displayAttachments![0]!;
      expect(readDisplayArtifact(directory, item.id)).toEqual(Buffer.from(JSON.stringify(item.data)));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  test("dispatches read-only nested tools and returns the code-mode projection", async () => {
    const dispatchCodeModeNestedTool = vi.fn(async () => ({
      content: '{"fallback":true}',
      codeModeResult: { projected: true },
    }));
    const { service, session } = makeSession(dispatchCodeModeNestedTool);
    const controller = new AbortController();

    const worker = startCodeModeTurnWorker(session);
    const host = service.host;
    expect(host).toBeDefined();
    const result = await host!.invokeTool(
      {
        cellId: "cell-1",
        runtimeToolCallId: "nested-1",
        toolName: "FileRead",
        input: { file_path: "README.md" },
      },
      controller.signal,
    );
    worker.dispose();

    expect(result).toEqual({ projected: true });
    expect(dispatchCodeModeNestedTool).toHaveBeenCalledWith({
      id: "exec-nested-1",
      name: "FileRead",
      input: { file_path: "README.md" },
      abortSignal: controller.signal,
    });
  });

  test("passes freeform string nested input through the code-mode dispatch path", async () => {
    const dispatchCodeModeNestedTool = vi.fn(async () => ({
      content: "plain result",
    }));
    const { service, session } = makeSession(dispatchCodeModeNestedTool);

    startCodeModeTurnWorker(session);
    const host = service.host;
    expect(host).toBeDefined();
    const result = await host!.invokeTool(
      {
        cellId: "cell-1",
        runtimeToolCallId: "nested-freeform",
        toolName: "system.bash",
        input: "pwd",
      },
      signal(),
    );

    expect(result).toBe("plain result");
    expect(dispatchCodeModeNestedTool).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "exec-nested-freeform",
        name: "system.bash",
        input: "pwd",
      }),
    );
  });

  test("falls back to parsed JSON content for nested tools without a projection", async () => {
    const dispatchCodeModeNestedTool = vi.fn(async () => ({ content: '{"value":42}' }));
    const { service, session } = makeSession(dispatchCodeModeNestedTool);

    startCodeModeTurnWorker(session);
    const host = service.host;
    expect(host).toBeDefined();
    const result = await host!.invokeTool(
      {
        cellId: "cell-1",
        runtimeToolCallId: "nested-2",
        toolName: "js_repl",
      },
      signal(),
    );

    expect(result).toEqual({ value: 42 });
  });

  test("rejects self-invocation and propagates nested dispatch errors", async () => {
    const dispatchCodeModeNestedTool = vi.fn(async () => ({
      content: "nested failed",
      isError: true,
    }));
    const { service, session } = makeSession(dispatchCodeModeNestedTool);

    startCodeModeTurnWorker(session);
    const host = service.host;
    expect(host).toBeDefined();

    await expect(
      host!.invokeTool(
        {
          cellId: "cell-1",
          runtimeToolCallId: "nested-3",
          toolName: "exec",
          input: {},
        },
        signal(),
      ),
    ).rejects.toThrow("cannot invoke itself");
    await expect(
      host!.invokeTool(
        {
          cellId: "cell-1",
          runtimeToolCallId: "nested-4",
          toolName: "Write",
          input: {},
        },
        signal(),
      ),
    ).rejects.toThrow("nested failed");

    expect(dispatchCodeModeNestedTool).toHaveBeenCalledTimes(1);
  });

  test("emits code-mode progress notifications through the session event stream", () => {
    const { service, session, events } = makeSession();

    startCodeModeTurnWorker(session);
    const host = service.host;
    expect(host).toBeDefined();
    host!.notify?.({
      cellId: "cell-1",
      callId: "exec-call",
      text: "still running",
    });

    expect(events).toEqual([
      {
        id: "internal-0",
        msg: {
          type: "tool_progress",
          payload: {
            callId: "exec-call",
            toolName: "exec",
            chunk: "still running",
            stream: "status",
          },
        },
      },
    ]);
  });

  test("ignores blank code-mode progress notifications", () => {
    const { service, session, events } = makeSession();

    startCodeModeTurnWorker(session);
    const host = service.host;
    expect(host).toBeDefined();
    host!.notify?.({
      cellId: "cell-1",
      callId: "exec-call",
      text: "   ",
    });

    expect(events).toEqual([]);
  });

  test("fails closed when the registry has no code-mode nested dispatch path", async () => {
    const service = new CapturingCodeModeService();
    const session: CodeModeWorkerSession = {
      services: {
        codeModeService: service,
        registry: {
          dispatch: vi.fn(),
        } as unknown as CodeModeWorkerSession["services"]["registry"],
      },
      nextInternalSubId: () => "internal-0",
      emit: () => undefined,
    };

    startCodeModeTurnWorker(session);
    const host = service.host;
    expect(host).toBeDefined();

    await expect(
      host!.invokeTool(
        {
          cellId: "cell-1",
          runtimeToolCallId: "nested-missing",
          toolName: "FileRead",
          input: { file_path: "README.md" },
        },
        signal(),
      ),
    ).rejects.toThrow("dispatch is unavailable");
  });

  test("returns a no-op worker and warning when the service is missing", () => {
    const events: unknown[] = [];
    const session: CodeModeWorkerSession = {
      services: {
        registry: {
          dispatch: vi.fn(),
        } as unknown as CodeModeWorkerSession["services"]["registry"],
      },
      nextInternalSubId: () => "internal-0",
      emit: (event) => {
        events.push(event);
      },
    };

    const worker = startCodeModeTurnWorker(session);
    worker.dispose();

    expect(events).toEqual([
      expect.objectContaining({
        msg: expect.objectContaining({
          type: "warning",
          payload: expect.objectContaining({
            cause: "code_mode_service_missing",
          }),
        }),
      }),
    ]);
  });
});
