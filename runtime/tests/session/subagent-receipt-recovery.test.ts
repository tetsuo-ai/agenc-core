import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AgentControl } from "../../src/agents/control.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { createAgentRoleWorkspace } from "../../src/agents/role.js";
import { childTerminalOutcome } from "../../src/agents/child-terminal.js";
import { bindLiveAgentSession } from "../../src/agents/live-session.js";
import { createWaitAgentTool } from "../../src/agents/v2/wait.js";
import { createListAgentsTool } from "../../src/agents/v2/list-agents.js";
import type { MultiAgentV2Options } from "../../src/agents/v2/common.js";
import type { Session } from "../../src/session/session.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import type { Event, SubagentTurnOutcomeEvent } from "../../src/session/event-log.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";
import { upsertAgentRun } from "../../src/state/agent-runs.js";

let temporary = "";
let agencHome = "";
let cwd = "";
const stores = new Set<RolloutStore>();

beforeEach(() => {
  temporary = mkdtempSync(join(realpathSync(tmpdir()), "xprov-receipts-"));
  agencHome = join(temporary, "home");
  cwd = join(temporary, "project");
});
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  rmSync(temporary, { recursive: true, force: true });
});

function open(id: string, directory = cwd, resume = false): RolloutStore {
  const store = new RolloutStore({ cwd: directory, sessionId: id, agencHome,
    agencVersion: "0.2.0", sessionTempRoot: temporary, ...(resume ? { resume } : {}) });
  store.open({ sessionId: id, timestamp: "2026-09-29T00:00:00Z", cwd: directory,
    originator: "recovery-test", agencVersion: "0.2.0", model: "parent-model", modelProvider: "groq" });
  stores.add(store);
  return store;
}
function close(store: RolloutStore): void { store.close(); stores.delete(store); }

function edge(parent: RolloutStore, childId: string, agentPath = `/root/${childId}`,
  parentId = "parent", parentPath = "/root"): void {
  const driver = openStateDatabases({ cwd, agencHome });
  try {
    upsertAgentRun(driver, { id: parentId, objective: "test", status: "running",
      startedAt: "2026-09-29T00:00:00Z", lastActiveAt: "2026-09-29T00:00:00Z" });
  } finally { driver.close(); }
  parent.createThreadSpawnEdge({ childThreadId: childId, parentThreadId: parentId, parentPath,
    status: "open", metadata: { agentId: childId, agentPath, agentNickname: childId,
      agentRole: "default", depth: agentPath.split("/").length - 2, lastTaskMessage: "Review code" } });
}

function appendReceipt(store: RolloutStore, sequence = 1,
  overrides: Partial<SubagentTurnOutcomeEvent> = {}): SubagentTurnOutcomeEvent {
  const receipt: SubagentTurnOutcomeEvent = { agentId: store.sessionId, agentPath: `/root/${store.sessionId}`,
    turnId: `turn-${sequence}`, taskId: `task-${sequence}`, outcome: "completed", toolCallCount: 2,
    message: `review result ${sequence}`, terminal: childTerminalOutcome({ provider: "deepseek",
      model: "deepseek-v4-flash", reason: "completed", dispatch: "sent", completedWork: `review result ${sequence}` }),
    ...overrides };
  store.append({ id: `event-${sequence}`, eventId: `event-${sequence}`, seq: sequence,
    msg: { type: "subagent_turn_outcome", payload: receipt } }, { durable: true });
  return receipt;
}

function controlFixture(store: RolloutStore) {
  const prepareChild = vi.fn();
  const waitForMailboxChange = vi.fn(async () => false);
  const workspace = createAgentRoleWorkspace(cwd);
  const session = { conversationId: "parent", rolloutStore: store, roleWorkspace: workspace,
    sessionConfiguration: { cwd }, childInboxes: new Map(), services: { admissionRequired: false },
    providerService: { prepareChild }, eventLog: { emit: vi.fn() }, emit: vi.fn(),
    nextInternalSubId: () => "event-parent", abortController: new AbortController(),
    activeTurn: { unsafePeek: () => ({ turnId: "root-turn" }) }, waitForMailboxChange,
    drainPendingInputMessages: () => [] } as unknown as Session;
  const registry = new AgentRegistry();
  const control = new AgentControl({ session, registry });
  control.registerSessionRoot("parent");
  const options: MultiAgentV2Options = { workspace, getSession: () => session,
    ensureAgentControl: () => ({ registry, control }) };
  return { control, registry, session, prepareChild, waitForMailboxChange,
    wait: createWaitAgentTool(options), list: createListAgentsTool(options) };
}

async function durableIdleWorker(parent: RolloutStore) {
  const state = controlFixture(parent);
  const live = await state.control.spawn({ parentPath: "/root", roleName: "default", agentName: "reusable" });
  const store = open(live.agentId);
  let sequence = 0;
  const session = { conversationId: live.agentId, rolloutStore: store, abortController: new AbortController(),
    providerService: { current: () => ({ provider: "deepseek", model: "deepseek-v4-flash" }) },
    onBeforeDurableClose: () => () => {}, nextInternalSubId: () => `child-event-${sequence + 1}`,
    emit: (event: Event) => {
      const stamped = { ...event, eventId: event.id, seq: ++sequence };
      if (!store.append(stamped, { durable: true })) throw new Error("Child admission was not durably committed.");
      return stamped;
    } } as unknown as Session;
  const revoke = bindLiveAgentSession(live, session);
  live.status.markIdle("old-task");
  return { ...state, live, childStore: store, childSession: session, revoke,
    assign: () => state.control.assignTask(live.agentId, { author: "/root", recipient: live.agentPath,
      content: "Implement the new validation rule", taskId: "new-task" }) };
}

describe("durable child results after daemon restart", () => {
  test("recovers an initial task admitted by spawn before child journal construction", async () => {
    const parent = open("parent");
    const state = controlFixture(parent);
    const live = await state.control.spawn({ parentPath: "/root", agentName: "initial",
      initialTask: { taskId: "initial-task", text: "Review the patch", provider: "deepseek", model: "deepseek-v4-flash" } });
    const admitted = parent.getThreadSpawnEdge(live.agentId)!.metadata.initialTaskAdmission!;
    expect(admitted.taskText).toBe("Review the patch");
    close(parent);
    const restored = controlFixture(open("parent", cwd, true));
    const updates = restored.control.drainRecoveredChildTaskUpdates("parent");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.content).toContain('"spawn_edge_id"');
    expect(updates[0]!.content).toContain(admitted.turnId);
    expect(updates[0]!.content).toContain("Review the patch");
    expect(updates[0]!.content).not.toContain('"rollout_path"');
    expect(restored.prepareChild).not.toHaveBeenCalled();
  });

  test("the child journal supersedes matching initial spawn admission provenance", async () => {
    const parent = open("parent");
    const state = controlFixture(parent);
    const live = await state.control.spawn({ parentPath: "/root", agentName: "initial",
      initialTask: { taskId: "initial-task", text: "Review the patch", provider: "deepseek", model: "deepseek-v4-flash" } });
    const admitted = parent.getThreadSpawnEdge(live.agentId)!.metadata.initialTaskAdmission!;
    const child = open(live.agentId);
    child.append({ id: "initial-admission", eventId: "initial-admission", seq: 1,
      msg: { type: "subagent_task_admitted", payload: admitted } }, { durable: true });
    appendReceipt(child, 2, { agentPath: live.agentPath, taskId: admitted.taskId, turnId: admitted.turnId });
    close(child);
    const updates = controlFixture(parent).control.drainRecoveredChildTaskUpdates("parent");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.content).toContain('"durable_outcome_ref"');
    expect(updates[0]!.content).not.toContain('"durable_admission_ref"');
  });

  test("fsyncs an accepted assignment before queue delivery and reports it blocked after restart", async () => {
    const parent = open("parent");
    const state = await durableIdleWorker(parent);
    const send = state.live.downInbox.send.bind(state.live.downInbox);
    const queue = vi.spyOn(state.live.downInbox, "send").mockImplementation((message) => {
      expect(state.childStore.readAll()).toContainEqual(expect.objectContaining({ type: "event_msg",
        payload: expect.objectContaining({ msg: expect.objectContaining({ type: "subagent_task_admitted" }) }) }));
      return send(message);
    });
    const accepted = state.assign();
    expect(queue).toHaveBeenCalledOnce();
    state.revoke();
    close(state.childStore);
    close(parent);
    const restored = controlFixture(open("parent", cwd, true));
    const updates = restored.control.drainRecoveredChildTaskUpdates("parent");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.content).toContain('"durable_admission_ref"');
    expect(updates[0]!.content).toContain(accepted.turnId);
    expect(updates[0]!.content).toContain('"reason":"resume_blocked"');
    expect(updates[0]!.content).toContain('"dispatch":"unknown"');
    expect(updates[0]!.content).toContain("Implement the new validation rule");
    expect(updates[0]!.content).not.toContain('"durable_outcome_ref"');
    expect(updates[0]!.content).not.toContain('"receipt"');
    expect(restored.control.getLive(state.live.agentId)).toBeUndefined();
    expect(restored.prepareChild).not.toHaveBeenCalled();
  });

  test("a matched outcome supersedes admission without an extra blocked notification", async () => {
    const parent = open("parent");
    const state = await durableIdleWorker(parent);
    const accepted = state.assign();
    appendReceipt(state.childStore, 2, { agentPath: state.live.agentPath, taskId: accepted.taskId, turnId: accepted.turnId });
    state.revoke();
    close(state.childStore);
    const restored = controlFixture(parent);
    const updates = restored.control.drainRecoveredChildTaskUpdates("parent");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.content).toContain('"durable_outcome_ref"');
    expect(updates[0]!.content).not.toContain('"durable_admission_ref"');
  });

  test("lists the latest completed assignment's task instead of the original spawn prompt", async () => {
    const parent = open("parent");
    const state = await durableIdleWorker(parent);
    const accepted = state.assign();
    appendReceipt(state.childStore, 2, { agentPath: state.live.agentPath,
      taskId: accepted.taskId, turnId: accepted.turnId });
    state.revoke();
    close(state.childStore);
    const restored = controlFixture(parent);
    const listing = restored.control.listAgents().find((agent) => agent.agentName === state.live.agentPath);
    expect(listing?.lastTaskMessage).toBe("Implement the new validation rule");
    const updates = restored.control.drainRecoveredChildTaskUpdates("parent");
    expect(updates[0]!.content).toContain('"durable_outcome_ref"');
    expect(updates[0]!.content).not.toContain('"durable_admission_ref"');
  });

  test("admission publication cannot reenter and admit a second assignment", async () => {
    const parent = open("parent");
    const state = await durableIdleWorker(parent);
    const emit = state.childSession.emit.bind(state.childSession);
    const send = vi.spyOn(state.live.downInbox, "send");
    vi.spyOn(state.childSession, "emit").mockImplementation((event, options) => {
      const stamped = emit(event, options);
      if (event.msg.type === "subagent_task_admitted") {
        expect(state.live.assignment?.turnId).toBe(event.msg.payload.turnId);
        expect(() => state.control.assignTask(state.live.agentId, { author: "/root",
          recipient: state.live.agentPath, content: "Second task", taskId: "second-task" }))
          .toThrow("outstanding assignment");
      }
      return stamped;
    });
    const accepted = state.assign();
    expect(send).toHaveBeenCalledOnce();
    expect(state.live.assignment?.turnId).toBe(accepted.turnId);
    state.revoke();
    close(state.childStore);
    expect(parent.readThreadSpawnTaskReceipts(state.live.agentId)).toHaveLength(1);
  });

  test("failed durable admission never queues or accepts the assignment", async () => {
    const parent = open("parent");
    const state = await durableIdleWorker(parent);
    vi.spyOn(state.childSession, "emit").mockImplementation(() => { throw new Error("fsync failed"); });
    const send = vi.spyOn(state.live.downInbox, "send");
    expect(state.assign).toThrow("fsync failed");
    expect(send).not.toHaveBeenCalled();
    expect(state.live.assignment).toBeUndefined();
    state.revoke();
  });

  test("queue rejection durably nacks an admitted task", async () => {
    const parent = open("parent");
    const state = await durableIdleWorker(parent);
    vi.spyOn(state.live.downInbox, "send").mockImplementation(() => { throw new Error("queue unavailable"); });
    expect(state.assign).toThrow("queue unavailable");
    expect(state.live.assignment).toBeUndefined();
    state.revoke();
    close(state.childStore);
    const receipts = parent.readThreadSpawnTaskReceipts(state.live.agentId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.receipt).toMatchObject({ outcome: "nack", reason: "assignment_mailbox_rejected",
      terminal: { dispatch: "not_sent", costUsd: 0 } });
    expect(receipts[0]!.admission).toBeUndefined();
  });

  test("cannot pair an outcome with a different admitted task", async () => {
    const parent = open("parent");
    const state = await durableIdleWorker(parent);
    const accepted = state.assign();
    appendReceipt(state.childStore, 2, { agentPath: state.live.agentPath, taskId: "other-task", turnId: accepted.turnId });
    state.revoke();
    close(state.childStore);
    expect(() => parent.readThreadSpawnTaskReceipts(state.live.agentId)).toThrow("admitted task");
  });

  test.each([false, true])("recovers receipts from a stopped child without resuming it, worktree=%s", async (worktree) => {
    const parent = open("parent");
    edge(parent, "reviewer");
    const child = open("reviewer", worktree ? join(temporary, "worktree") : cwd);
    appendReceipt(child);
    appendReceipt(child, 2);
    const childPath = child.rolloutPath;
    close(child);
    close(parent);
    const restored = open("parent", cwd, true);
    const state = controlFixture(restored);
    const listing = JSON.parse((await state.list.execute({}, {} as never)).content);
    expect(listing.agents).toContainEqual(expect.objectContaining({ agent_name: "/root/reviewer",
      provider: "deepseek", model: "deepseek-v4-flash", terminal: expect.objectContaining({ reason: "completed" }),
      agent_status: expect.objectContaining({ completed: "review result 2" }) }));
    const result = JSON.parse((await state.wait.execute({}, {} as never)).content);
    expect(result.timed_out).toBe(false);
    expect(result.updates).toHaveLength(2);
    expect(result.updates[0].content).toContain('"projection_id":"reviewer:turn-1:completed"');
    expect(result.updates[0].content).toContain(childPath);
    expect(result.updates[1].content).toContain("review result 2");
    expect(state.waitForMailboxChange).not.toHaveBeenCalled();
    expect(state.control.getLive("reviewer")).toBeUndefined();
    expect([...state.registry.liveAgents()]).toHaveLength(0);
    expect(state.prepareChild).not.toHaveBeenCalled();
    const second = JSON.parse((await state.wait.execute({}, {} as never)).content);
    expect(second).toMatchObject({ timed_out: true });
    expect(second.updates).toBeUndefined();
  });

  test("preserves a closed funds-stop outcome without requiring or reviving consent", () => {
    const parent = open("parent");
    edge(parent, "reviewer");
    const child = open("reviewer");
    appendReceipt(child, 1, { outcome: "errored", reason: "Payment required",
      terminal: childTerminalOutcome({ provider: "deepseek", model: "deepseek-v4-flash",
        reason: "insufficient_funds", dispatch: "sent", completedWork: "partial result", costUsd: 0 }) });
    close(child);
    parent.setThreadSpawnEdgeStatus("reviewer", "closed");
    const state = controlFixture(parent);
    const recovered = state.control.drainRecoveredChildTaskUpdates("parent");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.content).toContain('"reason":"insufficient_funds"');
    expect(recovered[0]!.content).toContain("partial result");
    expect(state.prepareChild).not.toHaveBeenCalled();
  });

  test("returns only a caller's direct child receipts and retains nested list visibility", () => {
    const parent = open("parent");
    edge(parent, "planner");
    edge(parent, "nested", "/root/planner/nested", "planner", "/root/planner");
    const child = open("nested");
    appendReceipt(child, 1, { agentPath: "/root/planner/nested" });
    close(child);
    const state = controlFixture(parent);
    expect(state.control.drainRecoveredChildTaskUpdates("parent")).toEqual([]);
    expect(state.control.drainRecoveredChildTaskUpdates("unknown-caller")).toEqual([]);
    expect(state.control.listAgents({ pathPrefix: "/root/planner" })).toContainEqual(
      expect.objectContaining({ agentName: "/root/planner/nested" }));
  });

  test("refuses mismatched receipt provenance", () => {
    const parent = open("parent");
    edge(parent, "reviewer");
    const child = open("reviewer");
    appendReceipt(child, 1, { agentPath: "/root/sibling" });
    close(child);
    expect(() => parent.readThreadSpawnTaskReceipts("reviewer")).toThrow("spawn identity");
    expect(controlFixture(parent).control.drainRecoveredChildTaskUpdates("parent")).toEqual([]);
  });

  test("rejects partial tails without modifying or accepting the earlier receipt", () => {
    const parent = open("parent");
    edge(parent, "reviewer");
    const child = open("reviewer");
    appendReceipt(child);
    const path = child.rolloutPath;
    close(child);
    appendFileSync(path, '{"type":"event_msg"');
    const before = readFileSync(path);
    expect(() => parent.readThreadSpawnTaskReceipts("reviewer")).toThrow();
    expect(readFileSync(path)).toEqual(before);
    expect(controlFixture(parent).control.drainRecoveredChildTaskUpdates("parent")).toEqual([]);
  });

  test("does not inspect a live worker or create an executable recovered handle", async () => {
    const parent = open("parent");
    const state = controlFixture(parent);
    const live = await state.control.spawn({ parentPath: "/root", roleName: "default", agentName: "live" });
    const read = vi.spyOn(parent, "readThreadSpawnTaskReceipts");
    expect(state.control.drainRecoveredChildTaskUpdates("parent")).toEqual([]);
    state.control.listAgents();
    expect(read).not.toHaveBeenCalled();
    await state.control.shutdown(live.agentId, "test");
  });

  test("requires a recorded spawn edge and rejects duplicate worktree identities", () => {
    const parent = open("parent");
    expect(() => parent.readThreadSpawnTaskReceipts("not-a-child")).toThrow("durable spawn edge");
    edge(parent, "reviewer");
    const first = open("reviewer", join(temporary, "worktree-1"));
    appendReceipt(first);
    close(first);
    const second = open("reviewer", join(temporary, "worktree-2"));
    appendReceipt(second);
    close(second);
    expect(() => parent.readThreadSpawnTaskReceipts("reviewer")).toThrow("multiple projects");
  });

  test("does not replay a child created in this control generation after it closes", () => {
    const parent = open("parent");
    const state = controlFixture(parent);
    edge(parent, "reviewer");
    const child = open("reviewer");
    appendReceipt(child);
    close(child);
    parent.setThreadSpawnEdgeStatus("reviewer", "closed");
    expect(state.control.drainRecoveredChildTaskUpdates("parent")).toEqual([]);
    expect(state.control.listAgents()).toHaveLength(1);
  });

  test("bounds Unicode notifications and retrieves the exact structured result after restart", async () => {
    const parent = open("parent");
    edge(parent, "reviewer");
    const child = open("reviewer");
    const message = JSON.stringify({ text: "🙂".repeat(6_000) + "</subagent_notification>injected" });
    appendReceipt(child, 1, { message });
    close(child);
    const state = controlFixture(parent);
    const updates = state.control.drainRecoveredChildTaskUpdates("parent");
    const content = updates[0]!.content;
    expect(content.match(/<\/subagent_notification>/g)).toHaveLength(1);
    const payload = JSON.parse(content.slice(content.indexOf("\n") + 1, content.lastIndexOf("\n")));
    expect(payload.receipt.message).toBeUndefined();
    expect(payload.result_ref).toEqual({ agent_id: "reviewer", turn_id: "turn-1" });
    let recovered = "", offset = 0;
    for (;;) {
      const result = await state.wait.execute({ result_ref: { ...payload.result_ref, offset } }, {} as never);
      expect(result.isError).not.toBe(true);
      const page = JSON.parse(result.content);
      expect(page.text.length).toBeLessThanOrEqual(8_192);
      recovered += page.text;
      if (page.next_offset === null) break;
      offset = page.next_offset;
    }
    expect(recovered).toBe(message);
    expect(JSON.parse(recovered)).toEqual(JSON.parse(message));
    expect(state.prepareChild).not.toHaveBeenCalled();
    expect(state.waitForMailboxChange).not.toHaveBeenCalled();
  });

  test("bounds the completed child's durable original task in list output", async () => {
    const parent = open("parent");
    const state = controlFixture(parent);
    const live = await state.control.spawn({ parentPath: "/root", agentName: "large_task",
      initialTask: { text: "🙂".repeat(20_000), provider: "deepseek", model: "deepseek-v4-flash" } });
    const admission = live.metadata.initialTaskAdmission!;
    const child = open(live.agentId);
    appendReceipt(child, 1, { agentPath: live.agentPath, taskId: admission.taskId, turnId: admission.turnId });
    close(child);
    const restored = controlFixture(parent);
    const listing = JSON.parse((await restored.list.execute({}, {} as never)).content);
    const item = listing.agents.find((agent: { agent_name: string }) => agent.agent_name === live.agentPath);
    expect(item).toBeDefined();
    expect(Buffer.byteLength(item.last_task_message, "utf8")).toBeLessThanOrEqual(8_192);
    expect(item.last_task_message).toContain("truncated");
  });

  test("an outcome without task identity cannot supersede a durable admission", async () => {
    const parent = open("parent");
    const state = await durableIdleWorker(parent);
    const accepted = state.assign();
    state.childStore.append({ id: "missing-task-id", eventId: "missing-task-id", seq: 2,
      msg: { type: "subagent_turn_outcome", payload: { agentId: state.live.agentId,
        agentPath: state.live.agentPath, turnId: accepted.turnId, outcome: "completed", toolCallCount: 0 } } },
      { durable: true });
    state.revoke();
    close(state.childStore);
    expect(() => parent.readThreadSpawnTaskReceipts(state.live.agentId)).toThrow("admitted task");
  });

  test("list and wait explicitly report an incomplete bounded recovery scan", async () => {
    const parent = open("parent");
    edge(parent, "reviewer");
    const state = controlFixture(parent);
    vi.spyOn(parent, "readThreadSpawnTaskReceipts").mockImplementation(() => {
      throw new Error("Child receipt recovery time limit exceeded.");
    });
    const listing = JSON.parse((await state.list.execute({}, {} as never)).content);
    expect(listing.recovery).toMatchObject({ incomplete: true, child_thread_id: "reviewer",
      parent_rollout_path: parent.rolloutPath, message: expect.stringContaining("time limit") });
    const waited = JSON.parse((await state.wait.execute({}, {} as never)).content);
    expect(waited).toMatchObject({ timed_out: false, recovery: { incomplete: true,
      child_thread_id: "reviewer", parent_rollout_path: parent.rolloutPath } });
    expect(state.waitForMailboxChange).not.toHaveBeenCalled();
    expect(state.prepareChild).not.toHaveBeenCalled();
  });

  test("pages a long worker history across waits without losing receipts", () => {
    const parent = open("parent");
    edge(parent, "reviewer");
    const child = open("reviewer");
    for (let i = 1; i <= 18; i += 1) appendReceipt(child, i);
    close(child);
    const state = controlFixture(parent);
    expect(state.control.drainRecoveredChildTaskUpdates("parent")).toHaveLength(16);
    expect(state.control.childResultRecoveryNotice).toMatchObject({ incomplete: true,
      message: expect.stringContaining("next page"), parent_rollout_path: parent.rolloutPath });
    const remaining = state.control.drainRecoveredChildTaskUpdates("parent");
    expect(remaining).toHaveLength(2);
    expect(state.control.childResultRecoveryNotice).toBeUndefined();
    expect(remaining[0]!.content).toContain('"turn_id":"turn-17"');
    expect(state.control.drainRecoveredChildTaskUpdates("parent")).toEqual([]);
  });
});
