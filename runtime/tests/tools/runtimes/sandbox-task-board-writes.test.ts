import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tasksDir } from "../../../src/bin/task-store.js";
import { resolveHomeContext } from "../../../src/config/home.js";
import { EventLog } from "../../../src/session/event-log.js";
import { ToolRouter } from "../../../src/tools/router.js";
import { enforceRuntimeSandboxAttempt } from "../../../src/tools/runtimes/sandboxing.js";
import { createFileWriteTool } from "../../../src/tools/system/file-write.js";
import { createTaskBoardTools } from "../../../src/tools/tasks/index.js";
import type { Tool, ToolResult } from "../../../src/tools/types.js";

/**
 * The durable task board (TaskCreate, TaskUpdate) writes its store under the
 * AgenC home, `<agenc-home>/projects/<slug>/tasks`, never under a path the
 * model names. The runtime sandbox saw a mutating tool with no path argument,
 * called its write targets unverifiable and refused every call under the
 * default workspace_write sandbox: "sandbox workspace_write could not verify
 * write targets for TaskCreate". The board was unusable in a default session
 * (job tg, 4 of 4 live cells).
 */
let root: string;
let cwd: string;
let home: string;
let sessionTempRoot: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agenc-sandbox-task-board-")));
  cwd = join(root, "project");
  home = join(root, "home");
  sessionTempRoot = join(root, "session-tmp");
  mkdirSync(cwd);
  mkdirSync(home);
  mkdirSync(sessionTempRoot);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Session services; `boundHome: null` leaves the session without a ConfigStore. */
function boundServices(boundHome: string | null) {
  return {
    admissionRequired: false,
    runtimeOptions: { sessionTempRoot },
    ...(boundHome === null
      ? {}
      : {
          configStore: {
            homeContext: resolveHomeContext(
              { AGENC_HOME: boundHome, HOME: boundHome },
              { platformHome: boundHome },
            ),
          },
        }),
  };
}

function boardTools(): Map<string, Tool> {
  const tools = createTaskBoardTools({ workspaceRoot: cwd, agencHome: home, getSession: () => null });
  return new Map(tools.map((tool) => [tool.name, tool] as const));
}

function tracker() {
  return { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} };
}

function dispatcher(sandboxMode: "workspace_write" | "read_only") {
  const router = new ToolRouter([...boardTools().values()].map((tool) => ({
    tool,
    supportsParallelToolCalls: false,
  })));
  const session = {
    conversationId: "task-board-sandbox-session",
    eventLog: new EventLog(),
    services: boundServices(home),
  } as never;
  let call = 0;
  return (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    call += 1;
    return router.dispatchModelToolCall(
      { id: `call-task-board-${call}`, name, arguments: JSON.stringify(args) },
      {
        session,
        turn: {
          subId: `turn-task-board-${call}`,
          cwd,
          approvalPolicy: { value: "never" },
          sandboxPolicy: { value: sandboxMode },
        } as never,
        tracker: tracker() as never,
        approvalPolicy: "never",
        sandboxMode,
      },
    );
  };
}

/** One runtime sandbox decision for `tool` with `args`, as the executor makes it. */
function attempt(
  tool: Tool,
  args: Record<string, unknown>,
  options: {
    readonly sandboxMode?: "workspace_write" | "read_only";
    readonly boundHome?: string | null;
    readonly denyWrite?: readonly string[];
  } = {},
): () => void {
  const sandboxMode = options.sandboxMode ?? "workspace_write";
  const turn = {
    cwd,
    ...(options.denyWrite === undefined
      ? {}
      : {
          fileSystemSandboxPolicy: {
            allowWrite: [cwd],
            denyWrite: options.denyWrite,
            allowRead: [],
            denyRead: [],
          },
        }),
  };
  return () =>
    enforceRuntimeSandboxAttempt({
      tool,
      args,
      context: {
        callId: "task-board-sandbox", toolName: tool.name, runtimeKind: "function",
        classification: { kind: "exclusive" }, supportsParallelToolCalls: false,
        source: "direct", submittedAtMs: 0, approvalPolicy: "never",
        requestedSandboxMode: sandboxMode, sandboxMode,
        approvalResolved: false, rawArgs: "{}",
        invocation: {
          session: {
            conversationId: "task-board-sandbox-session",
            services: boundServices(options.boundHome === undefined ? home : options.boundHome),
          },
          turn,
          tracker: tracker(),
          callId: "task-board-sandbox", toolName: { name: tool.name },
          payload: { kind: "function", arguments: "{}" }, source: "direct",
        },
      } as never,
    });
}

function stub(name: string, metadata: Tool["metadata"]): Tool {
  return {
    name,
    description: "",
    inputSchema: { type: "object" },
    metadata,
    execute: async () => ({ content: "not reached" }),
  };
}

describe("task board writes under the runtime sandbox", () => {
  it("creates, updates and deletes durable tasks under the default workspace_write sandbox", async () => {
    const dispatch = dispatcher("workspace_write");
    const store = tasksDir({ workspaceRoot: cwd, agencHome: home });

    const created = await dispatch("TaskCreate", { subject: "Prepare release notes" });
    expect(created.content).not.toMatch(/could not verify write targets/);
    expect(created.isError).toBeFalsy();
    expect(created.content).toBe("Task #1 created successfully: Prepare release notes");
    expect(existsSync(join(store, "1.json"))).toBe(true);

    const started = await dispatch("TaskUpdate", { taskId: "1", status: "in_progress" });
    expect(started.isError).toBeFalsy();
    expect(started.content).toBe("Updated task #1 status");

    const listed = await dispatch("TaskList", {});
    expect(listed.isError).toBeFalsy();
    expect(listed.content).toBe("#1 [in_progress] Prepare release notes");

    const deleted = await dispatch("TaskUpdate", { taskId: "1", status: "deleted" });
    expect(deleted.isError).toBeFalsy();
    expect(deleted.content).toBe("Deleted task #1");
    expect(existsSync(join(store, "1.json"))).toBe(false);

    // The board never touched the workspace.
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("keeps the read_only sandbox refusing task board writes", async () => {
    const dispatch = dispatcher("read_only");
    const store = tasksDir({ workspaceRoot: cwd, agencHome: home });

    const created = await dispatch("TaskCreate", { subject: "Prepare release notes" });
    expect(created.isError).toBe(true);
    expect(created.content).toMatch(/read_only/);
    expect(existsSync(store)).toBe(false);

    const listed = await dispatch("TaskList", {});
    expect(listed.isError).toBeFalsy();
    expect(listed.content).toBe("No tasks found");
  });

  it.each([
    ["TaskCreate", { subject: "x" }],
    ["TaskUpdate", { taskId: "1", status: "completed" }],
  ] as const)("admits %s under workspace_write by verifying the store it declares", (name, args) => {
    const tool = boardTools().get(name)!;
    expect(attempt(tool, args)).not.toThrow();
    // Verified, not exempted: the declared target is exactly the store.
    expect(tool.metadata?.virtualNoFsWrites).not.toBe(true);
    expect(tool.metadata?.fixedWriteTargets?.())
      .toEqual([tasksDir({ workspaceRoot: cwd, agencHome: home })]);
    expect(attempt(tool, args, { sandboxMode: "read_only" }))
      .toThrow(new RegExp(`read_only blocked write-capable operation ${name}`));
  });

  it("leaves the read-only board tools untouched", () => {
    const tools = boardTools();
    for (const name of ["TaskGet", "TaskList"]) {
      expect(tools.get(name)!.isReadOnly, name).toBe(true);
      expect(tools.get(name)!.metadata?.fixedWriteTargets, name).toBeUndefined();
      expect(attempt(tools.get(name)!, {}, { sandboxMode: "read_only" }), name).not.toThrow();
    }
  });

  it("honors an operator deny over the AgenC home and requires the session's bound home", () => {
    const create = boardTools().get("TaskCreate")!;
    expect(attempt(create, { subject: "x" }, { denyWrite: [home] }))
      .toThrow(/blocked write outside workspace/);
    expect(attempt(create, { subject: "x" }, { denyWrite: [join(home, "projects")] }))
      .toThrow(/blocked write outside workspace/);
    // Without the session's bound AgenC home there is no authority to admit
    // a write outside the workspace.
    expect(attempt(create, { subject: "x" }, { boundHome: null }))
      .toThrow(/blocked write outside workspace/);
    // A session bound to another AgenC home does not admit this store.
    const otherHome = join(root, "other-home");
    mkdirSync(otherHome);
    expect(attempt(create, { subject: "x" }, { boundHome: otherHome }))
      .toThrow(/blocked write outside workspace/);
  });

  it("never extends the store admission to model-directed or other declared paths", () => {
    const store = tasksDir({ workspaceRoot: cwd, agencHome: home });
    const slugDir = join(store, "..");

    // A file tool aimed at the store by the model stays outside the workspace.
    const write = createFileWriteTool({ allowedPaths: [cwd] });
    expect(attempt(write, { file_path: join(store, "1.json"), content: "{}" }))
      .toThrow(/blocked write outside workspace/);

    // So does a shell redirect into it.
    const shell = { ...write, name: "system.bash" } as unknown as Tool;
    expect(attempt(shell, { command: `printf x > ${join(store, "1.json")}` })).toThrow(/blocked/);

    // A declared target is admitted only when it is a project task store.
    for (const target of [
      join(home, "config.toml"),
      join(home, "projects"),
      slugDir,
      join(slugDir, "memory"),
      join(store, "nested"),
      join(home, "tasks"),
      join(root, "elsewhere", ".agenc", "projects", "x", "tasks"),
    ]) {
      expect(
        attempt(stub("Declared", { mutating: true, fixedWriteTargets: () => [target] }), {}),
        target,
      ).toThrow(/blocked write outside workspace/);
    }
  });
});
