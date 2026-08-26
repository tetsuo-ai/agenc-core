/**
 * Task 9: SubagentStop / SessionEnd / Notification lifecycle hook
 * events. Blocking + feedback semantics already existed for the other
 * events — these tests pin the new event plumbing end to end, including
 * the Accept-critical case: SubagentStop feedback reaching the PARENT
 * agent's completion notification.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dispatchNotification,
  dispatchSessionEnd,
  dispatchSubagentStop,
} from "./dispatcher.js";
import {
  registerNotificationHook,
  registerSessionEndHook,
  registerSubagentStopHook,
  resetLifecycleHookRegistry,
} from "./registry.js";
import type {
  NotificationHookInput,
  SessionEndHookInput,
  SubagentStopHookInput,
} from "./types.js";
import {
  BackgroundTaskLifecycle,
  registerAgentThreadTask,
} from "../../tasks/index.js";
import { HOOK_EVENT_NAMES } from "../../config/schema.js";

afterEach(() => {
  resetLifecycleHookRegistry();
});

describe("schema surface", () => {
  it("registers the three canonical event names", () => {
    expect(HOOK_EVENT_NAMES).toContain("SubagentStop");
    expect(HOOK_EVENT_NAMES).toContain("SessionEnd");
    expect(HOOK_EVENT_NAMES).toContain("Notification");
  });
});

describe("dispatchSubagentStop", () => {
  it("delivers the payload and aggregates failed-hook output + additionalContext as feedback", async () => {
    const seen: SubagentStopHookInput[] = [];
    registerSubagentStopHook(async (input) => {
      seen.push(input);
      return {
        succeeded: false,
        output: "verification failed: no tests were run",
      };
    });
    registerSubagentStopHook(async () => ({
      succeeded: true,
      output: "",
      additionalContexts: ["reviewer note: check the diff"],
    }));

    const result = await dispatchSubagentStop({
      hook_event_name: "SubagentStop",
      task_name: "writer_a",
      agent_id: "thread-1",
      agent_type: "runner",
      outcome: "completed",
      final_message: "done",
      duration_ms: 42,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      task_name: "writer_a",
      agent_type: "runner",
      outcome: "completed",
      final_message: "done",
    });
    expect(result.feedback).toContain("verification failed: no tests were run");
    expect(result.feedback).toContain("reviewer note: check the diff");
  });

  it("returns no feedback when every hook succeeds silently", async () => {
    registerSubagentStopHook(async () => ({ succeeded: true, output: "ok" }));
    const result = await dispatchSubagentStop({
      hook_event_name: "SubagentStop",
      task_name: "t",
      agent_id: "a",
      outcome: "completed",
      final_message: "",
    });
    expect(result.feedback).toBeUndefined();
  });
});

describe("dispatchSessionEnd / dispatchNotification", () => {
  it("deliver their payloads and contain hook failures", async () => {
    const endInputs: SessionEndHookInput[] = [];
    const notifyInputs: NotificationHookInput[] = [];
    registerSessionEndHook(async (input) => {
      endInputs.push(input);
      throw new Error("cleanup hook exploded");
    });
    registerNotificationHook(async (input) => {
      notifyInputs.push(input);
      return { succeeded: true, output: "" };
    });

    await expect(
      dispatchSessionEnd({
        hook_event_name: "SessionEnd",
        reason: "exit",
        session_id: "conv-9",
      }),
    ).resolves.toBeUndefined();
    await dispatchNotification({
      hook_event_name: "Notification",
      notification_type: "permission_request",
      message: "AgenC is waiting for permission to run Bash",
    });

    expect(endInputs[0]).toMatchObject({ reason: "exit", session_id: "conv-9" });
    expect(notifyInputs[0]).toMatchObject({
      notification_type: "permission_request",
    });
  });
});

describe("bare lifecycle authority", () => {
  it("hard-neutralizes SubagentStop, SessionEnd, and Notification", async () => {
    const subagentStop = vi.fn(async () => ({
      succeeded: false,
      output: "must not run",
    }));
    const sessionEnd = vi.fn(async () => ({
      succeeded: true,
      output: "must not run",
    }));
    const notification = vi.fn(async () => ({
      succeeded: true,
      output: "must not run",
    }));
    const runtimeOptions = { simpleMode: true } as const;

    await expect(
      dispatchSubagentStop(
        {
          hook_event_name: "SubagentStop",
          task_name: "bare-task",
          agent_id: "bare-agent",
          outcome: "completed",
          final_message: "done",
        },
        { hooks: [subagentStop], runtimeOptions },
      ),
    ).resolves.toEqual({});
    await expect(
      dispatchSessionEnd(
        {
          hook_event_name: "SessionEnd",
          reason: "exit",
          session_id: "bare-session",
        },
        { hooks: [sessionEnd], runtimeOptions },
      ),
    ).resolves.toBeUndefined();
    await expect(
      dispatchNotification(
        {
          hook_event_name: "Notification",
          notification_type: "permission_request",
          message: "waiting",
        },
        { hooks: [notification], runtimeOptions },
      ),
    ).resolves.toBeUndefined();

    expect(subagentStop).not.toHaveBeenCalled();
    expect(sessionEnd).not.toHaveBeenCalled();
    expect(notification).not.toHaveBeenCalled();
  });
});

describe("SubagentStop feedback reaches the parent's completion output", () => {
  it("appends hook feedback to the lifecycle task output the parent reads", async () => {
    registerSubagentStopHook(async (input) =>
      input.outcome === "completed"
        ? {
            succeeded: false,
            output: "BLOCKED: run the test suite before reporting done",
          }
        : { succeeded: true, output: "" },
    );

    const lifecycle = new BackgroundTaskLifecycle();
    let resolveJoin!: (value: {
      threadId: string;
      durationMs: number;
      outcome: "completed";
      finalMessage: string;
    }) => void;
    const joinPromise = new Promise<{
      threadId: string;
      durationMs: number;
      outcome: "completed";
      finalMessage: string;
    }>((resolvePromise) => {
      resolveJoin = resolvePromise;
    });
    const thread = {
      threadId: "agent-hooked",
      taskPrompt: "implement the parser",
      live: {
        agentId: "agent-hooked",
        abortController: new AbortController(),
        status: { value: "running" },
      },
      join: () => joinPromise,
    };
    registerAgentThreadTask(lifecycle, thread as never, {
      runtimeOptions: { simpleMode: false },
    });

    resolveJoin({
      threadId: "agent-hooked",
      durationMs: 5,
      outcome: "completed",
      finalMessage: "parser implemented",
    });
    await vi.waitFor(() => {
      expect(lifecycle.get("agent-hooked")?.status).toBe("completed");
    });

    const output = lifecycle.readOutput("agent-hooked");
    expect(output).toContain("parser implemented");
    expect(output).toContain("<subagent-stop-hook-feedback>");
    expect(output).toContain(
      "BLOCKED: run the test suite before reporting done",
    );
  });

  it("keeps the captured bare authority after the spawning turn detaches", async () => {
    const hook = vi.fn(async () => ({
      succeeded: false,
      output: "must not reach the parent",
    }));
    registerSubagentStopHook(hook);

    const lifecycle = new BackgroundTaskLifecycle();
    const joined = Promise.withResolvers<{
      threadId: string;
      durationMs: number;
      outcome: "completed";
      finalMessage: string;
    }>();
    const thread = {
      threadId: "agent-bare",
      taskPrompt: "implement without hooks",
      live: {
        agentId: "agent-bare",
        abortController: new AbortController(),
        status: { value: "running" },
      },
      join: () => joined.promise,
    };
    registerAgentThreadTask(lifecycle, thread as never, {
      runtimeOptions: { simpleMode: true },
    });

    joined.resolve({
      threadId: "agent-bare",
      durationMs: 5,
      outcome: "completed",
      finalMessage: "completed without hooks",
    });
    await vi.waitFor(() => {
      expect(lifecycle.get("agent-bare")?.status).toBe("completed");
    });

    expect(hook).not.toHaveBeenCalled();
    expect(lifecycle.readOutput("agent-bare")).toBe(
      "completed without hooks",
    );
  });
});
