/**
 * NotebookRead and NotebookEdit through the real dispatch path: the
 * ToolRouter with the permission evaluator wired, which validates the call
 * against the tool's schema again after the permission layer returns its
 * `updatedInput` (router.ts approval preflight).
 *
 * Both notebook tools check their path through a `file_path`-shaped helper.
 * Handing that helper's rewritten input back as the tool's own input put
 * `file_path` (and for NotebookRead also `cwd`) into a strict schema, so
 * every call ended in `schema_validation_failed` on the Linux release
 * candidate (sessions conv-mucyq96a and conv-mucys0eb).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SESSION_ALLOWED_ROOTS_ARG,
  SESSION_ALLOWED_ROOTS_SIG_ARG,
  verifyAllowedRoots,
} from "../../src/agents/_deps/filesystem-args.js";
import { createModelFacingTools } from "../../src/bin/model-facing-tools.js";
import {
  attachContextDefaults,
  hasPermissionsToUseTool,
  type ToolEvaluatorContext,
} from "../../src/permissions/evaluator.js";
import {
  createEmptyToolPermissionContext,
  type PermissionMode,
} from "../../src/permissions/types.js";
import { EventLog, type Event } from "../../src/session/event-log.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { Session } from "../../src/session/session.js";
import { runToolUse, validateToolPreflight } from "../../src/tools/execution.js";
import { ToolRouter } from "../../src/tools/router.js";
import { createFileReadTool } from "../../src/tools/system/file-read.js";
import { clearSessionReadState } from "../../src/tools/system/filesystem.js";
import type { Tool } from "../../src/tools/types.js";

const TEST_RUNTIME_OPTIONS = resolveAgentRuntimeOptions({});

/** The notebook from the Linux run, byte for byte. */
const ANALYSIS_NOTEBOOK = JSON.stringify({
  cells: [
    {
      cell_type: "markdown",
      metadata: {},
      source: ["# Analysis\n", "Compute totals."],
    },
    {
      cell_type: "code",
      execution_count: 1,
      metadata: {},
      outputs: [{ name: "stdout", output_type: "stream", text: ["6\n"] }],
      source: ["values = [1, 2, 3]\n", "print(sum(values))"],
    },
  ],
  metadata: {
    kernelspec: {
      display_name: "Python 3",
      language: "python",
      name: "python3",
    },
    language_info: { name: "python" },
  },
  nbformat: 4,
  nbformat_minor: 5,
}) + "\n";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** Every output kind a real notebook carries, with cell ids (nbformat 4.5). */
const REPORT_NOTEBOOK = {
  cells: [
    {
      cell_type: "markdown",
      id: "intro",
      metadata: {},
      source: ["# Report\n", "Totals and a plot."],
    },
    {
      cell_type: "code",
      id: "load",
      execution_count: 1,
      metadata: { tags: ["setup"] },
      outputs: [
        { name: "stdout", output_type: "stream", text: ["loaded 3 rows\n"] },
      ],
      source: ["rows = [1, 2, 3]\n", "print(f'loaded {len(rows)} rows')"],
    },
    {
      cell_type: "code",
      id: "total",
      execution_count: 2,
      metadata: {},
      outputs: [
        {
          data: { "text/plain": ["6"] },
          execution_count: 2,
          metadata: {},
          output_type: "execute_result",
        },
      ],
      source: ["sum(rows)"],
    },
    {
      cell_type: "code",
      id: "plot",
      execution_count: 3,
      metadata: {},
      outputs: [
        {
          data: {
            "image/png": PNG_1PX,
            "text/plain": ["<Figure size 640x480 with 1 Axes>"],
          },
          metadata: {},
          output_type: "display_data",
        },
      ],
      source: ["plot(rows)"],
    },
    {
      cell_type: "code",
      id: "boom",
      execution_count: 4,
      metadata: {},
      outputs: [
        {
          ename: "ZeroDivisionError",
          evalue: "division by zero",
          output_type: "error",
          traceback: [
            "Traceback (most recent call last)",
            "ZeroDivisionError: division by zero",
          ],
        },
      ],
      source: ["1 / 0"],
    },
  ],
  metadata: {
    kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
    language_info: { name: "python", version: "3.12.4" },
  },
  nbformat: 4,
  nbformat_minor: 5,
} as const;

let root = "";
let workspace = "";
let session: Session;
let events: Event[] = [];
let tools: Map<string, Tool>;
let router: ToolRouter;
let approvals: string[] = [];
let serial = 0;

function evaluatorContext(mode: PermissionMode): ToolEvaluatorContext {
  return attachContextDefaults({
    session,
    getAppState: () => ({
      toolPermissionContext: createEmptyToolPermissionContext({ mode }),
    }),
  } as unknown as ToolEvaluatorContext);
}

async function dispatch(
  name: "FileRead" | "NotebookRead" | "NotebookEdit",
  args: Record<string, unknown>,
  mode: PermissionMode,
) {
  const id = `notebook-call-${++serial}`;
  return router.dispatchModelToolCall(
    { id, name, arguments: JSON.stringify(args) },
    {
      session,
      turn: {
        subId: `turn-${id}`,
        cwd: workspace,
        approvalPolicy: { value: "on_request" },
        sandboxPolicy: { value: "workspace_write" },
      } as never,
      tracker: { appendFileDiff() {}, snapshot: () => [], clear() {} } as never,
      approvalPolicy: "on_request",
      sandboxMode: "workspace_write",
      // Default mode asks before a write; the user approves it here.
      approvalResolver: {
        request: async (ctx: { toolName: string }) => {
          approvals.push(ctx.toolName);
          return { kind: "approved" as const };
        },
      },
      canUseTool: hasPermissionsToUseTool,
      permissionContext: evaluatorContext(mode),
    } as never,
  );
}

function schemaFailures(): Event[] {
  return events.filter((event) => {
    const msg = (event as { msg?: { type?: string; payload?: { cause?: string } } }).msg;
    return msg?.type === "error" && msg.payload?.cause === "schema_validation_failed";
  });
}

/** Keys a strict schema would see: everything but the runtime's own `__agenc*` channel. */
function modelVisibleKeys(input: unknown): string[] {
  return Object.keys(input as Record<string, unknown>).filter(
    (key) => !key.startsWith("__agenc"),
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agenc-notebook-dispatch-"));
  workspace = join(root, "workspace");
  await mkdir(workspace);
  events = [];
  approvals = [];
  const eventLog = new EventLog();
  eventLog.subscribe((event) => {
    events.push(event);
  });
  session = {
    conversationId: `notebook-dispatch-${++serial}`,
    eventLog,
    services: { admissionRequired: false, runtimeOptions: TEST_RUNTIME_OPTIONS },
  } as unknown as Session;
  // The daemon registry builds FileRead next to the model-facing tools the
  // same way (tool-registry.ts firstClassFileTools).
  tools = new Map(
    [
      createFileReadTool({ allowedPaths: [workspace] }),
      ...createModelFacingTools({ workspaceRoot: workspace, getSession: () => null }).filter(
        (tool) => tool.name === "NotebookRead" || tool.name === "NotebookEdit",
      ),
    ].map((tool) => [tool.name, tool]),
  );
  router = new ToolRouter(
    [...tools.values()].map((tool) => ({ tool, supportsParallelToolCalls: false })),
  );
});

afterEach(async () => {
  clearSessionReadState(session.conversationId, TEST_RUNTIME_OPTIONS.sessionTempRoot);
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("NotebookRead through the router", () => {
  it.each(["default", "acceptEdits", "bypassPermissions"] as const)(
    "reads the notebook for the exact call from the Linux run (%s)",
    async (mode) => {
      await writeFile(join(workspace, "analysis.ipynb"), ANALYSIS_NOTEBOOK, "utf8");

      const result = await dispatch("NotebookRead", { notebook_path: "analysis.ipynb" }, mode);

      expect(schemaFailures()).toEqual([]);
      expect(result.isError, String(result.content)).toBeFalsy();
      const content = String(result.content);
      expect(content).toContain("Cells: 2");
      expect(content).toContain("Cell 1 [markdown]");
      expect(content).toContain("# Analysis");
      expect(content).toContain("Compute totals.");
      expect(content).toContain("Cell 2 [code] execution_count=1");
      expect(content).toContain("values = [1, 2, 3]");
      expect(content).toContain("print(sum(values))");
      expect(content).toContain("Output 1 [stream]:");
      expect(content).toMatch(/\n\s*\d+→6\n?/u);
    },
  );

  it("reads every output kind by absolute path, and honors offset and limit", async () => {
    const notebookPath = join(workspace, "report.ipynb");
    await writeFile(notebookPath, JSON.stringify(REPORT_NOTEBOOK), "utf8");

    const full = await dispatch("NotebookRead", { notebook_path: notebookPath }, "default");

    expect(schemaFailures()).toEqual([]);
    expect(full.isError, String(full.content)).toBeFalsy();
    const content = String(full.content);
    for (const expected of [
      "Cell 1 [markdown] id=intro",
      "Cell 2 [code] id=load execution_count=1",
      "loaded 3 rows",
      "Cell 3 [code] id=total execution_count=2",
      "Output 1 [execute_result]:",
      "Cell 4 [code] id=plot execution_count=3",
      "Output 1 [display_data]:",
      "<Figure size 640x480 with 1 Axes>",
      "Image output 1 [image/png]: embedded image output",
      "Cell 5 [code] id=boom execution_count=4",
      "Output 1 [error]:",
      "ZeroDivisionError: division by zero",
    ]) {
      expect(content).toContain(expected);
    }

    const slice = await dispatch(
      "NotebookRead",
      { notebook_path: notebookPath, offset: 5, limit: 3 },
      "default",
    );
    expect(schemaFailures()).toEqual([]);
    expect(slice.isError, String(slice.content)).toBeFalsy();
    expect(String(slice.content)).toContain("Cell 1 [markdown] id=intro");
    expect(String(slice.content)).not.toContain("Cell 2 [code]");
  });
});

describe("NotebookEdit through the router", () => {
  it.each(["default", "acceptEdits", "bypassPermissions"] as const)(
    "edits the notebook from the Linux run after the FileRead that session made (%s)",
    async (mode) => {
      const notebookPath = join(workspace, "analysis.ipynb");
      await writeFile(notebookPath, ANALYSIS_NOTEBOOK, "utf8");
      const original = JSON.parse(ANALYSIS_NOTEBOOK);

      // conv-mucys0eb read the notebook with FileRead, then called NotebookEdit.
      const read = await dispatch("FileRead", { file_path: notebookPath }, mode);
      expect(read.isError, String(read.content)).toBeFalsy();
      const edit = await dispatch(
        "NotebookEdit",
        {
          notebook_path: notebookPath,
          cell_id: "1",
          edit_mode: "replace",
          cell_type: "code",
          new_source: "values = [1, 2, 3, 4]\nprint(sum(values))",
        },
        mode,
      );

      expect(schemaFailures()).toEqual([]);
      expect(edit.isError, String(edit.content)).toBeFalsy();
      // Only default mode prompts for the write; the prompt ran and approved it.
      expect(approvals).toEqual(mode === "default" ? ["NotebookEdit"] : []);
      const updated = JSON.parse(await readFile(notebookPath, "utf8"));
      expect(updated.cells).toHaveLength(2);
      expect(updated.cells[0]).toEqual(original.cells[0]);
      expect(updated.cells[1]).toEqual({
        ...original.cells[1],
        source: "values = [1, 2, 3, 4]\nprint(sum(values))",
        // The old output belongs to the old source (Jupyter semantics).
        execution_count: null,
        outputs: [],
      });
      expect(updated.metadata).toEqual(original.metadata);
      expect(updated.nbformat).toBe(4);
      expect(updated.nbformat_minor).toBe(5);
    },
  );

  it("replaces, inserts and deletes cells by id and keeps every other cell and output", async () => {
    const notebookPath = join(workspace, "report.ipynb");
    await writeFile(notebookPath, JSON.stringify(REPORT_NOTEBOOK), "utf8");
    const [intro, load, total, plot, boom] = REPORT_NOTEBOOK.cells;

    const read = await dispatch("NotebookRead", { notebook_path: notebookPath }, "acceptEdits");
    expect(read.isError, String(read.content)).toBeFalsy();

    const replace = await dispatch(
      "NotebookEdit",
      { notebook_path: notebookPath, cell_id: "total", new_source: "sum(rows) * 2" },
      "acceptEdits",
    );
    expect(replace.isError, String(replace.content)).toBeFalsy();
    const insert = await dispatch(
      "NotebookEdit",
      {
        notebook_path: notebookPath,
        cell_id: "intro",
        edit_mode: "insert",
        cell_type: "markdown",
        new_source: "## Inputs",
      },
      "acceptEdits",
    );
    expect(insert.isError, String(insert.content)).toBeFalsy();
    const remove = await dispatch(
      "NotebookEdit",
      { notebook_path: notebookPath, cell_id: "boom", edit_mode: "delete" },
      "acceptEdits",
    );
    expect(remove.isError, String(remove.content)).toBeFalsy();

    expect(schemaFailures()).toEqual([]);
    const updated = JSON.parse(await readFile(notebookPath, "utf8"));
    expect(updated.cells.map((cell: { id?: string }) => cell.id)).toEqual([
      "intro",
      expect.stringMatching(/^agenc-/u),
      "load",
      "total",
      "plot",
    ]);
    expect(updated.cells[0]).toEqual(intro);
    expect(updated.cells[1]).toMatchObject({
      cell_type: "markdown",
      metadata: {},
      source: "## Inputs",
    });
    expect(updated.cells[2]).toEqual(load);
    expect(updated.cells[3]).toEqual({
      ...total,
      source: "sum(rows) * 2",
      execution_count: null,
      outputs: [],
    });
    expect(updated.cells[4]).toEqual(plot);
    expect(updated.cells.some((cell: { id?: string }) => cell.id === boom.id)).toBe(false);
    expect(updated.metadata).toEqual(REPORT_NOTEBOOK.metadata);
  });
});

describe("NotebookRead and NotebookEdit through runToolUse with the evaluator", () => {
  it("reads and then edits when runToolUse arbitrates the permission itself", async () => {
    // runToolUse validates the permission result again before approval, the
    // same way the router does (execution.ts approval preflight).
    const notebookPath = join(workspace, "analysis.ipynb");
    await writeFile(notebookPath, ANALYSIS_NOTEBOOK, "utf8");
    const run = async (name: "NotebookRead" | "NotebookEdit", args: Record<string, unknown>) => {
      const tool = tools.get(name)!;
      const callId = `notebook-run-${++serial}`;
      return runToolUse(JSON.stringify(args), {
        tool,
        currentTurnId: "turn-run-tool-use",
        invocation: {
          session,
          turn: { subId: "turn-run-tool-use", cwd: workspace } as never,
          tracker: { appendFileDiff() {}, snapshot: () => [], clear() {} },
          callId,
          toolName: { name },
          payload: { kind: "function", arguments: JSON.stringify(args) },
          source: "direct",
        },
        eventLog: session.eventLog,
        canUseTool: hasPermissionsToUseTool,
        permissionContext: evaluatorContext("acceptEdits"),
      });
    };

    const read = await run("NotebookRead", { notebook_path: "analysis.ipynb" });
    expect(read.isError, read.content).toBe(false);
    expect(read.content).toContain("values = [1, 2, 3]");
    const edit = await run("NotebookEdit", {
      notebook_path: "analysis.ipynb",
      cell_id: "0",
      new_source: "# Analysis\nCompute the total.",
    });
    expect(edit.isError, edit.content).toBe(false);

    expect(schemaFailures()).toEqual([]);
    const updated = JSON.parse(await readFile(notebookPath, "utf8"));
    const original = JSON.parse(ANALYSIS_NOTEBOOK);
    expect(updated.cells[0]).toEqual({ ...original.cells[0], source: "# Analysis\nCompute the total." });
    expect(updated.cells[1]).toEqual(original.cells[1]);
  });
});

describe("the notebook tools' permission decisions stay inside their own schema", () => {
  it.each([
    ["NotebookRead", "default", "allow", { notebook_path: "analysis.ipynb" }],
    ["NotebookRead", "bypassPermissions", "allow", { notebook_path: "analysis.ipynb", offset: 1, limit: 5 }],
    ["NotebookEdit", "default", "ask", { notebook_path: "analysis.ipynb", cell_id: "1", new_source: "x = 1" }],
    ["NotebookEdit", "acceptEdits", "allow", { notebook_path: "analysis.ipynb", cell_id: "1", new_source: "x = 1" }],
    ["NotebookEdit", "bypassPermissions", "allow", { notebook_path: "analysis.ipynb", edit_mode: "delete", cell_id: "0" }],
  ] as const)("%s in %s mode (%s)", async (name, mode, behavior, input) => {
    await writeFile(join(workspace, "analysis.ipynb"), ANALYSIS_NOTEBOOK, "utf8");
    const tool = tools.get(name)!;

    const decision = await hasPermissionsToUseTool(tool, { ...input }, evaluatorContext(mode));

    expect(decision.behavior).toBe(behavior);
    const updatedInput = (decision as { updatedInput?: Record<string, unknown> }).updatedInput;
    expect(updatedInput).toBeDefined();
    expect(modelVisibleKeys(updatedInput).sort()).toEqual(Object.keys(input).sort());
    expect(validateToolPreflight(tool, updatedInput!)).toBeNull();
  });

  it("NotebookEdit keeps the signed root an approval grants outside the workspace", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    const notebookPath = join(outside, "shared.ipynb");
    await writeFile(notebookPath, ANALYSIS_NOTEBOOK, "utf8");
    const tool = tools.get("NotebookEdit")!;

    const decision = await hasPermissionsToUseTool(
      tool,
      { notebook_path: notebookPath, cell_id: "0", new_source: "# Shared" },
      evaluatorContext("default"),
    );

    expect(decision.behavior).toBe("ask");
    const updatedInput = (decision as { updatedInput?: Record<string, unknown> }).updatedInput!;
    expect(modelVisibleKeys(updatedInput).sort()).toEqual(["cell_id", "new_source", "notebook_path"]);
    expect(
      verifyAllowedRoots(
        updatedInput[SESSION_ALLOWED_ROOTS_ARG],
        updatedInput[SESSION_ALLOWED_ROOTS_SIG_ARG],
      ),
    ).toContain(dirname(notebookPath));
    expect(validateToolPreflight(tool, updatedInput)).toBeNull();
  });
});

describe("NotebookEdit under the full bypass", () => {
  it("edits a notebook outside the workspace, where no evaluator runs", async () => {
    // --dangerously-bypass-approvals-and-sandbox: bypassPermissions with no
    // sandbox. The dispatcher, not a prompt, hands the file tool its root.
    const outside = join(root, "outside");
    await mkdir(outside);
    const notebookPath = join(outside, "shared.ipynb");
    await writeFile(notebookPath, ANALYSIS_NOTEBOOK, "utf8");
    Object.assign(session as object, {
      permissionModeRegistry: {
        current: () => ({ mode: "bypassPermissions", additionalWorkingDirectories: new Map() }),
      },
    });
    const call = async (name: "FileRead" | "NotebookEdit", args: Record<string, unknown>) => {
      const id = `notebook-bypass-${++serial}`;
      return router.dispatchModelToolCall(
        { id, name, arguments: JSON.stringify(args) },
        {
          session,
          turn: {
            subId: `turn-${id}`,
            cwd: workspace,
            approvalPolicy: { value: "never" },
            sandboxPolicy: { value: "danger_full_access" },
          } as never,
          tracker: { appendFileDiff() {}, snapshot: () => [], clear() {} } as never,
          approvalPolicy: "never",
          sandboxMode: "danger_full_access",
        } as never,
      );
    };

    const read = await call("FileRead", { file_path: notebookPath });
    expect(read.isError, String(read.content)).toBeFalsy();
    const edit = await call("NotebookEdit", {
      notebook_path: notebookPath,
      cell_id: "0",
      new_source: "# Shared analysis",
    });

    expect(edit.isError, String(edit.content)).toBeFalsy();
    const updated = JSON.parse(await readFile(notebookPath, "utf8"));
    expect(updated.cells[0].source).toBe("# Shared analysis");
    expect(updated.cells[1]).toEqual(JSON.parse(ANALYSIS_NOTEBOOK).cells[1]);
  });
});
