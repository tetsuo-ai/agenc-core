import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { QuickJsCodeModeService } from "./service.js";
import { codeModeRuntimeResponseToToolResult } from "./tools.js";
import { startCodeModeTurnWorker, type CodeModeWorkerSession } from "./turn-host.js";
import type { CodeModeExecuteRequest, CodeModeTurnHost } from "./types.js";

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

/**
 * Fxu-6 (job xu): a parent and its sub-agents share one service. Each nested
 * call went to the turn that started last, so a script's call could run in
 * another session, and ending turns in a different order brought back a host
 * whose turn had ended. A cell now belongs to the turn host of the session that
 * started it and is refused once that turn has ended.
 */
describe("QuickJsCodeModeService turn hosts", () => {
  const PROBE = [{ name: "probe", globalName: "probe", description: "Probe.", kind: "function" as const, inputSchema: { type: "object" } }];
  const PROBE_LATER =
    "await new Promise((resolve) => setTimeout(resolve, 100));\n" +
    'try { text(await tools.probe({})); } catch (error) { text("refused: " + String(error)); }';

  function recordingHost(name: string, owner: object, seen: string[]): CodeModeTurnHost {
    return { owner, invokeTool: async (call) => { seen.push(`${name}:${call.toolName}`); return `${name} served`; } } as CodeModeTurnHost;
  }

  async function startCell(service: QuickJsCodeModeService, owner: object, source = PROBE_LATER) {
    const started = await service.execute({
      ...(await request(service, source, { enabledTools: PROBE, yieldTimeMs: 10 })),
      owner,
    } as CodeModeExecuteRequest);
    expect(started.type).toBe("yielded");
    return started;
  }

  test("serves a cell's nested call from the turn of the session that started it, though another session's turn started later", async () => {
    const service = makeService();
    const parent = {};
    const child = {};
    const seen: string[] = [];
    const parentTurn = service.startTurnWorker(recordingHost("parent", parent, seen));
    const started = await startCell(service, parent);
    const childTurn = service.startTurnWorker(recordingHost("child", child, seen));
    const done = await service.wait({ cellId: started.cellId, yieldTimeMs: 5_000 });
    childTurn.dispose();
    parentTurn.dispose();

    expect(seen).toEqual(["parent:probe"]);
    expect(done.contentItems).toEqual([{ type: "input_text", text: "parent served" }]);
  });

  test.each([["the same session's next turn", true], ["another session's turn", false]] as const)(
    "refuses a cell's nested call once the turn that started it has ended, with %s attached",
    async (_label, sameSession) => {
      const service = makeService();
      const owner = {};
      const seen: string[] = [];
      const firstTurn = service.startTurnWorker(recordingHost("first", owner, seen));
      const started = await startCell(service, owner);
      firstTurn.dispose();
      const otherTurn = service.startTurnWorker(recordingHost("other", sameSession ? owner : {}, seen));
      const done = await service.wait({ cellId: started.cellId, yieldTimeMs: 5_000 });
      otherTurn.dispose();

      expect(seen).toEqual([]);
      expect(done.contentItems).toEqual([{ type: "input_text", text: expect.stringContaining("refused") }]);
    },
  );

  test("does not bring back a turn host after the turns end in another order", async () => {
    const service = makeService();
    const seen: string[] = [];
    const turnA = service.startTurnWorker(recordingHost("A", {}, seen));
    const turnB = service.startTurnWorker(recordingHost("B", {}, seen));
    turnA.dispose();
    turnB.dispose();
    const response = await service.execute(await request(service,
      'try { text(await tools.probe({})); } catch (error) { text("refused: " + String(error)); }',
      { enabledTools: PROBE, yieldTimeMs: 5_000 }));

    expect(seen).toEqual([]);
    expect(response.contentItems).toEqual([{ type: "input_text", text: expect.stringContaining("refused") }]);
  });

  test("a sub-agent's script cannot run with the parent's authority after both turns end (job sf review 2, item 1)", async () => {
    const service = makeService();
    const served: string[] = [];
    // Each registry stands for its session's permission context: the parent's
    // carries grants (a skill's pre-approved tools in job sf's reproduction).
    const session = (name: string): CodeModeWorkerSession => ({
      services: {
        codeModeService: service,
        registry: {
          dispatch: async () => ({ content: "", isError: false }),
          dispatchCodeModeNestedTool: async (call: { readonly name: string }) => {
            served.push(`${name}:${call.name}`);
            return { content: JSON.stringify(`${name} authority used`), isError: false };
          },
        },
      },
      nextInternalSubId: () => "sub",
      emit: () => {},
    }) as unknown as CodeModeWorkerSession;
    const parent = session("parent grants");
    const child = session("child");
    const parentTurn = startCodeModeTurnWorker(parent);
    const childTurn = startCodeModeTurnWorker(child);
    const started = await startCell(service, child);
    // The parent's turn ends before the sub-agent's; ending the sub-agent's
    // turn used to restore the ended parent's host, grants included.
    parentTurn.dispose();
    childTurn.dispose();
    const done = await service.wait({ cellId: started.cellId, yieldTimeMs: 5_000 });

    expect(served).toEqual([]);
    expect(done.contentItems).toEqual([{ type: "input_text", text: expect.stringContaining("refused") }]);
  });

  test("a parent's script keeps its nested calls in the parent while a sub-agent's turn runs", async () => {
    const service = makeService();
    const dispatched: string[] = [];
    const session = (name: string, nestedDispatch: boolean): CodeModeWorkerSession => ({
      services: {
        codeModeService: service,
        registry: {
          dispatch: async () => ({ content: "", isError: false }),
          // A sub-agent's filtered registry has no nested dispatch (Fxu-5).
          ...(nestedDispatch ? {
            dispatchCodeModeNestedTool: async (call: { readonly name: string }) => {
              dispatched.push(`${name}:${call.name}`);
              return { content: JSON.stringify(`${name} served`), isError: false };
            },
          } : {}),
        },
      },
      nextInternalSubId: () => "sub",
      emit: () => {},
    }) as unknown as CodeModeWorkerSession;
    const parent = session("parent", true);
    const child = session("child", false);
    const parentTurn = startCodeModeTurnWorker(parent);
    // The exec tool names the session whose tool call starts the cell.
    const started = await startCell(service, parent);
    const childTurn = startCodeModeTurnWorker(child);
    const done = await service.wait({ cellId: started.cellId, yieldTimeMs: 5_000 });
    childTurn.dispose();
    parentTurn.dispose();

    expect(dispatched).toEqual(["parent:probe"]);
    expect(done.contentItems).toEqual([{ type: "input_text", text: "parent served" }]);
  });
});
