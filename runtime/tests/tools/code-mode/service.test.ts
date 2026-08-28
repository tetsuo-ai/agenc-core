import { afterEach, describe, expect, test } from "vitest";
import { QuickJsCodeModeService } from "./service.js";
import { codeModeRuntimeResponseToToolResult } from "./tools.js";
import type { CodeModeExecuteRequest } from "./types.js";

let services: QuickJsCodeModeService[] = [];

function makeService(): QuickJsCodeModeService {
  const service = new QuickJsCodeModeService({ enabled: true });
  services.push(service);
  return service;
}

async function request(
  service: QuickJsCodeModeService,
  source: string,
  overrides: Partial<CodeModeExecuteRequest> = {},
): Promise<CodeModeExecuteRequest> {
  return {
    cellId: overrides.cellId ?? service.allocateCellId(),
    toolCallId: overrides.toolCallId ?? "call-1",
    enabledTools: overrides.enabledTools ?? [],
    source,
    storedValues: overrides.storedValues ?? (await service.storedValues()),
    yieldTimeMs: overrides.yieldTimeMs ?? 1000,
    maxOutputTokens: overrides.maxOutputTokens,
  };
}

afterEach(async () => {
  for (const service of services) {
    await service.wait({ cellId: "1", terminate: true }).catch(() => {});
    await service.wait({ cellId: "2", terminate: true }).catch(() => {});
    await service.wait({ cellId: "3", terminate: true }).catch(() => {});
  }
  services = [];
});

describe("QuickJsCodeModeService", () => {
  test("executes JavaScript and returns text output", async () => {
    const service = makeService();
    const response = await service.execute(
      await request(service, 'text("hello from code mode")'),
    );

    expect(response.type).toBe("result");
    expect(response.contentItems).toEqual([
      { type: "input_text", text: "hello from code mode" },
    ]);
    const content = codeModeRuntimeResponseToToolResult(response).content;
    // Output-first contract: stdout body leads, [code_mode ...] footer trails.
    expect(content.startsWith("hello from code mode")).toBe(true);
    expect(content).toMatch(/\[code_mode status=completed [^\]]+\]$/);
  });

  test("marks runtime failures before any effect as confirmed no-effect", async () => {
    const service = makeService();
    const response = await service.execute(
      await request(service, 'throw new Error("before effects")'),
    );
    const result = codeModeRuntimeResponseToToolResult(response);

    expect(response).toMatchObject({
      type: "result",
      effectBoundaryCrossed: false,
    });
    expect(result).toMatchObject({
      isError: true,
      effectDisposition: {
        disposition: "confirmed_no_effect",
        evidenceKind: "boundary_not_crossed",
      },
    });
  });

  test("tracks persisted store and notification effects before runtime failure", async () => {
    const service = makeService();
    const notified: string[] = [];
    const worker = service.startTurnWorker({
      invokeTool: async () => undefined,
      notify: ({ text }) => notified.push(text),
    });

    const storedResponse = await service.execute(
      await request(
        service,
        'store("saved", 42); throw new Error("after store")',
      ),
    );
    const notifyResponse = await service.execute(
      await request(
        service,
        'notify("visible"); throw new Error("after notify")',
      ),
    );
    worker.dispose();

    expect(storedResponse).toMatchObject({
      type: "result",
      effectBoundaryCrossed: true,
    });
    expect(notifyResponse).toMatchObject({
      type: "result",
      effectBoundaryCrossed: true,
    });
    expect(
      codeModeRuntimeResponseToToolResult(storedResponse).effectDisposition,
    ).toBeUndefined();
    expect(
      codeModeRuntimeResponseToToolResult(notifyResponse).effectDisposition,
    ).toBeUndefined();
    expect(await service.storedValues()).toMatchObject({ saved: 42 });
    expect(notified).toContain("visible");
  });

  test("stores serializable values across exec cells", async () => {
    const service = makeService();
    await service.execute(
      await request(service, 'store("answer", { value: 42 })'),
    );

    const response = await service.execute(
      await request(service, 'text(load("answer").value)'),
    );

    expect(response.contentItems).toEqual([{ type: "input_text", text: "42" }]);
  });

  test("yields long-running cells and wait returns the final result", async () => {
    const service = makeService();
    const response = await service.execute(
      await request(
        service,
        'await new Promise((resolve) => setTimeout(resolve, 25)); text("later")',
        { yieldTimeMs: 1 },
      ),
    );

    expect(response.type).toBe("yielded");
    const final = await service.wait({
      cellId: response.cellId,
      yieldTimeMs: 500,
    });
    expect(final.type).toBe("result");
    expect(final.contentItems).toEqual([{ type: "input_text", text: "later" }]);
  });

  test("does not clobber a concurrent cell store or claim no-effect from a stale failure", async () => {
    const service = makeService();
    const first = await service.execute(
      await request(service, 'await yield_control(); store("newer", 1)'),
    );
    const second = await service.execute(
      await request(
        service,
        'await yield_control(); throw new Error("stale failure")',
      ),
    );

    expect(first.type).toBe("yielded");
    expect(second.type).toBe("yielded");

    const firstFinal = await service.wait({
      cellId: first.cellId,
      yieldTimeMs: 500,
    });
    const secondFinal = await service.wait({
      cellId: second.cellId,
      yieldTimeMs: 500,
    });

    expect(await service.storedValues()).toEqual({ newer: 1 });
    expect(secondFinal).toMatchObject({
      type: "result",
      errorText: "stale failure",
      storedValues: { newer: 1 },
      effectBoundaryCrossed: false,
    });
    expect(
      codeModeRuntimeResponseToToolResult(secondFinal).effectDisposition,
    ).toMatchObject({
      disposition: "confirmed_no_effect",
      evidenceKind: "boundary_not_crossed",
    });
    expect(firstFinal).toMatchObject({
      type: "result",
      storedValues: { newer: 1 },
      effectBoundaryCrossed: true,
    });
  });

  test("rejects a stale store snapshot instead of overwriting newer values", async () => {
    const service = makeService();
    const first = await service.execute(
      await request(service, 'await yield_control(); store("value", "newer")'),
    );
    const second = await service.execute(
      await request(service, 'await yield_control(); store("value", "stale")'),
    );

    expect(first.type).toBe("yielded");
    expect(second.type).toBe("yielded");
    await service.wait({ cellId: first.cellId, yieldTimeMs: 500 });
    const stale = await service.wait({
      cellId: second.cellId,
      yieldTimeMs: 500,
    });

    expect(await service.storedValues()).toEqual({ value: "newer" });
    expect(stale).toMatchObject({
      type: "result",
      storedValues: { value: "newer" },
      effectBoundaryCrossed: false,
    });
    expect(stale.errorText).toContain("stale store update was not applied");
    expect(
      codeModeRuntimeResponseToToolResult(stale).effectDisposition,
    ).toMatchObject({
      disposition: "confirmed_no_effect",
      evidenceKind: "boundary_not_crossed",
    });
  });

  test("nested tools resolve through the attached turn host", async () => {
    const service = makeService();
    const worker = service.startTurnWorker({
      invokeTool: async (call) => ({ echo: call.input }),
    });
    const response = await service.execute(
      await request(
        service,
        'const result = await tools.system_echo({ text: "hi" }); text(result.echo.text)',
        {
          enabledTools: [
            {
              name: "system.echo",
              globalName: "system_echo",
              description: "Echo input.",
              kind: "function",
              inputSchema: { type: "object" },
            },
          ],
        },
      ),
    );
    worker.dispose();

    expect(response.type).toBe("result");
    expect(response.contentItems).toEqual([{ type: "input_text", text: "hi" }]);
  });

  test("terminate stops a yielded cell", async () => {
    const service = makeService();
    const response = await service.execute(
      await request(service, "await new Promise(() => {})", { yieldTimeMs: 1 }),
    );

    expect(response.type).toBe("yielded");
    const terminated = await service.wait({
      cellId: response.cellId,
      terminate: true,
    });
    expect(terminated.type).toBe("terminated");
  });
});
