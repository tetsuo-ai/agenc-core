/**
 * An approval grants the directory the permission check resolved before the
 * prompt. The dispatcher used to sign the directory named by the path text
 * after the prompt instead, and the tool's confinement resolves signed roots
 * through symlinks again at execution. A symlink retargeted while the prompt
 * was open therefore carried an approved write into a directory nobody
 * approved (Codex review of 9ce6a597e, for NotebookEdit, Edit and Write).
 *
 * Every case runs through a real dispatcher with the real permission
 * evaluator in default mode, where a path outside the workspace asks. The
 * approval resolver moves the symlink from `a` to `b` before it approves.
 */
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createModelFacingTools } from "../../src/bin/model-facing-tools.js";
import {
  attachContextDefaults,
  hasPermissionsToUseTool,
  type ToolEvaluatorContext,
} from "../../src/permissions/evaluator.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { StreamingToolExecutor } from "../../src/phases/_deps/tool-runtime.js";
import { EventLog } from "../../src/session/event-log.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import type { Session } from "../../src/session/session.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { ToolRouter } from "../../src/tools/router.js";
import { createFileEditTool } from "../../src/tools/system/file-edit.js";
import { createFileReadTool } from "../../src/tools/system/file-read.js";
import { createFileWriteTool } from "../../src/tools/system/file-write.js";
import { clearSessionReadState } from "../../src/tools/system/filesystem.js";
import type { Tool } from "../../src/tools/types.js";

const RUNTIME_OPTIONS = resolveAgentRuntimeOptions({});

type Route = "router" | "phases";
type ToolName = "FileRead" | "Edit" | "Write" | "NotebookEdit";

let root = "";
let workspace = "";
let dirA = "";
let dirB = "";
let link = "";
let session: Session;
let tools: Map<string, Tool>;
let approvals: string[] = [];
let retargetOnApprovalOf: ToolName | undefined;
let serial = 0;

function notebook(title: string): string {
  return `${JSON.stringify({
    cells: [
      { cell_type: "markdown", id: "title", metadata: {}, source: [title] },
    ],
    metadata: { language_info: { name: "python" } },
    nbformat: 4,
    nbformat_minor: 5,
  })}\n`;
}

/** Point `outside/link` at `b` in one step, the way a racing process would. */
async function retargetLinkToB(): Promise<void> {
  const replacement = `${link}.next`;
  await symlink(dirB, replacement);
  await rename(replacement, link);
}

function permissionContext(): ToolEvaluatorContext {
  return attachContextDefaults({
    session,
    getAppState: () => ({
      toolPermissionContext: createEmptyToolPermissionContext({ mode: "default" }),
    }),
  } as unknown as ToolEvaluatorContext);
}

const approvalResolver = {
  request: async (ctx: { toolName: string }) => {
    approvals.push(ctx.toolName);
    if (ctx.toolName === retargetOnApprovalOf) await retargetLinkToB();
    return { kind: "approved" as const };
  },
};

async function dispatch(
  route: Route,
  name: ToolName,
  args: Record<string, unknown>,
): Promise<{ readonly isError?: boolean; readonly content: unknown }> {
  const id = `retarget-${++serial}`;
  const turn = {
    subId: `turn-${id}`,
    cwd: workspace,
    approvalPolicy: { value: "on_request" },
    sandboxPolicy: { value: "workspace_write" },
  };
  const tracker = { appendFileDiff() {}, snapshot: () => [], clear() {} };
  if (route === "router") {
    const router = new ToolRouter(
      [...tools.values()].map((tool) => ({ tool, supportsParallelToolCalls: false })),
    );
    return router.dispatchModelToolCall(
      { id, name, arguments: JSON.stringify(args) },
      {
        session,
        turn,
        tracker,
        approvalPolicy: "on_request",
        sandboxMode: "workspace_write",
        approvalResolver,
        canUseTool: hasPermissionsToUseTool,
        permissionContext: permissionContext(),
      } as never,
    );
  }
  // The phases executor's own dispatch path (no live router attached).
  const tool = tools.get(name)!;
  const registry: ToolRegistry = {
    tools: [tool],
    toLLMTools: () => [],
    dispatch: async (call) => tool.execute(JSON.parse(call.arguments)),
  };
  const executor = new StreamingToolExecutor({
    registry,
    liveToolDispatch: {
      router: { registry },
      options: {
        session,
        turn,
        approvalPolicy: "on_request",
        sandboxMode: "workspace_write",
        canUseTool: hasPermissionsToUseTool,
        permissionContext: permissionContext(),
        approvalResolver,
      },
    },
  } as never);
  executor.addTool({}, { id, name, arguments: JSON.stringify(args) });
  executor.close();
  const results = [];
  for await (const result of executor.getRemainingResults()) results.push(result.result);
  expect(results).toHaveLength(1);
  return results[0]! as { readonly isError?: boolean; readonly content: unknown };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agenc-approval-retarget-"));
  workspace = join(root, "workspace");
  const outside = join(root, "outside");
  dirA = join(outside, "a");
  dirB = join(outside, "b");
  link = join(outside, "link");
  await mkdir(workspace, { recursive: true });
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });
  await symlink(dirA, link);
  approvals = [];
  retargetOnApprovalOf = undefined;
  session = {
    conversationId: `approval-retarget-${++serial}`,
    eventLog: new EventLog(),
    services: { admissionRequired: false, runtimeOptions: RUNTIME_OPTIONS },
  } as unknown as Session;
  tools = new Map(
    [
      createFileReadTool({ allowedPaths: [workspace] }),
      createFileEditTool({ allowedPaths: [workspace] }),
      createFileWriteTool({ allowedPaths: [workspace] }),
      ...createModelFacingTools({ workspaceRoot: workspace, getSession: () => null }).filter(
        (tool) => tool.name === "NotebookEdit",
      ),
    ].map((tool) => [tool.name, tool]),
  );
});

afterEach(async () => {
  clearSessionReadState(session.conversationId, RUNTIME_OPTIONS.sessionTempRoot);
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

const refusal = /outside allowed directories/u;

describe.skipIf(process.platform === "win32")(
  "an approved write through a symlink retargeted during the prompt",
  () => {
    it.each(["router", "phases"] as const)(
      "NotebookEdit edits the approved notebook, then stays out of the directory the link moved to (%s)",
      async (route) => {
        await writeFile(join(dirA, "shared.ipynb"), notebook("# A"), "utf8");
        await writeFile(join(dirB, "shared.ipynb"), notebook("# B"), "utf8");
        // The session has read both notebooks, so only the grant stands
        // between the edit and `b`.
        expect((await dispatch(route, "FileRead", { file_path: join(dirB, "shared.ipynb") })).isError).toBeFalsy();
        expect((await dispatch(route, "FileRead", { file_path: join(link, "shared.ipynb") })).isError).toBeFalsy();
        const approved = await dispatch(route, "NotebookEdit", {
          notebook_path: join(link, "shared.ipynb"),
          cell_id: "title",
          new_source: "# A edited",
        });
        expect(approved.isError, String(approved.content)).toBeFalsy();
        retargetOnApprovalOf = "NotebookEdit";

        const moved = await dispatch(route, "NotebookEdit", {
          notebook_path: join(link, "shared.ipynb"),
          cell_id: "title",
          new_source: "# Edited after the link moved",
        });

        expect(approvals).toEqual(["FileRead", "FileRead", "NotebookEdit", "NotebookEdit"]);
        expect(moved.isError, String(moved.content)).toBe(true);
        expect(String(moved.content)).toMatch(refusal);
        const inA = JSON.parse(await readFile(join(dirA, "shared.ipynb"), "utf8"));
        expect(inA.cells[0].source).toBe("# A edited");
        await expect(readFile(join(dirB, "shared.ipynb"), "utf8")).resolves.toBe(notebook("# B"));
      },
    );

    it.each(["router", "phases"] as const)(
      "Edit edits the approved file, then stays out of the directory the link moved to (%s)",
      async (route) => {
        await writeFile(join(dirA, "notes.txt"), "from a\nshared line\n", "utf8");
        await writeFile(join(dirB, "notes.txt"), "from b\nshared line\n", "utf8");
        expect((await dispatch(route, "FileRead", { file_path: join(dirB, "notes.txt") })).isError).toBeFalsy();
        expect((await dispatch(route, "FileRead", { file_path: join(link, "notes.txt") })).isError).toBeFalsy();
        const approved = await dispatch(route, "Edit", {
          file_path: join(link, "notes.txt"),
          old_string: "from a",
          new_string: "from a, edited",
        });
        expect(approved.isError, String(approved.content)).toBeFalsy();
        retargetOnApprovalOf = "Edit";

        const moved = await dispatch(route, "Edit", {
          file_path: join(link, "notes.txt"),
          old_string: "shared line",
          new_string: "edited after the link moved",
        });

        expect(approvals).toEqual(["FileRead", "FileRead", "Edit", "Edit"]);
        expect(moved.isError, String(moved.content)).toBe(true);
        expect(String(moved.content)).toMatch(refusal);
        await expect(readFile(join(dirA, "notes.txt"), "utf8")).resolves.toBe("from a, edited\nshared line\n");
        await expect(readFile(join(dirB, "notes.txt"), "utf8")).resolves.toBe("from b\nshared line\n");
      },
    );

    it.each(["router", "phases"] as const)(
      "Write creates the approved file, then does not create one where the link moved to (%s)",
      async (route) => {
        const approved = await dispatch(route, "Write", {
          file_path: join(link, "first.txt"),
          content: "first\n",
        });
        expect(approved.isError, String(approved.content)).toBeFalsy();
        retargetOnApprovalOf = "Write";

        const moved = await dispatch(route, "Write", {
          file_path: join(link, "created.txt"),
          content: "created\n",
        });

        expect(approvals).toEqual(["Write", "Write"]);
        expect(moved.isError, String(moved.content)).toBe(true);
        expect(String(moved.content)).toMatch(refusal);
        await expect(readFile(join(dirA, "first.txt"), "utf8")).resolves.toBe("first\n");
        expect(existsSync(join(dirA, "created.txt"))).toBe(false);
        expect(existsSync(join(dirB, "created.txt"))).toBe(false);
      },
    );
  },
);
