import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { runTurn } from "../../src/session/run-turn.js";
import { SessionStore } from "../../src/session/session-store.js";
import { assertOneShotRecoverable, promoteOneShotRun } from "../../src/durability/one-shot-durability.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

async function collect(gen: ReturnType<typeof runTurn>) {
 const events = [];
 for await (const event of gen) events.push(event);
 return events;
}

function setup(fast: boolean, calls: boolean, hooks = {}, completion = false) {
 const execute = vi.fn(async (_args: Record<string, unknown>) => ({ content: "fixture inspected" }));
 const tool = { name: "review_fixture", description: "Read a fixture", isReadOnly: true,
   recoveryCategory: "idempotent" as const, inputSchema: { type: "object" as const }, execute };
 const registry = buildToolRegistry({ workspaceRoot: "/tmp", requireAdmission: false, extraTools: [tool] });
 const provider = mkProvider(); let count = 0;
 const requests: unknown[] = [];
 provider.chatStream = async messages => {
   requests.push(JSON.parse(JSON.stringify(messages)));
   const call = calls && count++ === 0;
   return { content: call ? "" : "Done.", toolCalls: call ? [{ id: "fixture-call", name: tool.name, arguments: "{}" }] : [],
     finishReason: call ? "tool_calls" : "stop", model: "test-model",
     usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 } };
 };
 const f = mkSession({ provider, registry, services: { hooks,
   runtimeOptions: resolveAgentRuntimeOptions({}, { nonInteractive: true, dangerouslyBypassApprovalsAndSandbox: true, relaxedOneShot: true }) } });
 Object.assign(f.session.services, { permissionModeRegistry: new PermissionModeRegistry({
   ...f.session.permissionModeRegistry.current(), mode: "bypassPermissions", isBypassPermissionsModeAvailable: true }) });
 const ctx = mkCtx({ permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" },
   config: { ...mkCtx().config, bypassFastMode: fast, completionGate: { mode: completion ? "always" : "never", max_rounds: 1 } } });
 return { ...f, ctx, execute, requests, provider };
}

test.each([false,true])("RV stop hook is invoked at terminal (fast=%s)", async fast => {
 const stop = vi.fn(async () => ({ shouldStop: true, shouldBlock: false, continuationFragments: [] }));
 const f = setup(fast, false, { stopHooks: [{ name: "review-stop", run: stop }] });
 try { await drain(runTurn(f.session, f.ctx, "Say done.", { exactOutput: true })); expect(stop).toHaveBeenCalledOnce(); }
 finally { await f.session.shutdown(); }
});

test.each([false,true])("RV configured pre-tool hook retains its fixture denial (fast=%s)", async fast => {
 const hook = vi.fn(() => ({ kind: "deny" as const, reason: "fixture unavailable for this turn" }));
 const f = setup(fast, true, { preToolUseHooks: [hook] });
 try {
  await drain(runTurn(f.session, f.ctx, "Inspect the fixture.", { exactOutput: true }));
  expect({ hooks: hook.mock.calls.length, executions: f.execute.mock.calls.length }).toEqual({ hooks: 1, executions: 0 });
 } finally { await f.session.shutdown(); }
});

test.each([false,true])("RV explicit completion gate remains active (fast=%s)", async fast => {
 const f = setup(fast, true, {}, true);
 try {
  await drain(runTurn(f.session, f.ctx, "Inspect the fixture and verify it is correct."));
  expect(f.events.some(event => event.msg.type === "completion_gate")).toBe(true);
 } finally { await f.session.shutdown(); }
});

test.each([false,true])("RV clean close produces a recoverable complete run (fast=%s)", fast => {
 const root = mkdtempSync(join(tmpdir(), "rv-fast-close-"));
 const cwd = join(root, "workspace"), home = join(root, "home"); mkdirSync(cwd);mkdirSync(home);
 const store = new SessionStore({ cwd, agencHome: home, sessionId: "review-run", agencVersion: "test",
   relaxedOneShot: true, checkpointOneShot: () => {} });
 try {
  store.open({ sessionId: "review-run", cwd, timestamp: "2026-10-09T00:00:00Z", agencVersion: "test", originator: "test" });
  if (fast) store.enableOneShotFastMode();
  store.appendRollout({ type: "response_item", payload: { role: "user", content: "retained run message" } });
  store.close();
  expect(readFileSync(store.rolloutPath, "utf8")).toContain("retained run message");
  expect(() => assertOneShotRecoverable(store.rolloutPath)).not.toThrow();
 } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});


test.each([false, true])("blocking Stop hooks continue once without replay (fast=%s)", async fast => {
 let stops = 0;
 const stop = vi.fn(async () => ({ shouldStop: ++stops > 1, shouldBlock: stops === 1,
   blockReason: "verify the fixture", continuationFragments: ["Inspect the missing check."] }));
 const f = setup(fast, false, { stopHooks: [{ name: "review-block", run: stop }] });
 try {
  const result = await collect(runTurn(f.session, f.ctx, "Say done.", { exactOutput: true }));
  expect(stop).toHaveBeenCalledTimes(2);
  expect(f.requests).toHaveLength(2);
  expect(JSON.stringify(f.requests[1])).toContain("Inspect the missing check.");
  expect(result.filter(e => e.type === "turn_complete")).toHaveLength(1);
 } finally { await f.session.shutdown(); }
});

test.each([false, true])("Stop hooks retain the canonical recursion cap (fast=%s)", async fast => {
 const stop = vi.fn(async () => ({ shouldStop: false, shouldBlock: true,
   blockReason: "verify", continuationFragments: ["Inspect the missing check."] }));
 const f = setup(fast, false, { stopHooks: [{ name: "review-block", run: stop }] });
 try {
  await drain(runTurn(f.session, f.ctx, "Say done.", { exactOutput: true }));
  expect(f.requests.length).toBeGreaterThan(1);
  expect(f.requests.length).toBeLessThan(10);
  expect(stop.mock.calls.length).toBe(f.requests.length);
  expect(f.events.some(e => e.msg.type === "error" && e.msg.payload.cause === "stop_hook_loop")).toBe(true);
 } finally { await f.session.shutdown(); }
});

test.each([false, true])("pre/post hooks rewrite arguments and model feedback once (fast=%s)", async fast => {
 const pre = vi.fn(({ args }: { args: Record<string, unknown> }) => ({ kind: "continue", args: { ...args, injected: "reviewed" } }));
 const post = vi.fn(() => ({ kind: "rewrite", result: { content: "reviewed tool result" } }));
 const f = setup(fast, true, { preToolUseHooks: [pre], postToolUseHooks: [post] });
 try {
  await drain(runTurn(f.session, f.ctx, "Inspect the fixture.", { exactOutput: true }));
  expect(pre).toHaveBeenCalledOnce(); expect(post).toHaveBeenCalledOnce();
  expect(f.execute).toHaveBeenCalledOnce();
  expect(f.execute.mock.calls[0]?.[0]).toMatchObject({ injected: "reviewed" });
  expect(f.requests).toHaveLength(2);
  expect(JSON.stringify(f.requests[1])).toContain("reviewed tool result");
 } finally { await f.session.shutdown(); }
});

test.each([false, true])("post-hook stop preserves the tool result without another sample (fast=%s)", async fast => {
 const post = vi.fn(() => ({ kind: "preventContinuation", stopReason: "review required" }));
 const f = setup(fast, true, { postToolUseHooks: [post] });
 try {
  await drain(runTurn(f.session, f.ctx, "Inspect the fixture.", { exactOutput: true }));
  expect(post).toHaveBeenCalledOnce(); expect(f.execute).toHaveBeenCalledOnce();
  expect(f.requests).toHaveLength(1);
  expect(f.events.some(e => e.msg.type === "tool_call_completed")).toBe(true);
 } finally { await f.session.shutdown(); }
});

test("completion verification keeps request bytes and usage equal after fast tool dispatch", async () => {
 const run = async (fast: boolean) => {
  const f = setup(fast, true, {}, true);
  try {
   const result = await collect(runTurn(f.session, f.ctx, "Inspect the fixture and verify it is correct."));
   return { requests: f.requests, terminal: result.find(e => e.type === "turn_complete"),
     gates: f.events.filter(e => e.msg.type === "completion_gate").map(e => e.msg) };
  } finally { await f.session.shutdown(); }
 };
 const normal = await run(false), fast = await run(true);
 expect(fast.requests).toEqual(normal.requests);
 expect(fast.requests).toHaveLength(3);
 expect(fast.terminal).toEqual(normal.terminal);
 expect(fast.gates).toEqual(normal.gates);
});

test.each(["handoff", "promotion", "flush-failure", "checkpoint-failure"])("fast finalization: %s", action => {
 const root = mkdtempSync(join(tmpdir(), "rv-fast-boundary-"));
 const cwd = join(root, "workspace"), home = join(root, "home"); mkdirSync(cwd); mkdirSync(home);
 const checkpoint = vi.fn(() => {
   expect(readFileSync(store.rolloutPath, "utf8")).toContain("buffered message");
   if (action === "checkpoint-failure") throw new Error("injected checkpoint failure");
 });
 const store = new SessionStore({ cwd, agencHome: home, sessionId: "review-boundary", agencVersion: "test",
   relaxedOneShot: true, checkpointOneShot: checkpoint });
 try {
  store.open({ sessionId: "review-boundary", cwd, timestamp: "2026-10-09T00:00:00Z", agencVersion: "test", originator: "test" });
  store.enableOneShotFastMode();
  store.appendRollout({ type: "response_item", payload: { role: "user", content: "buffered message" } });
  if (action === "handoff") store.finishOneShotFastMode();
  if (action === "promotion") {
   promoteOneShotRun("review-boundary");
   expect(readFileSync(store.rolloutPath, "utf8")).toContain("buffered message");
   store.appendRollout({ type: "response_item", payload: { role: "user", content: "after promotion" } }, { durable: true });
   expect(readFileSync(store.rolloutPath, "utf8")).toContain("after promotion");
  }
  if (action === "flush-failure") store.setFsyncImplForTest(() => { throw new Error("injected fsync failure"); });
  if (action.endsWith("failure")) {
   expect(() => store.close()).toThrow();
   expect(() => assertOneShotRecoverable(store.rolloutPath)).toThrow();
  } else {
   store.close();
   expect(() => assertOneShotRecoverable(store.rolloutPath)).not.toThrow();
  }
 } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});


test("only a factory-owned disabled auto-fix hook permits direct dispatch, with live refresh", async () => {
 const { createAutoFixPostToolHook } = await import("../../src/services/autoFix/autoFixHook.js");
 const { hasConfiguredToolHooks } = await import("../../src/phases/execute-tools.js");
 let config: unknown;
 const hook = createAutoFixPostToolHook({ configSource: () => config, cwd: "/tmp",
   executionAuthority: { decision: () => ({ allowed: true }) } as never });
 const hooks = { postToolUseHooks: [hook] };
 const f = setup(true, true, hooks);
 try {
  expect(hasConfiguredToolHooks(f.session)).toBe(false);
  config = { enabled: true, lint: "echo lint" };
  expect(hasConfiguredToolHooks(f.session)).toBe(true);
  config = { enabled: false };
  expect(hasConfiguredToolHooks(f.session)).toBe(false);
  hooks.postToolUseHooks.push(async () => ({ kind: "continue" }));
  expect(hasConfiguredToolHooks(f.session)).toBe(true);
 } finally { await f.session.shutdown(); }
});
