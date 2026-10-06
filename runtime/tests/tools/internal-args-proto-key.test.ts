/**
 * A model's JSON `__proto__` key is data, never a prototype.
 *
 * `JSON.parse` keeps `"__proto__"` as an own key. The three strippers that
 * remove `__agenc*` keys from model arguments copied the rest by assignment,
 * and assigning `__proto__` on a plain object sets its prototype instead. The
 * key then vanished from every shape check, `additionalProperties: false`
 * included, and the model's object sat on the argument object's prototype
 * chain. An Edit-shaped MultiEdit call with an extra `__proto__` key was folded
 * and executed although its shape is invalid.
 */
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildFilteredRegistry } from "../../src/agents/run-agent.js";
import { stripAgenCInternalArgsForValidation } from "../../src/tools/argument-validation.js";
import { runToolUse } from "../../src/tools/execution.js";
import { ToolRouter } from "../../src/tools/router.js";
import { createFileMultiEditTool } from "../../src/tools/system/file-edit.js";
import { EventLog } from "../../src/session/event-log.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { Session } from "../../src/session/session.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import type { ToolInvocation } from "../../src/tools/context.js";
import type { PreToolUseHook } from "../../src/tools/hooks.js";
import type { Tool } from "../../src/tools/types.js";

/** The reproduction from review: Edit-shaped, one `__agenc*` key, one `__proto__` key. */
const SMUGGLED =
  '{"file_path":"a","old_string":"x","new_string":"y","__agencX":0,"__proto__":{"smuggled":true}}';

let root = "";

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agenc-proto-key-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function invocationFor(name: string, raw: string, eventLog: EventLog): ToolInvocation {
  return {
    session: {
      eventLog,
      services: {
        admissionRequired: false,
        runtimeOptions: resolveAgentRuntimeOptions({}),
      },
    } as never,
    turn: { cwd: root } as never,
    tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} },
    callId: "c1",
    toolName: { name },
    payload: { kind: "function", arguments: raw },
    source: "direct",
  };
}

function expectDataKey(args: Record<string, unknown> | undefined): void {
  expect(args).toBeDefined();
  expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
  expect(Object.hasOwn(args!, "__proto__")).toBe(true);
  expect(Object.getOwnPropertyDescriptor(args!, "__proto__")?.value).toEqual({
    smuggled: true,
  });
  expect((args as { smuggled?: unknown }).smuggled).toBeUndefined();
}

describe("a model `__proto__` key survives internal-argument stripping as data", () => {
  test("the validation stripper copies it as an own key", () => {
    const stripped = stripAgenCInternalArgsForValidation(JSON.parse(SMUGGLED));
    expectDataKey(stripped);
    expect(Object.keys(stripped)).toEqual([
      "file_path",
      "old_string",
      "new_string",
      "__proto__",
    ]);
  });

  test("the model dispatch stripper hands it to the tool as an own key", async () => {
    const seen: Record<string, unknown>[] = [];
    const probe: Tool = {
      name: "Probe",
      description: "records its arguments",
      inputSchema: { type: "object" },
      execute: async (args) => {
        seen.push(args);
        return { content: "ok" };
      },
    };
    const raw = '{"path":"a","__agencX":0,"__proto__":{"smuggled":true}}';
    const router = new ToolRouter([{ tool: probe, supportsParallelToolCalls: false }]);
    const call = invocationFor("Probe", raw, new EventLog());
    const result = await router.dispatchModelToolCall(
      { id: "c1", name: "Probe", arguments: raw },
      { ...call, approvalPolicy: "never", sandboxMode: "workspace_write" },
    );
    expect(result.isError).not.toBe(true);
    expectDataKey(seen[0]);
    expect(Object.hasOwn(seen[0]!, "__agencX")).toBe(false);
  });

  test("the child-agent stripper hands it to the tool as an own key", async () => {
    const seen: Record<string, unknown>[] = [];
    const glob = {
      name: "Glob",
      description: "records its arguments",
      inputSchema: { type: "object", properties: {} },
      async execute(args: Record<string, unknown>) {
        seen.push(args);
        return { content: "ok" };
      },
    } as unknown as Tool;
    const permissions = { current: () => ({ mode: "default", additionalWorkingDirectories: new Map() }) };
    const session = {
      conversationId: "child-1",
      sessionConfiguration: { cwd: root, sandboxPolicy: { value: "workspace_write" } },
      permissionModeRegistry: permissions,
      services: { permissionModeRegistry: permissions },
    } as unknown as Session;
    const base = {
      tools: [glob],
      toLLMTools: () => [
        { type: "function", function: { name: "Glob", description: "", parameters: {} } },
      ],
    } as unknown as ToolRegistry;
    const registry = buildFilteredRegistry(base, {
      childConversationId: "child-1",
      getSession: () => session,
    });
    await registry.tools
      .find((tool) => tool.name === "Glob")!
      .execute(JSON.parse('{"pattern":"*","__agencX":0,"__proto__":{"smuggled":true}}'));
    expectDataKey(seen[0]);
    expect(Object.hasOwn(seen[0]!, "__agencX")).toBe(false);
  });

  test.each(["execution", "model"] as const)(
    "%s entry: the review's Edit-shaped call with `__proto__` fails before hooks and execution",
    async (boundary) => {
      const file = join(root, "a");
      await writeFile(file, "x\n", "utf8");
      const raw = SMUGGLED.replace('"file_path":"a"', `"file_path":${JSON.stringify(file)}`);
      const eventLog = new EventLog();
      const warnings: unknown[] = [];
      eventLog.subscribe((event) => {
        if (event.msg.type === "warning") warnings.push(event.msg.payload);
      });
      const execute = vi.fn(async () => ({ content: "must not run" }));
      const tool: Tool = { ...createFileMultiEditTool({ allowedPaths: [root] }), execute };
      const preHook = vi.fn<PreToolUseHook>(async () => ({ kind: "continue" }));
      const call = invocationFor("MultiEdit", raw, eventLog);
      let content: string;
      let isError: boolean | undefined;
      if (boundary === "execution") {
        const result = await runToolUse(raw, {
          tool,
          invocation: call,
          currentTurnId: "t1",
          eventLog,
          preHooks: [preHook],
        });
        content = String(result.content);
        isError = result.isError;
      } else {
        const router = new ToolRouter([{ tool, supportsParallelToolCalls: false }]);
        const result = await router.dispatchModelToolCall(
          { id: "c1", name: "MultiEdit", arguments: raw },
          { ...call, approvalPolicy: "never", sandboxMode: "workspace_write", preHooks: [preHook] },
        );
        content = result.content;
        isError = result.isError;
      }
      expect(isError).toBe(true);
      expect(content).toContain("The required parameter `edits` is missing");
      expect(content).toContain("An unexpected parameter `__proto__` was provided");
      expect(preHook).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(warnings).not.toContainEqual(
        expect.objectContaining({ cause: "tool_input_reshaped" }),
      );
      expect(await readFile(file, "utf8")).toBe("x\n");
    },
  );
});
