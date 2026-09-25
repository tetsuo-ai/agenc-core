/**
 * MultiEdit called with Edit's argument shape.
 *
 * Models (DeepSeek V4.1 Flash, observed 3 of 64 MultiEdit calls in one run)
 * send `{ file_path, old_string, new_string }`, optionally with
 * `replace_all`, and no `edits` array. That is exactly one edit, so the
 * model-input entry point folds it into `edits: [{ ... }]`, the same seam
 * and the same rules as the double-encoded argument repair (#2642): only the
 * model's raw arguments, once, before any hook, rule or approval; the result
 * is validated strictly; anything else keeps the original error; hooks and
 * rewrites get no repair; history keeps the model's bytes.
 */
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/services/lsp/fileNotifications.js", () => ({
  notifyLspFileChanged: vi.fn(),
  collectEditFeedback: vi.fn(async () => ""),
}));

import {
  normalizeModelToolArgs,
  validateToolArgs,
} from "../../src/tools/argument-validation.js";
import { SHARED_READ } from "../../src/tools/concurrency.js";
import {
  prepareModelToolArgs,
  runToolUse,
  validateToolPreflight,
} from "../../src/tools/execution.js";
import { partitionToolCalls } from "../../src/tools/orchestration.js";
import { ToolRouter } from "../../src/tools/router.js";
import { StreamingToolExecutor } from "../../src/tools/streaming-executor.js";
import {
  createFileEditTool,
  createFileMultiEditTool,
} from "../../src/tools/system/file-edit.js";
import {
  clearSessionReadState,
  recordSessionRead,
  SESSION_ID_ARG,
} from "../../src/tools/system/filesystem.js";
import { buildToolRegistry, type ToolRegistry } from "../../src/tool-registry.js";
import { EventLog } from "../../src/session/event-log.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { ToolInvocation } from "../../src/tools/context.js";
import type { PreToolUseHook } from "../../src/tools/hooks.js";
import type { Tool } from "../../src/tools/types.js";

const SESSION_ID = "multi-edit-shape-session";
const EDIT_SHAPE_ERROR =
  "<tool_use_error>InputValidationError: MultiEdit failed due to the following issues:\n" +
  "The required parameter `edits` is missing\n" +
  "An unexpected parameter `old_string` was provided\n" +
  "An unexpected parameter `new_string` was provided</tool_use_error>";

let root = "";

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agenc-multi-edit-shape-")));
});

afterEach(async () => {
  clearSessionReadState(SESSION_ID, tmpdir());
  await rm(root, { recursive: true, force: true });
});

/** Write a file and record a full session read of it, as the model would. */
async function seedReadFile(name: string, content: string): Promise<string> {
  const file = join(root, name);
  await writeFile(file, content, "utf8");
  const fileStats = await stat(file);
  recordSessionRead(SESSION_ID, file, {
    content,
    timestamp: fileStats.mtimeMs,
    viewKind: "full",
  });
  return file;
}

/** The real MultiEdit tool; the session id is what the runtime injects. */
function sessionMultiEdit() {
  const real = createFileMultiEditTool({ allowedPaths: [root] });
  const execute = vi.fn((args: Record<string, unknown>) =>
    real.execute({ ...args, [SESSION_ID_ARG]: SESSION_ID }),
  );
  const tool: Tool = { ...real, execute };
  return { tool, execute };
}

function invocationFor(raw: string, eventLog: EventLog): ToolInvocation {
  return {
    session: {
      eventLog,
      services: {
        admissionRequired: false,
        runtimeOptions: resolveAgentRuntimeOptions({}),
      },
    } as never,
    // The workspace sandbox only admits writes under the turn's cwd.
    turn: { cwd: root } as never,
    tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} },
    callId: "c1",
    toolName: { name: "MultiEdit" },
    payload: { kind: "function", arguments: raw },
    source: "direct",
  };
}

function publicArgs(args: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args as Record<string, unknown>).filter(
      ([key]) => !key.startsWith("__"),
    ),
  );
}

describe("model-entry fold of an Edit-shaped MultiEdit call", () => {
  test("folds exactly file_path, old_string and new_string into one edit", () => {
    const multi = createFileMultiEditTool({ allowedPaths: [root] });
    const input = { file_path: "a.txt", old_string: "alpha", new_string: "beta" };
    const before = JSON.stringify(input);
    expect(
      normalizeModelToolArgs(multi.inputSchema, input, multi.reshapeModelArgs),
    ).toEqual({
      valid: true,
      errors: [],
      args: {
        file_path: "a.txt",
        edits: [{ old_string: "alpha", new_string: "beta" }],
      },
      reshaped: true,
    });
    expect(JSON.stringify(input)).toBe(before);
  });

  test.each([true, false])("keeps an explicit replace_all=%s on the edit", (replaceAll) => {
    const multi = createFileMultiEditTool({ allowedPaths: [root] });
    const input = {
      file_path: "a.txt",
      old_string: "alpha",
      new_string: "beta",
      replace_all: replaceAll,
    };
    expect(
      normalizeModelToolArgs(multi.inputSchema, input, multi.reshapeModelArgs).args,
    ).toEqual({
      file_path: "a.txt",
      edits: [{ old_string: "alpha", new_string: "beta", replace_all: replaceAll }],
    });
  });

  test.each([
    ["an empty edits array", { edits: [] }],
    ["a null edits value", { edits: null }],
    ["an extra cwd key", { cwd: "/tmp" }],
    ["a model-invented key", { description: "rename alpha" }],
    ["a missing file_path", { file_path: undefined }],
    ["a missing old_string", { old_string: undefined }],
    ["a missing new_string", { new_string: undefined }],
    ["a non-string old_string", { old_string: 1 }],
    ["a non-string file_path", { file_path: ["a.txt"] }],
    ["a non-boolean replace_all", { replace_all: "true" }],
  ])("declines %s and keeps the original errors", (_label, change) => {
    const multi = createFileMultiEditTool({ allowedPaths: [root] });
    const input: Record<string, unknown> = {
      file_path: "a.txt",
      old_string: "alpha",
      new_string: "beta",
      ...change,
    };
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) delete input[key];
    }
    const strict = validateToolArgs(multi.inputSchema, input);
    expect(strict.valid).toBe(false);
    expect(
      normalizeModelToolArgs(multi.inputSchema, input, multi.reshapeModelArgs),
    ).toEqual(strict);
  });

  test("only MultiEdit declares the fold; Edit never takes an edits array", () => {
    const edit = createFileEditTool({ allowedPaths: [root] });
    expect(edit.reshapeModelArgs).toBeUndefined();
    const input = {
      file_path: "a.txt",
      edits: [{ old_string: "alpha", new_string: "beta" }],
    };
    expect(
      normalizeModelToolArgs(edit.inputSchema, input, edit.reshapeModelArgs),
    ).toEqual(validateToolArgs(edit.inputSchema, input));
  });

  test("the production registry keeps the fold on MultiEdit and nowhere else", () => {
    const registry = buildToolRegistry({ workspaceRoot: root });
    const reshaping = registry.tools
      .filter((tool) => tool.reshapeModelArgs !== undefined)
      .map((tool) => tool.name);
    expect(reshaping).toEqual(["MultiEdit"]);
  });

  test("the fold replaces only the model's keys on the execution copy", () => {
    const multi = createFileMultiEditTool({ allowedPaths: [root] });
    const args: Record<string, unknown> = {
      file_path: "a.txt",
      old_string: "alpha",
      new_string: "beta",
      [SESSION_ID_ARG]: "s1",
    };
    Object.defineProperty(args, "__callId", {
      value: "c1",
      enumerable: false,
      configurable: true,
    });
    prepareModelToolArgs(multi, args);
    expect(args).toEqual({
      file_path: "a.txt",
      [SESSION_ID_ARG]: "s1",
      edits: [{ old_string: "alpha", new_string: "beta" }],
    });
    expect(Object.getOwnPropertyDescriptor(args, "__callId")?.value).toBe("c1");
  });

  test("a double-encoded edits array is the JSON repair's, never the fold's", () => {
    const multi = createFileMultiEditTool({ allowedPaths: [root] });
    const edits = [{ old_string: "alpha", new_string: "beta" }];
    const input = { file_path: "a.txt", edits: JSON.stringify(edits) };
    expect(
      normalizeModelToolArgs(multi.inputSchema, input, multi.reshapeModelArgs),
    ).toEqual({
      valid: true,
      errors: [],
      args: { file_path: "a.txt", edits },
      coercedPaths: ["edits"],
    });
  });

  test("strict validation and preflight never fold supplied arguments", () => {
    const multi = createFileMultiEditTool({ allowedPaths: [root] });
    const input = { file_path: "a.txt", old_string: "alpha", new_string: "beta" };
    expect(validateToolArgs(multi.inputSchema, input).valid).toBe(false);
    expect(validateToolPreflight(multi, input)?.content).toBe(EDIT_SHAPE_ERROR);
    expect(input).toEqual({ file_path: "a.txt", old_string: "alpha", new_string: "beta" });
  });

  test.each(["execution", "router", "model"] as const)(
    "%s entry executes the folded edit on disk and keeps the model's bytes",
    async (boundary) => {
      const file = await seedReadFile("notes.txt", "alpha one\nalpha two\n");
      const modelArgs = {
        file_path: file,
        old_string: "alpha",
        new_string: "beta",
        replace_all: true,
      };
      const raw = JSON.stringify(modelArgs);
      const eventLog = new EventLog();
      const warnings: unknown[] = [];
      eventLog.subscribe((event) => {
        if (event.msg.type === "warning") warnings.push(event.msg.payload);
      });
      const { tool, execute } = sessionMultiEdit();
      const call = invocationFor(raw, eventLog);
      const hookViews: Array<{ args: unknown; payload: unknown }> = [];
      const preHooks: PreToolUseHook[] = [
        async ({ invocation, args }) => {
          const payload = invocation.payload;
          hookViews.push({
            args: publicArgs(args),
            payload: payload.kind === "function" ? JSON.parse(payload.arguments) : payload,
          });
          return { kind: "continue" };
        },
      ];
      const approvals: unknown[] = [];

      let isError: boolean | undefined;
      if (boundary === "execution") {
        const result = await runToolUse(raw, {
          tool,
          invocation: call,
          currentTurnId: "t1",
          eventLog,
          preHooks,
          approvalResolver: {
            request: async (ctx) => {
              const payload = ctx.invocation.payload;
              approvals.push(payload.kind === "function" ? JSON.parse(payload.arguments) : payload);
              return { kind: "approved" };
            },
          },
        });
        isError = result.isError;
      } else if (boundary === "router") {
        const router = new ToolRouter([{ tool, supportsParallelToolCalls: false }]);
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const result = await router.dispatchToolCall(call, parsed);
        isError = result.isError;
        expect(parsed).toEqual(modelArgs);
      } else {
        const router = new ToolRouter([{ tool, supportsParallelToolCalls: false }]);
        const result = await router.dispatchModelToolCall(
          { id: "c1", name: "MultiEdit", arguments: raw },
          { ...call, approvalPolicy: "never", sandboxMode: "workspace_write", preHooks },
        );
        isError = result.isError;
      }

      const folded = {
        file_path: file,
        edits: [{ old_string: "alpha", new_string: "beta", replace_all: true }],
      };
      expect(isError).not.toBe(true);
      expect(execute).toHaveBeenCalledOnce();
      expect(publicArgs(execute.mock.calls[0]?.[0])).toEqual(folded);
      expect(await readFile(file, "utf8")).toBe("beta one\nbeta two\n");
      if (boundary !== "router") {
        expect(hookViews).toEqual([{ args: folded, payload: folded }]);
      }
      if (boundary === "execution") expect(approvals).toEqual([folded]);
      expect(warnings).toContainEqual({
        cause: "tool_input_reshaped",
        message: JSON.stringify({ tool: "MultiEdit", from: Object.keys(modelArgs), to: ["file_path", "edits"] }),
      });
      // History and provider replay keep exactly what the model sent.
      expect(call.payload).toEqual({ kind: "function", arguments: raw });
    },
  );

  test.each(["execution", "model"] as const)(
    "%s entry: a hook rewrite to the Edit shape is validated strictly and never folded",
    async (boundary) => {
      const file = await seedReadFile("notes.txt", "alpha\n");
      const raw = JSON.stringify({
        file_path: file,
        edits: [{ old_string: "alpha", new_string: "beta" }],
      });
      const eventLog = new EventLog();
      const { tool, execute } = sessionMultiEdit();
      const call = invocationFor(raw, eventLog);
      // A continuing hook that supplies `args` rewrites the call input.
      const preHooks: PreToolUseHook[] = [
        async () => ({
          kind: "continue",
          args: { file_path: file, old_string: "alpha", new_string: "gamma" },
        }),
      ];
      let content: string;
      if (boundary === "execution") {
        const result = await runToolUse(raw, {
          tool,
          invocation: call,
          currentTurnId: "t1",
          eventLog,
          preHooks,
        });
        expect(result.isError).toBe(true);
        content = String(result.content);
      } else {
        const router = new ToolRouter([{ tool, supportsParallelToolCalls: false }]);
        const result = await router.dispatchModelToolCall(
          { id: "c1", name: "MultiEdit", arguments: raw },
          { ...call, approvalPolicy: "never", sandboxMode: "workspace_write", preHooks },
        );
        expect(result.isError).toBe(true);
        content = result.content;
      }
      expect(content).toContain("The required parameter `edits` is missing");
      expect(execute).not.toHaveBeenCalled();
      expect(await readFile(file, "utf8")).toBe("alpha\n");
    },
  );

  test("streaming and batch scheduling classify the folded value", () => {
    const multi = createFileMultiEditTool({ allowedPaths: [root] });
    const isConcurrencySafe = vi.fn((args: Record<string, unknown>) =>
      Array.isArray(args.edits),
    );
    const tool: Tool = { ...multi, concurrencyClass: SHARED_READ, isConcurrencySafe };
    const modelArgs = { file_path: "a.txt", old_string: "alpha", new_string: "beta" };
    const raw = JSON.stringify(modelArgs);
    const registry: ToolRegistry = {
      tools: [tool],
      toLLMTools: () => [],
      dispatch: async () => ({ content: "unused" }),
    };
    const block = { type: "tool_use" as const, id: "c1", name: "MultiEdit", input: JSON.parse(raw) };

    expect(partitionToolCalls([block], registry)[0]?.isConcurrencySafe).toBe(true);
    const executor = new StreamingToolExecutor({
      registry,
      runToolUseFn: async () => ({ content: "unused" }),
    });
    executor.addTool(block, { id: "c1", name: "MultiEdit", arguments: raw });
    const tracked = (executor as unknown as {
      tools: Array<{ classification: { kind: string }; isConcurrencySafe: boolean }>;
    }).tools[0];
    expect(tracked?.classification.kind).toBe("shared_read");
    expect(tracked?.isConcurrencySafe).toBe(true);
    expect(isConcurrencySafe).toHaveBeenCalled();
    expect(isConcurrencySafe.mock.calls.every(([args]) => Array.isArray(args.edits))).toBe(true);
    expect(block.input).toEqual(modelArgs);
  });
});
