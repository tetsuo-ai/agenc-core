import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AdmissionDeniedError } from "../../src/budget/admission-client.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import type { AgenCConfig } from "../../src/config/schema.js";
import { createHookExecutionAuthority } from "../../src/hooks/execution-authority.js";
import { executeSessionStatusLine } from "../../src/hooks/status-line-executor.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import { workspaceMutationCoordinators } from "../../src/workspace/mutation-coordinator.js";
import { createTestConfigStore, mkSession } from "../fixtures.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  workspaceMutationCoordinators.clearForTests();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e '${script.replaceAll("'", "'\\''")}'`;
}

async function fixture(options: {
  command?: string;
  trusted?: boolean;
  allowUntrustedHooks?: boolean;
  simpleMode?: boolean;
  config?: AgenCConfig;
} = {}) {
  const home = mkdtempSync(join(tmpdir(), "agenc-status-line-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const cwd = join(home, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const kernel = new ExecutionAdmissionKernel({ agencHome: home });
  cleanups.push(() => kernel.close());
  const admission = kernel.bindClient({ cwd, scope: { runId: "conv-test", sessionId: "conv-test", autonomous: false } });
  const configStore = createTestConfigStore({ cwd, base: {
    statusLine: { type: "command", command: options.command ?? "printf owner-status" },
    ...options.config,
  } });
  await configStore.reload();
  const shutdown = new AbortController();
  const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd });
  const runtimeOptions = { simpleMode: options.simpleMode ?? false, allowUntrustedHooks: options.allowUntrustedHooks ?? false };
  const { session, events } = mkSession({
    cwd,
    modelInfo: { contextWindow: 400_000 },
    services: {
      configStore,
      executionAdmission: admission,
      sandboxExecutionBroker: broker,
      hookExecutionAuthority: createHookExecutionAuthority({ runtimeOptions, isWorkspaceTrusted: () => options.trusted ?? true }),
      mcpStartupCancellationToken: { signal: shutdown.signal, cancel: () => shutdown.abort(), isCancelled: () => shutdown.signal.aborted },
      userShell: {
        path: "/bin/sh", commandWrapperArgv: [],
        childEnvironment: { PATH: "/usr/bin:/bin", HOME: home, AGENC_HOME: home },
        deriveExecArgs: (command) => ["-c", command],
      },
    },
  });
  return { session, events, home, cwd, admission, broker, configStore, shutdown };
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("status-line process did not start");
}

describe.skipIf(process.platform === "win32")("daemon-owned status-line executor", () => {
  test("uses owner command, workspace, environment, model, and aggregate ledger without model turns", async () => {
    const owner = await fixture({ command: nodeCommand('let input="";process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({input:JSON.parse(input),cwd:process.cwd(),home:process.env.HOME,project:process.env.AGENC_PROJECT_DIR,path:process.env.PATH})))') });
    const lease = await owner.admission.acquire({ stepId: "prior-model", kind: "model_turn", maxInputTokens: 40, maxOutputTokens: 10, maxCostUsd: 0.5 });
    owner.admission.markDispatched(lease.reservation.reservationId, { boundary: "provider_wire" });
    owner.admission.reconcile(lease.reservation.reservationId, { inputTokens: 23, outputTokens: 7, costUsd: 0.25 });
    owner.admission.acknowledgeCompletion(lease.reservation.reservationId);
    const result = await executeSessionStatusLine(owner.session, { vimMode: "NORMAL" });
    expect(result.status).toBe("rendered");
    expect(JSON.parse(result.text!)).toMatchObject({
      cwd: owner.cwd, home: owner.home, project: owner.configStore.projectRoot, path: "/usr/bin:/bin",
      input: {
        session_id: owner.session.conversationId, cwd: owner.cwd,
        workspace: { current_dir: owner.cwd, project_dir: owner.configStore.projectRoot },
        model: { id: "test-model" }, vim: { mode: "NORMAL" },
        cost: { total_cost_usd: 0.25, has_unknown_cost: false },
        context_window: { total_input_tokens: 23, total_output_tokens: 7 },
      },
    });
    expect(owner.admission.getUsageSummary?.()).toMatchObject({ costUsd: 0.25, modelCalls: 1 });
    expect(owner.events).toEqual([]);
    expect(owner.admission.replayJournal?.().some((event) => event.kind === "tool_exec")).toBe(true);
  });

  test.each([
    [{ trusted: false }, "blocked"],
    [{ trusted: false, allowUntrustedHooks: true }, "rendered"],
    [{ trusted: false, allowUntrustedHooks: true, simpleMode: true }, "blocked"],
  ] as const)("preserves hook authority for %j", async (options, status) => {
    const owner = await fixture(options);
    const spawn = vi.spyOn(owner.broker, "prepareSpawn");
    const result = await executeSessionStatusLine(owner.session);
    expect(result.status).toBe(status);
    expect(spawn).toHaveBeenCalledTimes(status === "rendered" ? 1 : 0);
  });

  test("managed-only selection ignores the effective user command", async () => {
    const owner = await fixture({ config: { disableAllHooks: true } });
    vi.spyOn(owner.configStore, "sources").mockImplementation((scope) => scope === "managed" ? [{ scope: "managed", label: "managed", config: { statusLine: { type: "command", command: "printf managed-status" } } }] : []);
    expect(await executeSessionStatusLine(owner.session)).toEqual({ status: "rendered", text: "managed-status" });
    vi.spyOn(owner.configStore, "sources").mockReturnValue([{ scope: "managed", label: "managed", config: { disableAllHooks: true } }]);
    const spawn = vi.spyOn(owner.broker, "prepareSpawn");
    expect(await executeSessionStatusLine(owner.session)).toMatchObject({ status: "disabled" });
    expect(spawn).not.toHaveBeenCalled();
  });

  test("mutable hook suppression and missing command perform no admission", async () => {
    const owner = await fixture();
    const acquire = vi.spyOn(owner.admission, "acquire");
    Object.assign(owner.session.services, { hooksRuntime: { isDisabled: () => true } });
    expect(await executeSessionStatusLine(owner.session)).toMatchObject({ status: "disabled" });
    Object.assign(owner.session.services, { hooksRuntime: undefined });
    vi.spyOn(owner.configStore, "current").mockReturnValue({});
    expect(await executeSessionStatusLine(owner.session)).toEqual({ status: "disabled", reason: "not_configured" });
    expect(acquire).not.toHaveBeenCalled();
  });

  test.each(["executionAdmission", "sandboxExecutionBroker", "hookExecutionAuthority"])("fails closed without %s", async (service) => {
    const owner = await fixture();
    const spawn = vi.spyOn(owner.broker, "prepareSpawn");
    Object.assign(owner.session.services, { [service]: undefined });
    expect(await executeSessionStatusLine(owner.session)).toMatchObject({ status: "blocked" });
    expect(spawn).not.toHaveBeenCalled();
  });

  test("admission denial and sandbox failure do not run a command", async () => {
    const owner = await fixture();
    const acquire = vi.spyOn(owner.admission, "acquire").mockRejectedValueOnce(new AdmissionDeniedError("test_denied"));
    expect(await executeSessionStatusLine(owner.session)).toEqual({ status: "blocked", reason: "admission_denied" });
    acquire.mockRestore();
    vi.spyOn(owner.broker, "prepareSpawn").mockImplementation(() => { throw new Error("boundary unavailable"); });
    const acknowledge = vi.spyOn(owner.admission, "acknowledgeCompletion");
    expect(await executeSessionStatusLine(owner.session)).toEqual({ status: "error", reason: "execution_failed" });
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  test("keeps concurrent sessions isolated and applies captured wrappers", async () => {
    const first = await fixture({ command: 'printf "%s" "$AGENC_PROJECT_DIR:$AGENC_STATUS_WRAPPER"' });
    const second = await fixture({ command: 'printf "%s" "$AGENC_PROJECT_DIR:$AGENC_STATUS_WRAPPER"' });
    Object.assign(first.session.services.userShell, { commandWrapperArgv: ["env", "AGENC_STATUS_WRAPPER=first", "/bin/sh", "-c"] });
    Object.assign(second.session.services.userShell, { commandWrapperArgv: ["env", "AGENC_STATUS_WRAPPER=second", "/bin/sh", "-c"] });
    expect(await Promise.all([executeSessionStatusLine(first.session), executeSessionStatusLine(second.session)]))
      .toEqual([{ status: "rendered", text: `${first.configStore.projectRoot}:first` }, { status: "rendered", text: `${second.configStore.projectRoot}:second` }]);
  });

  test("does not dispatch or retain an unknown hold when sandbox preparation refuses", async () => {
    const owner = await fixture();
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: owner.cwd,
      env: { HOME: owner.home, AGENC_HOME: owner.home, PATH: "" },
      sessionTempRoot: owner.home,
      probe: () => ({
        kind: "ready",
        mode: "workspace_write",
        platform: "linux",
        landlock: "full",
        landlockFallback: {
          reason: "bubblewrap was not found in a trusted system directory",
          remediation: "Provide a trusted bubblewrap directory in the session PATH.",
        },
      }),
      platform: "linux",
    });
    Object.assign(owner.session.services, { sandboxExecutionBroker: broker });
    const dispatched = vi.spyOn(owner.admission, "markDispatched");
    const held = vi.spyOn(owner.admission, "holdUnknown");
    const voided = vi.spyOn(owner.admission, "void");
    const result = await executeSessionStatusLine(owner.session);
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("sandbox_policy_unexpressible");
    expect(dispatched).not.toHaveBeenCalled();
    expect(held).not.toHaveBeenCalled();
    expect(voided).toHaveBeenCalledOnce();
    expect(owner.admission.replayJournal?.().map((event) => event.event)).toContain("voided");
  });

  test("marks dispatch only after successful sandbox preparation", async () => {
    const owner = await fixture();
    const order: string[] = [];
    const prepare = owner.broker.prepareSpawn.bind(owner.broker);
    vi.spyOn(owner.broker, "prepareSpawn").mockImplementation((...args) => {
      order.push("prepare");
      return prepare(...args);
    });
    const dispatch = owner.admission.markDispatched.bind(owner.admission);
    vi.spyOn(owner.admission, "markDispatched").mockImplementation((...args) => {
      order.push("dispatch");
      return dispatch(...args);
    });
    expect(await executeSessionStatusLine(owner.session)).toMatchObject({ status: "rendered" });
    expect(order).toEqual(["prepare", "dispatch"]);
  });

  test("settles confirmed spawn failure as zero usage without an unknown hold", async () => {
    const owner = await fixture();
    const shellPath = join(owner.home, "removed-shell");
    copyFileSync("/bin/sh", shellPath);
    Object.assign(owner.session.services.userShell, { path: shellPath });
    const dispatch = owner.admission.markDispatched.bind(owner.admission);
    vi.spyOn(owner.admission, "markDispatched").mockImplementation((...args) => {
      dispatch(...args);
      rmSync(shellPath);
    });
    const held = vi.spyOn(owner.admission, "holdUnknown");
    const reconcile = vi.spyOn(owner.admission, "reconcile");
    expect(await executeSessionStatusLine(owner.session)).toEqual({ status: "error", reason: "command_failed" });
    expect(held).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledWith(expect.any(String), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  test("returns busy without cancelling another request and tracks physical work", async () => {
    const owner = await fixture({ command: "sleep 0.1; printf complete" });
    const tracked = vi.spyOn(owner.session, "trackDurableOperation");
    const first = executeSessionStatusLine(owner.session);
    expect(await executeSessionStatusLine(owner.session)).toEqual({ status: "unavailable", reason: "busy" });
    expect(await first).toEqual({ status: "rendered", text: "complete" });
    expect(tracked).toHaveBeenCalledOnce();
    expect(await executeSessionStatusLine(owner.session)).toMatchObject({ status: "rendered" });
  });

  test.each(["caller", "shutdown"])("drains a subprocess on %s cancellation before acknowledging completion", async (source) => {
    const owner = await fixture();
    const marker = join(owner.home, "child.pid");
    vi.spyOn(owner.configStore, "current").mockReturnValue({ statusLine: { type: "command", command: nodeCommand(`require("node:fs").writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`) } });
    const controller = new AbortController();
    const acknowledge = vi.spyOn(owner.admission, "acknowledgeCompletion");
    const pending = executeSessionStatusLine(owner.session, {}, controller.signal);
    await waitForFile(marker);
    const pid = Number(readFileSync(marker, "utf8"));
    expect(acknowledge).not.toHaveBeenCalled();
    if (source === "caller") controller.abort();
    else owner.shutdown.abort();
    expect(await pending).toMatchObject({ status: "unavailable", reason: "cancelled" });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  test("hard timeout applies even with a caller signal and includes admission waiting", async () => {
    const owner = await fixture();
    vi.spyOn(owner.admission, "acquire").mockImplementation((_input, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    }));
    const spawn = vi.spyOn(owner.broker, "prepareSpawn");
    expect(await executeSessionStatusLine(owner.session, {}, new AbortController().signal))
      .toEqual({ status: "error", reason: "timeout" });
    expect(spawn).not.toHaveBeenCalled();
  }, 8_000);

  test("rejects oversized output without exposing a partial status", async () => {
    const owner = await fixture({ command: nodeCommand('process.stdout.write("x".repeat(17000))') });
    expect(await executeSessionStatusLine(owner.session)).toEqual({ status: "error", reason: "output_too_large" });
  });

  test("restores available context, follows live usage, and preserves approved additional directories", async () => {
    const owner = await fixture({ command: "cat" });
    owner.session.state.unsafePeek().initialTokenUsage = Object.assign({ promptTokens: 200_001, completionTokens: 10, cachedInputTokens: 1_000 }, { model: "test-model", provider: "grok" });
    const permissions = owner.session.services.permissionModeRegistry.current();
    vi.spyOn(owner.session.services.permissionModeRegistry, "current").mockReturnValue({
      ...permissions,
      additionalWorkingDirectories: new Map([[owner.home, { path: owner.home, source: "session" }]]) as typeof permissions.additionalWorkingDirectories,
    });
    const restored = await executeSessionStatusLine(owner.session);
    expect(JSON.parse(restored.text!)).toMatchObject({
      exceeds_200k_tokens: true,
      workspace: { added_dirs: [owner.home] },
      context_window: { used_percentage: 50, remaining_percentage: 50,
        current_usage: { input_tokens: 199_001, output_tokens: 10, cache_read_input_tokens: 1_000 } },
    });
    owner.session.emit({ id: "new-usage", msg: { type: "token_count", payload: { promptTokens: 40_000, completionTokens: 100, model: "test-model", provider: "grok" } } });
    const updated = await executeSessionStatusLine(owner.session);
    expect(JSON.parse(updated.text!)).toMatchObject({ exceeds_200k_tokens: false, context_window: { used_percentage: 10, current_usage: { input_tokens: 40_000 } } });
  });

  test("reads only the bounded canonical tail and reports unknown context when absent", async () => {
    const owner = await fixture({ command: "cat" });
    const missing = await executeSessionStatusLine(owner.session);
    expect(JSON.parse(missing.text!)).toMatchObject({ exceeds_200k_tokens: null, context_window: { current_usage: null, used_percentage: null } });
    const resumed = await fixture({ command: "cat" });
    const path = join(resumed.home, "rollout.jsonl");
    writeFileSync(path, `${"x".repeat(100_000)}\n${JSON.stringify({ type: "event_msg", payload: { msg: { type: "token_count", payload: { promptTokens: 80_000, completionTokens: 10, model: "test-model", provider: "grok" } } } })}\n`);
    Object.defineProperty(resumed.session, "rolloutStore", { get: () => ({ rolloutPath: path }) });
    expect(JSON.parse((await executeSessionStatusLine(resumed.session)).text!)).toMatchObject({ context_window: { used_percentage: 20, current_usage: { input_tokens: 80_000 } } });
  });

  test("revokes a queued command when its owner configuration changes", async () => {
    const owner = await fixture();
    let release!: () => void;
    let admitted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const acquired = new Promise<void>((resolve) => { admitted = resolve; });
    const original = owner.admission.acquire.bind(owner.admission);
    vi.spyOn(owner.admission, "acquire").mockImplementationOnce(async (input, signal) => {
      const lease = await original(input, signal);
      admitted();
      await gate;
      return lease;
    });
    const spawn = vi.spyOn(owner.broker, "prepareSpawn");
    const voidReservation = vi.spyOn(owner.admission, "void");
    const pending = executeSessionStatusLine(owner.session);
    await acquired;
    vi.spyOn(owner.configStore, "current").mockReturnValue({ statusLine: { type: "command", command: "printf new-command" } });
    release();
    expect(await pending).toEqual({ status: "unavailable", reason: "configuration_changed" });
    expect(spawn).not.toHaveBeenCalled();
    expect(voidReservation).toHaveBeenCalledOnce();
  });

  test("hard deadline physically stops a live child even with a caller signal", async () => {
    const owner = await fixture();
    const marker = join(owner.home, "timeout.pid");
    vi.spyOn(owner.configStore, "current").mockReturnValue({ statusLine: { type: "command", command: nodeCommand(`require("node:fs").writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`) } });
    const pending = executeSessionStatusLine(owner.session, {}, new AbortController().signal);
    await waitForFile(marker);
    const pid = Number(readFileSync(marker, "utf8"));
    expect(await pending).toEqual({ status: "error", reason: "timeout" });
    expect(() => process.kill(pid, 0)).toThrow();
  }, 8_000);

  test.each(["history_cleared", "transcript_epoch", "context_compacted"] as const)("invalidates live context at %s without losing cumulative usage", async (type) => {
    const owner = await fixture({ command: "cat" });
    owner.session.state.unsafePeek().initialTokenUsage = Object.assign({ promptTokens: 200_000, completionTokens: 10 }, { model: "test-model", provider: "grok" });
    expect(JSON.parse((await executeSessionStatusLine(owner.session)).text!).context_window.used_percentage).toBe(50);
    owner.session.eventLog.emit({ id: "reset", msg: { type, payload: {} } } as never);
    const result = JSON.parse((await executeSessionStatusLine(owner.session)).text!);
    expect(result.context_window.current_usage).toBeNull();
    expect(result.context_window.used_percentage).toBeNull();
    expect(result.exceeds_200k_tokens).toBeNull();
    expect(result.cost.total_cost_usd).toBe(0);
  });

  test.each(["compaction_committed", "history_cleared"])("does not restore old context before a canonical %s tail", async (type) => {
    const owner = await fixture({ command: "cat" });
    const path = join(owner.home, "replaced-rollout.jsonl");
    const reset = type === "history_cleared" ? { type: "event_msg", payload: { msg: { type, payload: { timestamp: 1 } } } } : { type };
    writeFileSync(path, [
      { type: "event_msg", payload: { msg: { type: "token_count", payload: { promptTokens: 200_000, completionTokens: 10, model: "test-model", provider: "grok" } } } },
      reset,
    ].map((item) => JSON.stringify(item)).join("\n"));
    Object.defineProperty(owner.session, "rolloutStore", { get: () => ({ rolloutPath: path }) });
    expect(JSON.parse((await executeSessionStatusLine(owner.session)).text!).context_window.current_usage).toBeNull();
  });

  test("blocks configured commands while Editor owns the workspace", async () => {
    const owner = await fixture();
    const registry = workspaceMutationCoordinators.forHome(owner.configStore.homeContext.path);
    registry.acquireEditor(owner.cwd, { workspaceRoot: owner.cwd, editorInstanceId: "status-line-editor" });
    const spawn = vi.spyOn(owner.broker, "prepareSpawn");
    const acquire = vi.spyOn(owner.admission, "acquire");
    expect(await executeSessionStatusLine(owner.session)).toEqual({ status: "blocked", reason: "editor_workspace_owned" });
    expect(spawn).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  test("holds the Editor fence until a cancelled process physically settles", async () => {
    const owner = await fixture();
    const marker = join(owner.home, "editor-fence.pid");
    vi.spyOn(owner.configStore, "current").mockReturnValue({ statusLine: { type: "command", command: nodeCommand(`require("node:fs").writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`) } });
    const registry = workspaceMutationCoordinators.forHome(owner.configStore.homeContext.path);
    const controller = new AbortController();
    const pending = executeSessionStatusLine(owner.session, {}, controller.signal);
    await waitForFile(marker);
    expect(() => registry.acquireEditor(owner.cwd, { workspaceRoot: owner.cwd, editorInstanceId: "during-status-line" })).toThrow(/active tool/u);
    controller.abort();
    expect(() => registry.acquireEditor(owner.cwd, { workspaceRoot: owner.cwd, editorInstanceId: "before-drain" })).toThrow(/active tool/u);
    expect(await pending).toMatchObject({ status: "unavailable" });
    expect(() => process.kill(Number(readFileSync(marker, "utf8")), 0)).toThrow();
    expect(() => registry.acquireEditor(owner.cwd, { workspaceRoot: owner.cwd, editorInstanceId: "after-drain" })).not.toThrow();
  });

  test("auxiliary MCP sampling does not replace main conversation context", async () => {
    const owner = await fixture({ command: "cat" });
    await executeSessionStatusLine(owner.session);
    owner.session.emit({ id: "main", msg: { type: "token_count", payload: { promptTokens: 200_000, completionTokens: 10, model: "test-model", provider: "grok" } } });
    owner.session.emit({ id: "auxiliary", msg: { type: "token_count", payload: { promptTokens: 100, completionTokens: 5, model: "test-model" } } });
    expect(JSON.parse((await executeSessionStatusLine(owner.session)).text!)).toMatchObject({ context_window: { used_percentage: 50, current_usage: { input_tokens: 200_000 } } });
  });
});
