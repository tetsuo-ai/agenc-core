/**
 * Shared daemon harness for the scheduled-routine end-to-end tests: one daemon
 * process with the real runner, bootstrap, permission evaluator and file tools,
 * and a scripted model.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDelegateBackgroundAgentRunner } from "../../src/app-server/background-agent-runner.js";
import { AgenCDaemonClientMultiplexer } from "../../src/app-server/client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { LiveApprovalBroker } from "../../src/app-server/live-approval-broker.js";
import { AGENC_DAEMON_PROTOCOL_VERSION, JSON_RPC_VERSION, type JsonObject } from "../../src/app-server/protocol/index.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { bootstrapLocalRuntimeSession } from "../../src/bin/bootstrap.js";
import { trustProject } from "../../src/permissions/trust/project-trust.js";
import { createDaemonRoutineExecutor } from "../../src/routines/daemon-executor.js";
import { RoutineService } from "../../src/routines/service.js";
import type { Routine, RoutineRun } from "../../src/routines/types.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { Session } from "../../src/session/session.js";
import { createSessionMcpElicitationHandlers } from "../../src/elicitation/mcp.js";
import { SandboxDeniedError } from "../../src/permissions/sandbox.js";
import { Policy } from "../../src/sandbox/execpolicy/policy.js";
import { orchestrateToolCall } from "../../src/tools/orchestrator.js";

export type ChatMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";
/** One scripted model step: a file to read or write, or a final answer. */
export type Step =
  | { readonly read: string }
  | { readonly write: { readonly path: string; readonly append?: boolean } }
  | { readonly exec: string }
  /** An MCP server asks the person a question in the middle of the run. */
  | { readonly elicit: true }
  /** Code that runs inside the scheduled run's own live session, then the next step. */
  | { readonly during: (session: Session) => Promise<void> }
  | { readonly answer: string };

export const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

export async function daemon(options: { trusted?: boolean } = {}) {
  // A canonical path: the macOS /var symlink must not reach the workspace checks.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rsm-")));
  const home = join(root, "home"); mkdirSync(home, { mode: 0o700 });
  const workspace = join(root, "ws"); mkdirSync(workspace); mkdirSync(join(workspace, ".git"));
  const outside = join(root, "outside"); mkdirSync(outside);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  if (options.trusted !== false) await trustProject({ cwd: workspace, agencHome: home, env: { AGENC_HOME: home, HOME: home } });

  // The model: a queue of steps shared by whichever routine run asks next.
  const steps: Step[] = [];
  const toolResults: string[] = [];
  let modelCalls = 0;
  // Every session bootstrapped here, newest last: a scheduled run's is the routine's.
  const liveSessions: Session[] = [];
  const elicitations: unknown[] = [];
  const respond = async (messages: ReadonlyArray<{ role?: string; content?: unknown }>) => {
    modelCalls += 1;
    const last = messages.at(-1);
    if (last?.role === "tool") toolResults.push(String(last.content));
    let step = steps.shift() ?? { answer: "done" };
    // The scheduled run's session is the newest one: its chat started first.
    if ("during" in step) {
      await step.during(liveSessions.at(-1)!);
      step = steps.shift() ?? { answer: "done" };
    }
    if ("elicit" in step) {
      // Asked of the routine's own session, through the handler an MCP server's request reaches.
      const handlers = createSessionMcpElicitationHandlers(liveSessions.at(-1)!);
      elicitations.push(await Promise.race([
        handlers.handleRequest({
          serverName: "fixture-mcp", requestId: "elicit-1",
          request: { mode: "form", message: "Which account should I use?", requestedSchema: { type: "object", properties: { account: { type: "string" } } } },
          contextMeta: undefined, signal: undefined,
        }),
        new Promise((resolve) => setTimeout(() => resolve("still waiting for a person"), 2_000)),
      ]));
      step = steps.shift() ?? { answer: "done" };
    }
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    if ("answer" in step) return { content: step.answer, toolCalls: [], usage, model: "scripted", finishReason: "stop" };
    if ("exec" in step) {
      return {
        content: "", usage, model: "scripted", finishReason: "tool_calls",
        toolCalls: [{ id: `call-${modelCalls}`, name: "exec_command", arguments: JSON.stringify({ cmd: step.exec }) }],
      };
    }
    if ("read" in step) {
      return {
        content: "", usage, model: "scripted", finishReason: "tool_calls",
        toolCalls: [{ id: `call-${modelCalls}`, name: "FileRead", arguments: JSON.stringify({ file_path: step.read }) }],
      };
    }
    const { path, append } = step.write;
    const previous = append && existsSync(path) ? readFileSync(path, "utf8") : "";
    const content = `${previous}${new Date().toISOString()}\n`;
    return {
      content: "", usage, model: "scripted", finishReason: "tool_calls",
      toolCalls: [{ id: `call-${modelCalls}`, name: "Write", arguments: JSON.stringify({ file_path: path, content }) }],
    };
  };
  const providerModule = await import("../../src/llm/provider.js");
  vi.spyOn(providerModule, "createProvider").mockImplementation(() => ({
    name: "scripted",
    // Scripted replies are bounded and include authoritative usage.
    getExecutionProfile: async () => ({ provider: "scripted", model: "scripted",
      supportsMaxOutputTokens: true, maxOutputTokens: 8192, usageReporting: "authoritative" }),
    chat: (messages: never) => respond(messages),
    chatStream: (messages: never) => respond(messages),
    healthCheck: async () => true,
  }) as never);
  vi.spyOn(Session.prototype, "startMcpManager").mockImplementation(function (this: Session) {
    liveSessions.push(this);
    return Promise.resolve(undefined) as never;
  });

  const env = { ...process.env, AGENC_HOME: home, HOME: home, AGENC_WORKSPACE: workspace, XAI_API_KEY: "scripted-key" };
  const approvalBroker = new LiveApprovalBroker();
  const runner = new AgenCDelegateBackgroundAgentRunner({
    approvalBroker, bootstrap: (bootstrapOptions) => bootstrapLocalRuntimeSession(bootstrapOptions), env,
  });
  const sessions = new AgenCDaemonSessionManager();
  let service!: RoutineService;
  const agents = new AgenCDaemonAgentManager({
    approvalBroker, agencHome: home, runner, sessionManager: sessions,
    broadcastSessionEvent: async (sessionId, event) => service?.observeSessionEvent(sessionId, event),
  });
  // A clock that can be moved to just before the next cron minute.
  let offsetMs = 0;
  const now = () => new Date(Date.now() + offsetMs);
  const beforeNextMinute = (leadMs = 400) => {
    const current = now().getTime();
    offsetMs += Math.ceil((current + 1) / 60_000) * 60_000 - leadMs - current;
  };
  const runtimeOptions = resolveAgentRuntimeOptions({ ...env }, {
    dangerouslyBypassApprovalsAndSandbox: false, allowUntrustedHooks: false, remoteMode: false, stdinDataMode: false,
  });
  service = new RoutineService({
    home, now,
    executor: createDaemonRoutineExecutor({ agentManager: agents, environment: env, defaultProvider: () => "grok", runtimeOptions }),
  });
  service.start();
  // The Desktop's chat connection: it holds the chats it relays, and speaks the
  // wider routine contract.
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({
    agentManager: agents, sessionManager: sessions, routines: service,
    clientMultiplexer: new AgenCDaemonClientMultiplexer({ sessionManager: sessions }),
  });
  const connection = dispatcher.createConnection({ sendNotification: () => undefined });
  await connection.dispatch({ jsonrpc: JSON_RPC_VERSION, id: "init", method: "initialize", params: { protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION }, capabilities: { "routine.permissionModes.v2": true } } });
  const chats: string[] = [];
  cleanups.push(async () => {
    await service.close();
    for (const agentId of chats) await agents.stopAgent({ agentId, reason: "test finished" }).catch(() => undefined);
    await dispatcher.closeConnection(connection);
    await dispatcher.close();
  });

  /** A Desktop chat session, created the way the Desktop creates one. */
  async function chat(mode: ChatMode) {
    const created = await agents.createAgent({
      objective: "Interactive session", cwd: workspace, deferInitialTurn: true, permissionMode: mode,
      envOverrides: { XAI_API_KEY: "scripted-key" },
      runtimeOptions: { ...runtimeOptions, dangerouslyBypassApprovalsAndSandbox: mode === "bypassPermissions" },
    });
    chats.push(created.agentId);
    expect(created.sessionId).toBeTruthy();
    return created.sessionId!;
  }
  async function rpc(method: string, params: JsonObject) {
    return connection.dispatch({ jsonrpc: JSON_RPC_VERSION, id: `${method}-${Math.random()}`, method, params });
  }
  const held = new Set<string>();
  /** What the Desktop sends for desktop_routine_create: the model's fields plus the owning chat, which it holds. */
  async function createFromChat(sessionId: string, fields: JsonObject = {}) {
    if (!held.has(sessionId)) {
      const attached = await rpc("session.attach", { sessionId, clientId: `desktop-${held.size + 1}` }) as { error?: unknown };
      expect(attached.error).toBeUndefined();
      held.add(sessionId);
    }
    beforeNextMinute();
    return rpc("routine.create", {
      name: "Tick logger", instructions: "Append the current time as one line to ticks.txt.", cwd: workspace,
      schedule: { kind: "cron", expression: "* * * * *" }, ...fields,
      permissionAuthority: { kind: "session", sessionId },
    });
  }
  async function scheduledRun(id: string, count = 1): Promise<RoutineRun> {
    await vi.waitFor(() => {
      const runs = service.runs({ id }).runs;
      expect(runs.length).toBeGreaterThanOrEqual(count);
      expect(["completed", "failed", "cancelled", "interrupted"]).toContain(runs[0]!.status);
    }, { timeout: 60_000, interval: 50 });
    return service.runs({ id }).runs[0]!;
  }
  return {
    workspace, outside, home, steps, toolResults, elicitations, service, chat, rpc, createFromChat, scheduledRun, beforeNextMinute,
    runtimeOptions, modelCalls: () => modelCalls,
  };
}

export function routineOf(response: unknown): Routine {
  const value = response as { result?: { routine?: Routine }; error?: unknown };
  expect(value.error).toBeUndefined();
  return value.result!.routine!;
}
