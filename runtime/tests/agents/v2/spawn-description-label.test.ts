import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/agents/delegate.js", () => ({ delegate: vi.fn() }));

import { delegate } from "../../../src/agents/delegate.js";
import { createSpawnAgentTool } from "../../../src/agents/v2/spawn.js";
import type { MultiAgentV2Options } from "../../../src/agents/v2/common.js";
import type { AgentStatus } from "../../../src/agents/status.js";
import { AgentRoleCatalog } from "../../../src/agents/role-catalog.js";
import { BehaviorSubject } from "../../../src/utils/behavior-subject.js";
import { backgroundTaskLifecycleForSession } from "../../../src/tasks/index.js";
import { validateToolPreflight } from "../../../src/tools/execution.js";
import { mkSession } from "../../fixtures.js";

// A live deepseek-flash fan-out sent every spawn_agent call with a short
// `description` label, the way Claude Code's Agent tool takes one. The strict
// schema refused all five calls with "An unexpected parameter `description`
// was provided" and the model had to resend them. The label is the spawned
// task's rail title, so spawn_agent accepts it as an optional field.

const mockDelegate = vi.mocked(delegate);
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const { session } = mkSession();
  const id = randomUUID();
  const status = new BehaviorSubject<AgentStatus>({ status: "running", turnId: "initial", startedAtMs: 1 });
  const thread = {
    threadId: id,
    taskPrompt: "build the audio mod",
    live: { agentId: id, agentPath: `/root/mod_audio_${id.replaceAll("-", "")}`, role: { name: "runner" }, status },
    join: () => new Promise<never>(() => {}),
  };
  const roleCatalog = new AgentRoleCatalog(session.roleWorkspace);
  const opts = {
    getSession: () => session,
    workspace: session.roleWorkspace,
    roleCatalog,
    ensureAgentControl: () => ({
      control: { roleWorkspace: session.roleWorkspace, roleCatalog, assertRoleWorkspace: () => {} }, registry: {},
    }),
  } as unknown as MultiAgentV2Options;
  mockDelegate.mockReset();
  mockDelegate.mockResolvedValue({ kind: "async_launched", thread: thread as never });
  return { session, id, status, tool: createSpawnAgentTool(opts) };
}

const LIVE_CALL = {
  task_name: "mod_audio",
  agent_type: "runner",
  description: "Procedural WebAudio SFX + music mod",
  message: "Write game/mods/audio.js implementing Orbital.mods.audio.",
};

describe("spawn_agent description label", () => {
  it("validates the call shape models send, with a description label", () => {
    const { session, status, tool } = fixture();
    try {
      expect(validateToolPreflight(tool, { ...LIVE_CALL })).toBeNull();
    } finally { status.next({ status: "shutdown" }); void session.shutdown(); }
  });

  it("keeps the schema strict for fields it does not define", () => {
    const { session, status, tool } = fixture();
    try {
      const refused = validateToolPreflight(tool, { ...LIVE_CALL, subagent_type: "runner" });
      expect(refused?.content).toContain("An unexpected parameter `subagent_type` was provided");
      const wrongType = validateToolPreflight(tool, { ...LIVE_CALL, description: 42 });
      expect(wrongType?.content).toContain("`description` type is expected as `string`");
    } finally { status.next({ status: "shutdown" }); void session.shutdown(); }
  });

  it("uses the label as the spawned task's rail title", async () => {
    const f = fixture();
    try {
      const result = await f.tool.execute({ ...LIVE_CALL });
      expect(result.isError, result.content).not.toBe(true);
      const task = backgroundTaskLifecycleForSession(f.session).get(f.id);
      expect(task?.description).toBe("Procedural WebAudio SFX + music mod");
    } finally { f.status.next({ status: "shutdown" }); await f.session.shutdown(); }
  });

  it("refuses a non-string description before spawning", async () => {
    const f = fixture();
    try {
      const result = await f.tool.execute({ ...LIVE_CALL, description: ["audio"] });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("description must be a string");
      expect(mockDelegate).not.toHaveBeenCalled();
    } finally { f.status.next({ status: "shutdown" }); await f.session.shutdown(); }
  });
});
