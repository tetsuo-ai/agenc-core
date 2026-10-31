import { describe, expect, test } from "vitest";
import { createCodeModeTools } from "./tools.js";
import { QuickJsCodeModeService } from "./service.js";
import type { CodeModeExecuteRequest, CodeModeService } from "./types.js";
import { attachToolRuntimeContext } from "../../../src/tools/runtimes/context.js";
import type { Tool } from "../types.js";

describe("code-mode tools", () => {
  test("exec and wait tool adapters expose running cell lifecycle", async () => {
    const service = new QuickJsCodeModeService({ enabled: true });
    const tools = createCodeModeTools({
      service,
      getEnabledTools: () => [],
    });
    const exec = tools.find((tool) => tool.name === "exec");
    const wait = tools.find((tool) => tool.name === "wait");

    expect(exec).toBeDefined();
    expect(wait).toBeDefined();

    const first = await exec?.execute({
      code: '// @exec: {"yield_time_ms": 1}\nawait new Promise((resolve) => setTimeout(resolve, 25)); text("done")',
      __callId: "exec-1",
    });
    // Yielded responses lead with the running-cell announcement (no
    // user-visible output yet, so the announcement IS the body).
    expect(first?.content.startsWith("Script running with cell ID")).toBe(true);
    expect(first?.content).toMatch(/\[code_mode status=yielded /);
    const match = first?.content.match(/cell ID (\d+)/);
    expect(match?.[1]).toBeDefined();

    const second = await wait?.execute({
      cell_id: match?.[1],
      yield_time_ms: 500,
    });
    // Output must lead, the [code_mode ...] footer must trail. The
    // previous order put a "Script completed / Wall time / Output:"
    // header BEFORE stdout — same anti-pattern that triggered Grok's
    // exec_command 3x retry.
    expect(second?.content.startsWith("done")).toBe(true);
    expect(second?.content).toMatch(/\[code_mode status=completed [^\]]+\]$/);
  });

  test("exec exposes nested registry tools through enabled tool metadata", async () => {
    const service = new QuickJsCodeModeService({ enabled: true });
    const echoTool: Tool = {
      name: "system.echo",
      description: "Echoes text.",
      inputSchema: { type: "object" },
      execute: async () => ({ content: "{}" }),
    };
    const worker = service.startTurnWorker({
      invokeTool: async (call) => ({ value: call.input }),
    });
    const [exec] = createCodeModeTools({
      service,
      getEnabledTools: () => [echoTool],
      descriptionTools: [echoTool],
    });

    const result = await exec.execute({
      code: "const out = await tools.system_echo({ text: 'hello' }); text(out.value.text)",
      __callId: "exec-2",
    });
    worker.dispose();

    expect(result.content.startsWith("hello")).toBe(true);
    expect(result.content).toMatch(/\[code_mode status=completed [^\]]+\]$/);
    expect(exec.description).toContain("system_echo");
  });

  test("exec refuses before a cell runs, and says the boundary was not crossed", async () => {
    // #2190: a bare error from a mutating tool gates the session behind /resolve.
    const [exec] = createCodeModeTools({
      service: new QuickJsCodeModeService({ enabled: true }),
      getEnabledTools: () => [],
    });
    for (const args of [{}, { code: 42 }]) {
      const result = await exec.execute(args);
      expect(result.isError).toBe(true);
      expect(String(result.content)).toContain("code must be a string");
      expect(result.effectDisposition?.disposition).toBe("confirmed_no_effect");
    }
  });
});

describe("code-mode exec ownership", () => {
  test("exec names the session whose tool call starts the cell (Fxu-6)", async () => {
    const requests: CodeModeExecuteRequest[] = [];
    const service: CodeModeService = {
      enabled: () => true,
      storedValues: async () => ({}),
      replaceStoredValues: async () => {},
      allocateCellId: () => "1",
      execute: async (request) => {
        requests.push(request);
        return { type: "result", cellId: request.cellId, contentItems: [], storedValues: {}, durationMs: 0 };
      },
      wait: async (request) => ({ type: "terminated", cellId: request.cellId, contentItems: [], durationMs: 0 }),
      startTurnWorker: () => ({ dispose: () => {} }),
    };
    const [exec] = createCodeModeTools({ service, getEnabledTools: () => [] });
    const session = { conversationId: "session-that-called-exec" };
    const args: Record<string, unknown> = { code: 'text("x")' };
    attachToolRuntimeContext(args, {
      callId: "call-1", toolName: "exec", sandboxMode: "danger-full-access",
      invocation: { session },
    } as never);
    await exec!.execute(args);

    expect(requests).toHaveLength(1);
    expect((requests[0] as { readonly owner?: unknown }).owner).toBe(session);
  });
});
