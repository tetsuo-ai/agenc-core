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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDelegateBackgroundAgentRunner } from "../../src/app-server/background-agent-runner.js";
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

type ChatMode = "default" | "acceptEdits" | "bypassPermissions";
/** One scripted model step: a file to read or write, or a final answer. */
type Step =
  | { readonly read: string }
  | { readonly write: { readonly path: string; readonly append?: boolean } }
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
  const respond = async (messages: ReadonlyArray<{ role?: string; content?: unknown }>) => {
    modelCalls += 1;
    const last = messages.at(-1);
    if (last?.role === "tool") toolResults.push(String(last.content));
    const step = steps.shift() ?? { answer: "done" };
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    if ("answer" in step) return { content: step.answer, toolCalls: [], usage, model: "scripted", finishReason: "stop" };
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
  vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);

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
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager: agents, sessionManager: sessions, routines: service });
  const connection = dispatcher.createConnection({});
  await connection.dispatch({ jsonrpc: JSON_RPC_VERSION, id: "init", method: "initialize", params: { protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION }, capabilities: {} } });
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
  /** What the Desktop sends for desktop_routine_create: the model's fields plus the owning chat. */
  async function createFromChat(sessionId: string, fields: JsonObject = {}) {
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
    workspace, outside, steps, toolResults, service, chat, rpc, createFromChat, scheduledRun, beforeNextMinute,
    modelCalls: () => modelCalls,
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
