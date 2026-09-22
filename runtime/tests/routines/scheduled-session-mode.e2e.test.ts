/**
 * End to end, in one daemon process: a chat session in some permission mode
 * asks for a routine the way the Desktop relays a model's tool call (the
 * session named as the authority, no mode of its own), the scheduler fires on
 * its cron minute, and a fresh routine agent runs through the REAL runner,
 * bootstrap, permission evaluator and file tools. Only the model is scripted.
 *
 * Owner decision (2026-09-22): "routines should use the session's mode". A
 * routine created in a Bypass session that is told to append the time to
 * ticks.txt must append it on each scheduled run; one created in default mode
 * stays read-only, as before.
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

type ChatMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";
/** One scripted model step: a file to read or write, or a final answer. */
type Step =
  | { readonly read: string }
  | { readonly write: { readonly path: string; readonly append?: boolean } }
  | { readonly exec: string }
  /** An MCP server asks the person a question in the middle of the run. */
  | { readonly elicit: true }
  /** Code that runs inside the scheduled run's own live session, then the next step. */
  | { readonly during: (session: Session) => Promise<void> }
  | { readonly answer: string };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function daemon(options: { trusted?: boolean } = {}) {
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

function routineOf(response: unknown): Routine {
  const value = response as { result?: { routine?: Routine }; error?: unknown };
  expect(value.error).toBeUndefined();
  return value.result!.routine!;
}

describe("scheduled routines run with the mode of the session that created them", () => {
  it("appends the time to ticks.txt on each scheduled run of a routine created in a Bypass session", async () => {
    const d = await daemon();
    const ticks = join(d.workspace, "ticks.txt");
    const routine = routineOf(await d.createFromChat(await d.chat("bypassPermissions")));
    expect(routine.permissionMode).toBe("bypassPermissions");
    expect(routine).not.toHaveProperty("permissionAuthority");

    d.steps.push({ write: { path: ticks, append: true } }, { answer: "Appended one tick." });
    const first = await d.scheduledRun(routine.id);
    expect(first).toMatchObject({ trigger: "schedule", status: "completed", error: null });
    expect(readFileSync(ticks, "utf8").trim().split("\n")).toHaveLength(1);

    // The next cron minute appends again rather than starting over. Like a
    // real model, the run reads the file before rewriting it (Write refuses
    // to overwrite a file this session has not read).
    d.beforeNextMinute();
    d.service.update({ id: routine.id, patch: { enabled: true } });
    d.steps.push({ read: ticks }, { write: { path: ticks, append: true } }, { answer: "Appended one tick." });
    const second = await d.scheduledRun(routine.id, 2);
    expect(second).toMatchObject({ trigger: "schedule", status: "completed", error: null });
    expect(second.id).not.toBe(first.id);
    expect(readFileSync(ticks, "utf8").trim().split("\n")).toHaveLength(2);
  }, 120_000);

  it("keeps a routine created in a default session read-only on its scheduled run, as today", async () => {
    const d = await daemon();
    const ticks = join(d.workspace, "ticks.txt");
    const routine = routineOf(await d.createFromChat(await d.chat("default")));
    expect(routine.permissionMode).toBe("default");
    d.steps.push({ write: { path: ticks, append: true } }, { answer: "Could not write." });
    const run = await d.scheduledRun(routine.id);
    expect(run).toMatchObject({ trigger: "schedule", status: "failed" });
    expect(run.error).toContain("read-only permissions");
    expect(existsSync(ticks)).toBe(false);
    expect(d.toolResults.join("\n")).toContain("nobody attached to approve it");
  }, 120_000);

  it("rejects a model-supplied mode wider than its session before anything is stored", async () => {
    const d = await daemon();
    const sessionId = await d.chat("default");
    const response = await d.createFromChat(sessionId, { permissionMode: "bypassPermissions" }) as { error?: { data?: { code?: string } } };
    expect(response.error?.data?.code).toBe("ROUTINE_PERMISSION_DENIED");
    expect(d.service.list().routines).toEqual([]);
  }, 120_000);

  it("honors a narrower mode the model asks for", async () => {
    const d = await daemon();
    const ticks = join(d.workspace, "ticks.txt");
    const routine = routineOf(await d.createFromChat(await d.chat("bypassPermissions"), { permissionMode: "default" }));
    expect(routine.permissionMode).toBe("default");
    d.steps.push({ write: { path: ticks } }, { answer: "Could not write." });
    const run = await d.scheduledRun(routine.id);
    expect(run.status).toBe("failed");
    expect(existsSync(ticks)).toBe(false);
  }, 120_000);

  it("gives an acceptEdits routine workspace edits and nothing it would have to ask for", async () => {
    const d = await daemon();
    const ticks = join(d.workspace, "ticks.txt");
    const escaped = join(d.outside, "escaped.txt");
    const routine = routineOf(await d.createFromChat(await d.chat("acceptEdits")));
    expect(routine.permissionMode).toBe("acceptEdits");
    d.steps.push({ write: { path: ticks } }, { write: { path: escaped } }, { answer: "Wrote the tick; the other file was refused." });
    const run = await d.scheduledRun(routine.id);
    expect(existsSync(ticks)).toBe(true);
    expect(existsSync(escaped)).toBe(false);
    expect(run.status).toBe("failed");
    expect(run.error).not.toContain("read-only");
  }, 120_000);

  it("keeps a Bypass routine's file writes inside its workspace", async () => {
    const d = await daemon();
    const escaped = join(d.outside, "escaped.txt");
    const routine = routineOf(await d.createFromChat(await d.chat("bypassPermissions")));
    d.steps.push({ write: { path: escaped } }, { answer: "The write was refused." });
    const run = await d.scheduledRun(routine.id);
    expect(existsSync(escaped)).toBe(false);
    expect(run.status).toBe("failed");
    expect(d.toolResults.join("\n")).toMatch(/inside its workspace/u);
  }, 120_000);

  it("keeps a Bypass routine's writes inside its workspace through a link that leads out of it", async () => {
    // File tools write in the daemon's own process, outside the OS sandbox,
    // so the permission check follows links the way the OS does: a project
    // can carry a link whose target does not exist yet, and a write through
    // it lands wherever it points. The write is refused before any tool runs.
    const d = await daemon();
    const escaped = join(d.outside, "created-through-link.txt");
    symlinkSync(escaped, join(d.workspace, "notes.txt"));
    const routine = routineOf(await d.createFromChat(await d.chat("bypassPermissions")));
    d.steps.push({ write: { path: join(d.workspace, "notes.txt") } }, { answer: "The write was refused." });
    const run = await d.scheduledRun(routine.id);
    expect(existsSync(escaped)).toBe(false);
    expect(run.status).toBe("failed");
    expect(d.toolResults.join("\n")).toMatch(/inside its workspace/u);
  }, 120_000);

  it("confines a Bypass routine's shell to its workspace: no session temp root, TMPDIR in a scratch folder there", async () => {
    const d = await daemon();
    const tempRoot = d.runtimeOptions.sessionTempRoot;
    const escaped = join(tempRoot, `routine-escape-${Date.now()}.txt`);
    cleanups.push(() => rmSync(escaped, { force: true }));
    const routine = routineOf(await d.createFromChat(await d.chat("bypassPermissions")));
    d.steps.push({ exec: `touch ${escaped}` }, { exec: "mktemp" }, { answer: "Done." });
    await d.scheduledRun(routine.id);
    expect(existsSync(escaped)).toBe(false);
    // mktemp made its file in the run's scratch folder inside the workspace.
    expect(d.toolResults.at(-1)).toContain(join(d.workspace, ".agenc-routine"));
    // The scratch folder is gone after the run, and git would have ignored it.
    expect(readdirSync(join(d.workspace, ".agenc-routine"))).toEqual([".gitignore"]);
    expect(readFileSync(join(d.workspace, ".agenc-routine", ".gitignore"), "utf8")).toBe("*\n");
  }, 120_000);

  it("never dispatches a routine command outside the OS sandbox when an exec-policy rule selects it", async () => {
    // Core's exec-policy check runs for local_shell calls, with each session's
    // own policy (empty today). This drives that real orchestrator path inside
    // the live session of a scheduled Bypass run, with a rule that allows
    // `touch` unsandboxed.
    const d = await daemon();
    const escaped = join(d.outside, "escaped-by-rule.txt");
    const routine = routineOf(await d.createFromChat(await d.chat("bypassPermissions")));
    const dispatched: string[] = [];
    let outcome = "";
    d.steps.push({ during: async (session) => {
      const policy = Policy.empty();
      policy.addPrefixRule(["touch"], "allow");
      outcome = await orchestrateToolCall({
        tool: { name: "local_shell" } as never,
        approvalCtx: { invocation: { session, turn: {} } as never, callId: "local-shell-1", toolName: "local_shell" },
        approvalPolicy: "never", sandboxMode: "workspace_write", execPolicy: policy,
        payload: { kind: "local_shell", params: { command: ["touch", escaped] } },
        dispatch: async (sandbox) => {
          dispatched.push(sandbox);
          if (sandbox === "danger_full_access") execFileSync("touch", [escaped]);
          return "ran";
        },
      }).catch((error: Error) => error.message);
    } }, { answer: "Done." });
    await d.scheduledRun(routine.id);
    expect(dispatched).toEqual([]);
    expect(existsSync(escaped)).toBe(false);
    expect(outcome).toMatch(/only inside the OS sandbox/u);
  }, 120_000);

  it("never reruns a routine command outside the sandbox after a sandbox denial, whoever would approve it", async () => {
    const d = await daemon();
    const escaped = join(d.outside, "escaped-on-retry.txt");
    const routine = routineOf(await d.createFromChat(await d.chat("acceptEdits")));
    const dispatched: string[] = [];
    let asked = 0;
    d.steps.push({ during: async (session) => {
      const args = { cmd: `touch ${escaped}` };
      await orchestrateToolCall({
        tool: { name: "exec_command" } as never,
        approvalCtx: {
          invocation: { session, turn: {}, callId: "retry-1", payload: { kind: "function", arguments: JSON.stringify(args) } } as never,
          callId: "retry-1", toolName: "exec_command",
        },
        // Approve edits retries a sandbox denial once someone approves: here a
        // permission hook that approves anything, as a configured hook could.
        approvalPolicy: "on_failure", sandboxMode: "workspace_write", approvalArgs: args,
        permissionHooks: [() => { asked += 1; return { kind: "approved" }; }],
        dispatch: async (sandbox) => {
          dispatched.push(sandbox);
          if (sandbox === "danger_full_access") { execFileSync("touch", [escaped]); return "ran"; }
          throw new SandboxDeniedError("Operation not permitted", { denial: "filesystem", target: escaped, policy: { kind: "workspace-write" } as never });
        },
      }).catch(() => undefined);
    } }, { answer: "Done." });
    await d.scheduledRun(routine.id);
    expect(dispatched).toEqual(["workspace_write"]);
    expect(asked).toBe(0);
    expect(existsSync(escaped)).toBe(false);
  }, 120_000);

  it.each(["default", "plan", "acceptEdits"] as const)("declines an MCP server's question to a person in a scheduled %s run instead of waiting", async (mode) => {
    const d = await daemon();
    const asked = vi.spyOn(Session.prototype, "requestMcpElicitation");
    const routine = routineOf(await d.createFromChat(await d.chat(mode)));
    d.steps.push({ elicit: true }, { answer: "Done." });
    // The run reaches its end (a plan run ends failed without a plan hand-off, as before).
    await d.scheduledRun(routine.id);
    expect(d.elicitations).toEqual([expect.objectContaining({ action: "decline" })]);
    expect(asked).not.toHaveBeenCalled();
  }, 120_000);

  it("fails a Bypass routine clearly when its workspace is not trusted, instead of running it read-only", async () => {
    const d = await daemon({ trusted: false });
    const routine = routineOf(await d.createFromChat(await d.chat("bypassPermissions")));
    expect(routine.permissionMode).toBe("bypassPermissions");
    const run = await d.scheduledRun(routine.id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/not trusted/u);
    expect(d.modelCalls()).toBe(0);
  }, 120_000);
});
