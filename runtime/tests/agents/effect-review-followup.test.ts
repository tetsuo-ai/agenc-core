import { afterEach, expect, it, vi } from "vitest";
import { requestParentFollowupTurn } from "../../src/agents/run-agent.js";
import { AgentControl, type LiveAgent } from "../../src/agents/control.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { EventLog, type Event } from "../../src/session/event-log.js";
import type { Session } from "../../src/session/session.js";
import { SimpleMailbox } from "../../src/session/session.js";
import { createAgentRoleWorkspace } from "../../src/agents/role-workspace.js";

afterEach(() => vi.useRealTimers());

it.each(["parent", "root"])("parks the %s follow-up after a review refusal and wakes only after all reviews resolve", async (kind) => {
  vi.useFakeTimers();
  let pending = false;
  const mailbox = new SimpleMailbox();
  const eventLog = new EventLog();
  const warnings: unknown[] = [];
  eventLog.subscribe(event => { if (event.msg.type === "warning") warnings.push(event); });
  const submit = vi.fn(async () => {
    if (submit.mock.calls.length === 1) {
      pending = true;
      throw new Error("run root requires effect review before model execution");
    }
    mailbox.drain();
    return true;
  });
  const session = {
    conversationId: "root", roleWorkspace: createAgentRoleWorkspace("/tmp"),
    services: {}, sessionConfiguration: { cwd: "/tmp" },
    eventLog, mailbox, abortController: new AbortController(), userStopGeneration: 0,
    rolloutStore: { hasPendingEffectReviews: () => pending, listThreadSpawnDescendants: () => [] },
    submit, submitChildFollowup: submit,
    nextInternalSubId: () => "sub", hasDeferredAgentMailboxMessages: () => false,
  } as unknown as Session;
  if (kind === "parent") {
    mailbox.send({ author: "/root/child", recipient: "/root", content: "done", triggerTurn: true });
    requestParentFollowupTurn({ parent: session, live: { agentPath: "/root/child" } as LiveAgent });
    await vi.advanceTimersByTimeAsync(200);
  } else {
    const control = new AgentControl({ session, registry: new AgentRegistry() });
    control.registerSessionRoot("root");
    await control.sendInterAgentCommunication("root", { author: "/root/child", recipient: "/root", content: "done", triggerTurn: true });
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(submit).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(warnings).toEqual([]);
  const reviewed = () => eventLog.emit({ id: "review", msg: { type: "effect_review_resolved", payload: {
    runId: "root", stepId: "step", callId: "call", resolution: { workflowStatus: "resolved" },
  } } } as Event);
  reviewed(); // A second review still holds the gate.
  await vi.advanceTimersByTimeAsync(1000);
  expect(submit).toHaveBeenCalledTimes(1);
  pending = false;
  reviewed();
  await vi.advanceTimersByTimeAsync(200);
  expect(submit).toHaveBeenCalledTimes(2);
  expect(mailbox.hasPending()).toBe(false);
  session.abortController.abort();
});
