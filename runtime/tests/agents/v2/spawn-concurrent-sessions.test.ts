import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/agents/delegate.js", () => ({ delegate: vi.fn() }));

import { delegate } from "../../../src/agents/delegate.js";
import { createSpawnAgentTool } from "../../../src/agents/v2/spawn.js";
import type { MultiAgentV2Options } from "../../../src/agents/v2/common.js";
import type { AgentStatus } from "../../../src/agents/status.js";
import { AgentRoleCatalog } from "../../../src/agents/role-catalog.js";
import { runAdmittedToolCall } from "../../../src/budget/admitted-tool-call.js";
import type { Session } from "../../../src/session/session.js";
import { createTaskTools } from "../../../src/tools/tasks/index.js";
import type { Tool } from "../../../src/tools/types.js";
import { BehaviorSubject } from "../../../src/utils/behavior-subject.js";
import { bindAdmittedToolHarness } from "../../helpers/admitted-tool-harness.js";
import { mkSession } from "../../fixtures.js";

const mockDelegate = vi.mocked(delegate);
const TASK_NAME = "count_js_lines";

interface RootSession {
  readonly session: Session;
  readonly threadId: string;
  readonly status: BehaviorSubject<AgentStatus>;
  readonly abortController: AbortController;
  readonly thread: unknown;
  readonly spawn: Tool;
  readonly tools: ReadonlyMap<string, Tool>;
  readonly dispatch: (tool: Tool, callId: string, args: Record<string, unknown>) => ReturnType<typeof runAdmittedToolCall>;
  readonly unknownOutcomes: () => number;
}

const opened: RootSession[] = [];
afterEach(async () => {
  for (const root of opened.splice(0)) {
    root.status.next({ status: "shutdown" });
    if (!root.session.isShuttingDown) await root.session.shutdown();
  }
  mockDelegate.mockReset();
});

/** One daemon conversation: its own Session, effect journal, and sub-agent. */
function rootSession(label: string): RootSession {
  const { session } = mkSession();
  const threadId = randomUUID();
  const abortController = new AbortController();
  const status = new BehaviorSubject<AgentStatus>({ status: "running", turnId: "initial", startedAtMs: 1 });
  const thread = {
    threadId,
    taskPrompt: `count the JavaScript lines for ${label}`,
    live: {
      agentId: threadId, agentPath: `/root/${TASK_NAME}`, role: { name: "default" }, status, abortController,
    },
    join: () => new Promise<never>(() => {}),
  };
  const options = {
    getSession: () => session,
    workspace: session.roleWorkspace,
    roleCatalog: new AgentRoleCatalog(session.roleWorkspace),
    ensureAgentControl: () => ({
      control: { roleWorkspace: session.roleWorkspace, assertRoleWorkspace: () => {} }, registry: {},
    }),
  } as unknown as MultiAgentV2Options;
  const harness = bindAdmittedToolHarness({ workspaceRoot: process.cwd(), label });
  const root: RootSession = {
    session, threadId, status, abortController, thread,
    spawn: createSpawnAgentTool(options),
    tools: new Map(createTaskTools({ workspaceRoot: process.cwd(), getSession: () => session })
      .map((tool) => [tool.name, tool])),
    dispatch: (tool, callId, args) => runAdmittedToolCall({
      session: harness.session, tool, args, turnId: `turn-${label}`, callId,
      invoke: async ({ crossEffectBoundary }) => { crossEffectBoundary(); return tool.execute(args); },
    }),
    unknownOutcomes: () => harness.events.filter((event) => event.msg.type === "effect_unknown_outcome").length,
  };
  opened.push(root);
  return root;
}

// Live load test (luna-mac F1): 7 of 31 spawn_agent calls failed 67 to 91 ms
// after collab_agent_spawn_begin with "task <uuid> not found" whenever another
// session had already used the same task_name, and each failure locked its
// session behind /resolve.
describe("spawn_agent across concurrent root sessions", () => {
  it("lets two sessions spawn the same task name without interfering", async () => {
    const first = rootSession("spawn-same-name-a");
    const second = rootSession("spawn-same-name-b");
    const threads = new Map<unknown, unknown>([[first.session, first.thread], [second.session, second.thread]]);
    mockDelegate.mockImplementation(async (request) => ({
      kind: "async_launched", thread: threads.get(request.parent) as never,
    }));
    const spawnArgs = { message: "count the JavaScript lines", task_name: TASK_NAME };

    const results = await Promise.all([
      first.dispatch(first.spawn, "spawn-a", spawnArgs),
      second.dispatch(second.spawn, "spawn-b", spawnArgs),
    ]);
    for (const result of results) {
      expect(result.isError, String(result.content)).not.toBe(true);
      expect(JSON.parse(String(result.content))).toMatchObject({ task_name: `/root/${TASK_NAME}` });
    }
    expect(first.unknownOutcomes() + second.unknownOutcomes()).toBe(0);

    // The shared name resolves to each session's own agent, and neither
    // session can read the other's agent even by its id.
    for (const [own, other] of [[first, second], [second, first]] as const) {
      const output = await own.tools.get("TaskOutput")!.execute({ task_id: `/root/${TASK_NAME}`, block: false });
      expect(output.content).toContain(`<task_id>${own.threadId}</task_id>`);
      const foreign = await own.tools.get("TaskOutput")!.execute({ task_id: other.threadId, block: false });
      expect(foreign.isError).toBe(true);
    }

    // A later side-effecting call still runs, and stops only its own agent.
    const stopped = await second.dispatch(second.tools.get("TaskStop")!, "stop-b", { task_id: `/root/${TASK_NAME}` });
    expect(stopped.isError, String(stopped.content)).toBeUndefined();
    expect(second.abortController.signal.aborted).toBe(true);
    expect(first.abortController.signal.aborted).toBe(false);
  });
});
