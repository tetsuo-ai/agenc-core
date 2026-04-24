import { describe, expect, test } from "vitest";
import { createCodeModeTools } from "./tools.js";
import { QuickJsCodeModeService } from "./service.js";
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
    expect(first?.content).toContain("Script running with cell ID");
    const match = first?.content.match(/cell ID (\d+)/);
    expect(match?.[1]).toBeDefined();

    const second = await wait?.execute({
      cell_id: match?.[1],
      yield_time_ms: 500,
    });
    expect(second?.content).toContain("Script completed");
    expect(second?.content).toContain("done");
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

    expect(result.content).toContain("Script completed");
    expect(result.content).toContain("hello");
    expect(exec.description).toContain("system_echo");
  });
});
