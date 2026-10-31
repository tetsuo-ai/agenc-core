import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * Released 0.19.25 regression (job xu, Fxu-4): every script failed in a daemon
 * session with "Cannot find module 'quickjs-emscripten'", required from
 * "~/.agenc/[worker eval]". A cell runs in an eval worker, which resolves a bare
 * require from the process working directory, and the daemon runs in
 * AGENC_HOME, outside the runtime install that holds the package.
 */
describe("QuickJsCodeModeService outside the runtime install", () => {
  test("runs a script when the working directory cannot resolve quickjs-emscripten, as the daemon's AGENC_HOME cannot", async () => {
    const previous = process.cwd();
    const home = mkdtempSync(join(tmpdir(), "agenc-home-cwd-"));
    try {
      process.chdir(home);
      // The layout this test stands for: nothing above the working directory
      // provides the package, as for ~/.agenc in an installed runtime.
      expect(() => createRequire(join(home, "[worker eval]")).resolve("quickjs-emscripten")).toThrow();
      const service = makeService();
      expect(service.enabled()).toBe(true);
      const response = await service.execute(
        await request(service, 'text("code mode ran: " + (6 * 7))', { yieldTimeMs: 10_000 }),
      );

      expect(codeModeRuntimeResponseToToolResult(response).content).not.toContain("Cannot find module");
      expect(response).toMatchObject({ type: "result" });
      expect(response.type === "result" ? response.errorText : "not a result").toBeUndefined();
      expect(response.contentItems).toEqual([{ type: "input_text", text: "code mode ran: 42" }]);
    } finally {
      process.chdir(previous);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
