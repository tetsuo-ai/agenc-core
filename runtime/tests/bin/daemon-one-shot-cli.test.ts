import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ trust: vi.fn(), ready: vi.fn(), connect: vi.fn(), continuation: vi.fn() }));
vi.mock("../../src/bin/project-trust-preflight.js", () => ({ requireProjectTrustForTui: mocks.trust }));
vi.mock("../../src/bin/agenc-main.js", () => { throw new Error("fresh print loaded the full dispatcher"); });
vi.mock("../../src/app-server-client/index.js", () => { throw new Error("fresh print loaded the TUI client shell"); });
vi.mock("../../src/bin/daemon-one-shot-continue.js", () => ({ runDaemonOneShotContinue: mocks.continuation }));
vi.mock("../../src/app-server/agent-cli.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/app-server/agent-cli.js")>(),
  defaultEnsureDaemonReady: () => mocks.ready,
  createConnectedAgenCJsonLineDaemonTuiClient: mocks.connect,
}));
import { oneShotCLI, type OneShotInvocation, type AgenCDaemonCliDeps } from "../../src/bin/daemon-one-shot-cli.js";
let home: string, workspace: string;
const originalArgv = process.argv;
let writes: string[];
const request = vi.fn(), close = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  home = mkdtempSync(join(tmpdir(), "thin-print-")); workspace = join(home, "repo"); mkdirSync(workspace);
  vi.stubEnv("AGENC_HOME", home); vi.stubEnv("AGENC_WORKSPACE", workspace);
  process.argv = ["node", "agenc", "-p", "--light", "hello"];
  mocks.trust.mockResolvedValue(true); mocks.ready.mockResolvedValue(undefined); mocks.continuation.mockResolvedValue(23);
  writes = []; vi.spyOn(process.stdout, "write").mockImplementation(chunk => { writes.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  request.mockImplementation(async method => {
    if (method === "agent.create") return { agentId: "agent", sessionId: "session" };
    if (method === "agent.attach") return { sessionIds: ["session"] };
    return {};
  });
  close.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue({ request, close,
    subscribeToConnectionState: () => () => {},
    subscribeToSessionEvents: (_id: string, callback: (event: unknown) => void) => {
      queueMicrotask(() => {
        callback({ method: "event.message_chunk", params: { sessionId: "session", delta: "pong" } });
        callback({ method: "event.agent_status", params: { sessionId: "session", status: "idle", runStatus: "completed" } });
      });
      return () => {};
    },
  });
});
afterEach(() => { process.argv = originalArgv; vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

it("uses the authenticated client contract and preserves prompt, permission and cleanup without the dispatcher", async () => {
  const prompt = "  indented\n";
  expect(await oneShotCLI(prompt, [], { lightMode: true, permissionMode: "acceptEdits" })).toBe(0);
  expect(mocks.trust).toHaveBeenCalledOnce(); expect(mocks.ready).toHaveBeenCalledOnce(); expect(mocks.connect).toHaveBeenCalledOnce();
  expect(request.mock.calls[0]).toEqual(["agent.create", expect.objectContaining({
    objective: prompt, instructions: prompt, initialContent: prompt, cwd: workspace,
    permissionMode: "acceptEdits", runtimeOptions: expect.objectContaining({ nonInteractive: true, relaxedOneShot: true }),
    metadata: { source: "agenc.prompt", mode: "one-shot" },
  }), expect.objectContaining({ signal: expect.any(AbortSignal) })]);
  expect(writes.join("")).toBe("pong\n");
  expect(request).toHaveBeenCalledWith("agent.stop", { agentId: "agent", reason: "one_shot_complete" });
  expect(close).toHaveBeenCalledOnce(); expect(mocks.continuation).not.toHaveBeenCalled();
});

it("refuses trust before connecting or creating a session", async () => {
  mocks.trust.mockResolvedValue(false);
  expect(await oneShotCLI("hello")).toBe(1);
  expect(mocks.ready).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
});

it("keeps a transport failure distinct from completed one-shot cleanup and JSON output", async () => {
  process.argv = ["node", "agenc", "-p", "--light", "--output-format", "json", "hello"];
  mocks.connect.mockResolvedValue({ request, close, subscribeToConnectionState: () => () => {},
    subscribeToSessionEvents: (_id: string, callback: (event: unknown) => void) => {
      queueMicrotask(() => callback({ params: { sessionId: "session", event: { type: "turn_failed", payload: {
        turnId: "failed-turn", code: "transport_error", message: "model stream interrupted",
        durationMs: 125, remainingDeadlineMs: 500, usableFinalAnswer: false,
        transportFailure: { category: "http_5xx", status: 502 },
      } } } }));
      return () => {};
    },
  });
  expect(await oneShotCLI("hello")).toBe(1);
  expect(request).toHaveBeenCalledWith("agent.stop", { agentId: "agent", reason: "one_shot_failed" });
  expect(JSON.parse(writes.join(""))).toMatchObject({ exitCode: 1, failureCode: "transport_error",
    durationMs: 125, remainingDeadlineMs: 500, usableFinalAnswer: false, transportFailure: { category: "http_5xx", status: 502 } });
});

it("loads continuation only for the existing resume selector and forwards its exact prepared inputs", async () => {
  const selector = { kind: "latest" as const };
  expect(await oneShotCLI("next turn", [], { permissionMode: "plan", model: "grok-4.7" }, selector)).toBe(23);
  expect(mocks.continuation).toHaveBeenCalledWith(expect.objectContaining({
    continueSession: selector, prompt: "next turn", initialContent: "next turn", permissionMode: "plan", model: "grok-4.7",
    runtimeOptions: expect.objectContaining({ relaxedOneShot: false }),
  }));
  expect(mocks.connect).not.toHaveBeenCalled();
});

function invocationFixture(label: string, format = "text", autoComplete = true) {
  const callerHome = join(home, label), callerCwd = join(callerHome, "repo");
  mkdirSync(callerCwd, { recursive: true });
  writeFileSync(join(callerHome, "config.toml"), `config_version = 2\nmodel = "model-${label}"\nmodel_provider = "openai-compatible"\n`);
  const input = Object.assign(new PassThrough(), { isTTY: false });
  const output = Object.assign(new PassThrough(), { isTTY: false });
  const errors = Object.assign(new PassThrough(), { isTTY: false });
  let stdout = "", stderr = "";
  output.on("data", chunk => { stdout += chunk.toString(); });
  errors.on("data", chunk => { stderr += chunk.toString(); });
  const abort = new AbortController();
  const context: OneShotInvocation = {
    argv: ["node", "agenc", "-p", "--light", "--output-format", format, label],
    env: { HOME: callerHome, AGENC_HOME: callerHome, PATH: `/caller/${label}`, AGENC_WORKSPACE: callerCwd },
    cwd: callerCwd, clientId: `invocation-${label}`, signal: abort.signal,
    // Non-TTY pipes have all the stream operations used by this print route.
    stdin: input as unknown as NodeJS.ReadStream,
    stdout: output as unknown as NodeJS.WriteStream,
    stderr: errors as unknown as NodeJS.WriteStream,
  };
  let send: ((event: unknown) => void) | undefined;
  let subscribed!: () => void;
  const attached = new Promise<void>(resolve => { subscribed = resolve; });
  const call = vi.fn(async (method: string) => {
    if (method === "agent.create") return { agentId: label, sessionId: label };
    if (method === "agent.attach") return { sessionIds: [label] };
    return {};
  });
  const close = vi.fn(async () => {});
  const complete = () => {
    send?.({ method: "event.message_chunk", params: { sessionId: label, delta: `answer-${label}` } });
    send?.({ method: "event.agent_status", params: { sessionId: label, status: "idle", runStatus: "completed" } });
  };
  const client = { request: call, close,
    subscribeToConnectionState: () => () => {},
    subscribeToSessionEvents: (_id: string, callback: (event: unknown) => void) => {
      send = callback; subscribed(); if (autoComplete) queueMicrotask(complete);
      return () => { send = undefined; };
    },
  };
  const overrides = { createConnectedTuiClient: vi.fn(async () => client) } as unknown as Partial<AgenCDaemonCliDeps>;
  const run = () => oneShotCLI(`  prompt-${label}\n`, [], undefined, undefined, overrides, context);
  return { context, call, close, abort, attached, complete, run, overrides, output: () => ({ stdout, stderr }) };
}

it("keeps concurrent caller config, cwd, output and attachment identity isolated", async () => {
  const a = invocationFixture("a"), b = invocationFixture("b");
  const argv = process.argv, cwd = process.cwd(), env = { home: process.env.AGENC_HOME, path: process.env.PATH };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const listeners = signals.map(signal => process.listenerCount(signal));
  mocks.ready.mockImplementation(async () => {
    expect(process.argv).toBe(argv); expect(process.cwd()).toBe(cwd);
    expect(process.env.AGENC_HOME).toBe(env.home); expect(process.env.PATH).toBe(env.path);
    expect(signals.map(signal => process.listenerCount(signal))).toEqual(listeners);
  });
  expect(await Promise.all([a.run(), b.run()])).toEqual([0, 0]);
  for (const [label, f] of [["a", a], ["b", b]] as const) {
    expect(f.call).toHaveBeenCalledWith("agent.create", expect.objectContaining({
      objective: `  prompt-${label}\n`, initialContent: `  prompt-${label}\n`, cwd: f.context.cwd,
      model: `model-${label}`, envOverrides: expect.objectContaining({ PATH: `/caller/${label}` }),
    }), expect.anything());
    expect(f.call).toHaveBeenCalledWith("agent.attach", expect.objectContaining({ clientId: f.context.clientId }), expect.anything());
    expect(f.output()).toEqual({ stdout: `answer-${label}\n`, stderr: "" });
    expect(f.close).toHaveBeenCalledOnce();
  }
  expect(writes).toEqual([]);
  expect(mocks.trust).toHaveBeenCalledWith(expect.objectContaining({ env: a.context.env, argv: a.context.argv, cwd: a.context.cwd, allowPrompt: false, markSessionTrusted: expect.any(Function), stderr: a.context.stderr }));
});

it.each(["json", "stream-json"])("formats %s into the invocation output only", async format => {
  const f = invocationFixture("structured", format);
  expect(await f.run()).toBe(0);
  const lines = f.output().stdout.trim().split("\n").map(line => JSON.parse(line));
  expect(lines.at(-1)).toMatchObject({ type: "result", exitCode: 0, agentId: "structured", finalMessage: "answer-structured" });
  if (format === "json") expect(lines).toHaveLength(1);
  else expect(lines.some(line => line.type === "event")).toBe(true);
  expect(writes).toEqual([]); expect(f.output().stderr).toBe("");
});

it("cancels only the caller that disconnected, while the other invocation completes", async () => {
  const a = invocationFixture("cancel", "text", false), b = invocationFixture("live", "text", false);
  const first = a.run(), second = b.run();
  await Promise.all([a.attached, b.attached]);
  a.abort.abort({ reason: "signal", signal: "SIGINT", exitCode: 130 });
  expect(await first).toBe(130);
  expect(a.call).toHaveBeenCalledWith("agent.stop", { agentId: "cancel", reason: "one_shot_cancelled" });
  expect(b.close).not.toHaveBeenCalled(); b.complete(); expect(await second).toBe(0);
  expect(b.output().stdout).toBe("answer-live\n"); expect(writes).toEqual([]);
});

it("routes preparation errors to the invocation and refuses continuation before any session", async () => {
  const f = invocationFixture("invalid", "invalid-format");
  expect(await f.run()).toBe(1);
  expect(f.output().stderr).toContain("unknown output format 'invalid-format'");
  expect(f.call).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  expect(await oneShotCLI("next", [], {}, { kind: "latest" }, f.overrides, f.context)).toBe(1);
  expect(f.output().stderr).toContain("invocation-scoped print cannot continue");
  expect(mocks.continuation).not.toHaveBeenCalled();
});

it.each([false, true])("forwards CLI task budgets into daemon creation (bypass=%s)", async bypass => {
  process.argv = ["node", "agenc", "-p", "--task-token-budget", "219000",
    "--task-max-calls", "17", ...(bypass ? ["--dangerously-bypass-approvals-and-sandbox"] : []), "--", "hello"];
  expect(await oneShotCLI("hello")).toBe(0);
  expect(request).toHaveBeenCalledWith("agent.create", expect.objectContaining({
    taskTokenBudget: 219000, taskMaxCalls: 17,
  }), expect.anything());
});

it("leaves task budgets absent by default on daemon creation", async () => {
  expect(await oneShotCLI("hello")).toBe(0);
  const create = request.mock.calls.find(([method]) => method === "agent.create")![1];
  expect(create).not.toHaveProperty("taskTokenBudget");
  expect(create).not.toHaveProperty("taskMaxCalls");
});

it.each([false, true])("prints the budget explanation once when terminal text is truncated=%s", async truncated => {
  const summary = "Partial result: stopped at the task budget.\n\nThe task used 0 of 1 tokens (0 model calls).\n\n" + "Verified findings. ".repeat(truncated ? 180 : 1);
  const client = await mocks.connect();
  client.subscribeToSessionEvents = (_: string, callback: (event: unknown) => void) => {
    queueMicrotask(() => {
      callback({ method: "event.message_chunk", params: { sessionId: "session", delta: summary } });
      callback({ method: "event.agent_status", params: { sessionId: "session", status: "idle", turnEvent: { type: "turn_failed", payload: { turnId: "budget-turn", code: "task_budget", message: truncated ? summary.slice(0, 2000) : summary } } } });
    });
    return () => {};
  };
  expect(await oneShotCLI("check", [], { lightMode: true })).toBe(1);
  expect(writes.join("")).toContain(summary);
  const stderr = vi.mocked(process.stderr.write).mock.calls.map(([chunk]) => String(chunk)).join("");
  expect(stderr).not.toContain("Partial result: stopped at the task budget.");
});


it("qv honors an invocation-scoped custom endpoint during startup model validation", async () => {
  vi.stubEnv("OPENAI_BASE_URL", "");
  const f = invocationFixture("custom-startup-env");
  writeFileSync(join(f.context.env.AGENC_HOME!, "config.toml"), 'config_version = 2\nmodel = "private-deployment"\nmodel_provider = "openai"\n');
  f.context.env.OPENAI_BASE_URL = "http://localhost:8765/v1";
  const code = await f.run();
  expect(f.output().stderr).not.toContain("unknown model");
  expect(code).toBe(0);
  expect(f.call).toHaveBeenCalledWith("agent.create", expect.objectContaining({ model: "private-deployment" }), expect.anything());
});


it.each([false, true])("starts an uncatalogued saved model without an explicit model flag (profile=%s)", async profile => {
  const f = invocationFixture("saved-model");
  writeFileSync(join(f.context.env.AGENC_HOME!, "config.toml"),
    'config_version = 2\nmodel_provider = "deepseek"\n' +
    (profile ? 'model = "deepseek-flash"\n[profiles.legacy]\n' : '') +
    'model = "retired-deepseek-model"\n');
  const context = { ...f.context, argv: [...f.context.argv.slice(0, -1), ...(profile ? ["--profile", "legacy"] : []), "saved-model"] };
  expect(await oneShotCLI("saved-model", [], undefined, undefined, f.overrides, context)).toBe(0);
  expect(f.output().stderr).not.toContain("unknown model");
  expect(f.call).toHaveBeenCalledWith("agent.create", expect.objectContaining({ model: "retired-deepseek-model" }), expect.anything());
});

it.each(["deepseek-flsh", "deepseek:deepseek-flsh"])("refuses an explicit launch typo %s before agent creation", async model => {
  const f = invocationFixture("explicit-typo");
  const context = { ...f.context, argv: [...f.context.argv.slice(0, -1), "--provider", "deepseek", "--model", model, "explicit-typo"] };
  expect(await oneShotCLI("explicit-typo", [], undefined, undefined, f.overrides, context)).toBe(1);
  expect(f.output().stderr).toContain("did you mean 'deepseek-flash'?");
  expect(f.call).not.toHaveBeenCalled();
});

it("accepts an explicit private launch model at the invocation-scoped endpoint", async () => {
  vi.stubEnv("OPENAI_BASE_URL", "");
  const f = invocationFixture("explicit-custom");
  f.context.env.OPENAI_BASE_URL = "http://localhost:8765/v1";
  const context = {
    ...f.context,
    argv: [...f.context.argv.slice(0, -1), "--provider", "openai", "--model", "private-deployment", "explicit-custom"],
  };
  expect(await oneShotCLI("explicit-custom", [], undefined, undefined, f.overrides, context)).toBe(0);
  expect(f.output().stderr).not.toContain("unknown model");
  expect(f.call).toHaveBeenCalledWith("agent.create", expect.objectContaining({ model: "private-deployment" }), expect.anything());
});

it.each([
  ["no flag and no light_mode starts Light", [] as string[], undefined, true],
  ["--light alone is the default, Light", ["--light"], undefined, true],
  ["--standard starts standard", ["--standard"], undefined, false],
  ["light_mode = false starts standard", [], false, false],
  ["light_mode = true starts Light", [], true, true],
  ["--light wins over light_mode = false", ["--light"], false, true],
  ["--standard wins over light_mode = true", ["--standard"], true, false],
])("settles a fresh print session's mode: %s", async (_label, flags, configured, expected) => {
  if (configured !== undefined) {
    writeFileSync(join(home, "config.toml"), `config_version = 2\nlight_mode = ${configured}\n`);
  }
  process.argv = ["node", "agenc", "-p", ...flags, "hello"];
  expect(await oneShotCLI("hello")).toBe(0);
  const created = request.mock.calls.find(([method]) => method === "agent.create");
  expect(created?.[1]).toMatchObject({ runtimeOptions: expect.objectContaining({ lightMode: expected }) });
});

it("sends only an explicit mode flag when continuing, so the session keeps its recorded mode", async () => {
  writeFileSync(join(home, "config.toml"), "config_version = 2\nlight_mode = false\n");
  process.argv = ["node", "agenc", "-c", "-p", "next"];
  expect(await oneShotCLI("next", [], undefined, { kind: "latest" })).toBe(23);
  expect(mocks.continuation.mock.calls[0]?.[0].runtimeOptions).not.toHaveProperty("lightMode");
  process.argv = ["node", "agenc", "-c", "-p", "--standard", "next"];
  expect(await oneShotCLI("next", [], undefined, { kind: "latest" })).toBe(23);
  expect(mocks.continuation.mock.calls[1]?.[0].runtimeOptions).toMatchObject({ lightMode: false });
});
