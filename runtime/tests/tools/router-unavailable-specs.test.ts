/**
 * A router spec marked `unavailable` is kept for telemetry and tracing only:
 * `ConfiguredToolSpec.unavailable` says it cannot be invoked directly. It was
 * still dispatchable at both router entries, still advertised to the model,
 * still loadable through tool search, and lost on the way to the session
 * router, which is rebuilt from `registry.tools`. Now every dispatch path
 * refuses it with a clear error settled as no effect, it leaves the
 * model-visible and search catalogs, and it stays in `getSpecs()` and
 * `registry.tools` for tracing.
 */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildToolRegistry, type ToolRegistry } from "../../src/tool-registry.js";
import type { CodeModeService } from "../../src/tools/code-mode/types.js";
import { routerFromRegistry, ToolRouter } from "../../src/tools/router.js";
import { StreamingToolExecutor } from "../../src/tools/streaming-executor.js";
import { EventLog } from "../../src/session/event-log.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { ToolInvocation } from "../../src/tools/context.js";
import type { Tool } from "../../src/tools/types.js";

let root = "";

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agenc-unavailable-spec-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The refusal every dispatch path returns for an unavailable spec. */
function refusal(name: string) {
  return {
    isError: true,
    content: `<tool_use_error>Error: ${name} is unavailable in this session and cannot be called.</tool_use_error>`,
    effectDisposition: {
      disposition: "confirmed_no_effect",
      evidenceKind: "boundary_not_crossed",
      evidenceRef: `tool:${name}:unavailable`,
    },
  };
}

function probe(name: string, execute: Tool["execute"]): Tool {
  return { name, description: "records calls", inputSchema: { type: "object" }, execute };
}

function invocationFor(name: string): ToolInvocation {
  return {
    session: {
      eventLog: new EventLog(),
      services: {
        admissionRequired: false,
        runtimeOptions: resolveAgentRuntimeOptions({}),
      },
    } as never,
    turn: {} as never,
    tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} },
    callId: "c1",
    toolName: { name },
    payload: { kind: "function", arguments: "{}" },
    source: "direct",
  };
}

describe("router specs marked unavailable", () => {
  test("direct dispatch refuses one, settled as no effect", async () => {
    const execute = vi.fn(async () => ({ content: "ran" }));
    const router = new ToolRouter([
      { tool: probe("Probe", execute), supportsParallelToolCalls: false, unavailable: true },
    ]);
    const result = await router.dispatchToolCall(invocationFor("Probe"), {});
    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject(refusal("Probe"));
  });

  test("model dispatch refuses one, settled as no effect", async () => {
    const execute = vi.fn(async () => ({ content: "ran" }));
    const router = new ToolRouter([
      { tool: probe("Probe", execute), supportsParallelToolCalls: false, unavailable: true },
    ]);
    const call = invocationFor("Probe");
    const result = await router.dispatchModelToolCall(
      { id: "c1", name: "Probe", arguments: "{}" },
      { ...call, approvalPolicy: "never", sandboxMode: "workspace_write" },
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject(refusal("Probe"));
  });

  test("one stays in getSpecs for tracing but leaves the model-visible catalog", () => {
    const run = vi.fn(async () => ({ content: "ran" }));
    const router = new ToolRouter([
      { tool: probe("Probe", run), supportsParallelToolCalls: false, unavailable: true },
      { tool: probe("Other", run), supportsParallelToolCalls: false },
    ]);
    expect(router.getSpecs().map((spec) => spec.tool.name)).toEqual(["Probe", "Other"]);
    expect(router.modelVisibleSpecs().map((tool) => tool.function.name)).toEqual(["Other"]);
  });

  test("a registry's unavailable tool stays known but is never offered, found or run", async () => {
    const registry = buildToolRegistry({
      workspaceRoot: root,
      unavailableCalledTools: ["Grep"],
    });
    expect(registry.tools.map((tool) => tool.name)).toContain("Grep");
    expect(registry.toLLMTools().map((tool) => tool.function.name)).not.toContain("Grep");
    const search = registry.tools.find((tool) => tool.name === "system.searchTools")!;
    const found = JSON.parse((await search.execute({ query: "select:Grep" })).content) as {
      readonly loaded: readonly string[];
      readonly missingSelections: readonly string[];
    };
    expect(found.loaded).toEqual([]);
    expect(found.missingSelections).toEqual(["Grep"]);
    expect(await registry.dispatch({ id: "c1", name: "Grep", arguments: "{}" })).toMatchObject(
      refusal("Grep"),
    );
    // The session router is rebuilt from the registry and must keep the flag.
    expect(
      routerFromRegistry(registry)
        .getSpecs()
        .find((spec) => spec.tool.name === "Grep")?.unavailable,
    ).toBe(true);
  });

  test("code mode neither hands a cell the tool nor runs it", async () => {
    const echo = vi.fn(async () => ({ content: '{"ok":true}' }));
    const enabled: string[][] = [];
    const service = {
      enabled: () => true,
      storedValues: async () => ({}),
      replaceStoredValues: async () => {},
      allocateCellId: () => "cell-1",
      execute: async (request: { readonly enabledTools: ReadonlyArray<{ readonly name: string }> }) => {
        enabled.push(request.enabledTools.map((tool) => tool.name));
        return { type: "result", cellId: "cell-1", contentItems: [], storedValues: {}, durationMs: 0 };
      },
      wait: async () => {
        throw new Error("unused");
      },
      startTurnWorker: () => ({ dispose: () => undefined }),
    } as unknown as CodeModeService;
    const registry = buildToolRegistry({
      workspaceRoot: root,
      codeModeService: service,
      unavailableCalledTools: ["custom.echo"],
      extraTools: [
        {
          name: "custom.echo",
          description: "Echoes input.",
          inputSchema: { type: "object" },
          metadata: { mutating: false },
          isReadOnly: true,
          recoveryCategory: "idempotent",
          execute: echo,
        } satisfies Tool,
      ],
    });
    await registry.tools.find((tool) => tool.name === "exec")!.execute({ code: "1" });
    expect(enabled).toHaveLength(1);
    expect(enabled[0]).not.toContain("custom.echo");
    expect(
      await registry.dispatchCodeModeNestedTool!({ id: "n1", name: "custom.echo", input: {} }),
    ).toMatchObject(refusal("custom.echo"));
    expect(echo).not.toHaveBeenCalled();
  });

  test("the live session executor refuses a tool its registry marks unavailable", async () => {
    const execute = vi.fn(async () => ({ content: "ran" }));
    const registry: ToolRegistry = {
      tools: [probe("Probe", execute)],
      toLLMTools: () => [],
      dispatch: async () => ({ content: "registry fallback must not run" }),
      getUnavailableToolNames: () => new Set(["Probe"]),
    };
    const exec = new StreamingToolExecutor({
      registry,
      liveToolDispatch: {
        router: routerFromRegistry(registry),
        options: {
          ...invocationFor("Probe"),
          approvalPolicy: "never",
          sandboxMode: "workspace_write",
        },
      },
    });
    exec.addTool(
      { type: "tool_use", id: "c1", name: "Probe", input: {} },
      { id: "c1", name: "Probe", arguments: "{}" },
    );
    exec.close();
    const results = [];
    for await (const result of exec.getRemainingResults()) results.push(result);
    expect(execute).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]!.result).toMatchObject(refusal("Probe"));
  });
});
