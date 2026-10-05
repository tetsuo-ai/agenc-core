import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { format } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrintInvocation, validatePrintInvokeParams } from "../../src/app-server/print-invocation.js";
import { runDefaultCliRoute } from "../../src/bin/default-cli-route.js";
import { oneShotCLI } from "../../src/bin/daemon-one-shot-cli.js";
import { cliStartupErrorMessage } from "../../src/bin/cli-process-main.js";
import { trustProject } from "../../src/permissions/trust/project-trust.js";
import type { AgenCJsonLineDaemonTuiClient } from "../../src/app-server/agent-cli.js";
import type { AgenCDaemonMethod, AgenCDaemonResponse, JsonObject, PrintInvokeParams } from "../../src/app-server/protocol/index.js";
import type { AgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { permissionProfileForSandboxMode } from "../../src/tools/runtimes/sandboxing.js";
import { canWritePathWithCwd, getWritableRootsWithCwd } from "../../src/sandbox/engine/policy.js";

let home: string, cwd: string;
const originalArgv = process.argv;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "resident-print-")); cwd = join(home, "repo"); mkdirSync(cwd);
  writeFileSync(join(home, "config.toml"), 'config_version = 2\nmodel = "test-model"\nmodel_provider = "deepseek"\n');
  vi.stubEnv("HOME", home); vi.stubEnv("AGENC_HOME", home); vi.stubEnv("AGENC_WORKSPACE", cwd); vi.stubEnv("AGENC_DAEMON_AUTOSTART", "0");
  // These in-process flag goldens share one explicit temp authority. The
  // fresh-process caller-authority cases below clear this override to test
  // OS fallback without depending on Vitest's import/setup ordering.
  vi.stubEnv("AGENC_TMPDIR", join(home, "session-temp"));
  await trustProject({ agencHome: home, env: process.env, projectRoot: cwd });
});
afterEach(() => { process.argv = originalArgv; vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

function params(argv = ["-p", "hello"], extra: Partial<PrintInvokeParams> = {}): PrintInvokeParams {
  return validatePrintInvokeParams({ invocationId: "run", argv, cwd,
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    caller: { pid: process.pid, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false }, ...extra });
}
function events(deny = false): JsonObject[] {
  return [
    ...(deny ? [{ method: "event.permission_request", params: { sessionId: "session", requestId: "permission" } }] : []),
    { method: "event.message_chunk", params: { sessionId: "session", delta: "π hello" } },
    { method: "event.agent_status", params: { sessionId: "session", status: "idle", runStatus: "completed" } },
  ];
}
function requests() {
  return vi.fn(async (method: AgenCDaemonMethod, _params: JsonObject): Promise<AgenCDaemonResponse> => {
    const result = method === "agent.create" ? { agentId: "agent", sessionId: "session" }
      : method === "agent.attach" ? { sessionIds: ["session"] }
      : method === "session.snapshot" ? { tokenUsage: { input: 1, output: 2 } } : {};
    return { jsonrpc: "2.0", id: "nested", result } as AgenCDaemonResponse;
  });
}
async function canonical(argv: string[], deny = false, replay = events(deny)) {
  let stdout = "", stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { stdout += String(chunk); return true; });
  const err = vi.spyOn(process.stderr, "write").mockImplementation(chunk => { stderr += String(chunk); return true; });
  // Vitest intercepts console.warn before process.stderr; include the actual
  // CLI console bytes when collecting the canonical golden output.
  const warn = vi.spyOn(console, "warn").mockImplementation((...args) => { stderr += `${format(...args)}\n`; });
  const call = requests();
  const client = {
    request: async (method: AgenCDaemonMethod, p: JsonObject) => { const response = await call(method, p); return (response as { result: unknown }).result; },
    close: async () => {}, subscribeToConnectionState: () => () => {},
    subscribeToSessionEvents: (_id: string, cb: (event: JsonObject) => void) => { queueMicrotask(() => replay.forEach(cb)); return () => {}; },
  } as unknown as AgenCJsonLineDaemonTuiClient;
  process.argv = ["node", "agenc", ...argv];
  let exitCode = 1;
  try {
    exitCode = await runDefaultCliRoute(process.argv, {
      bootTUIEntry: async () => { throw new Error("unexpected TUI"); }, resumeTUIEntry: async () => 99, continueTUIEntry: async () => 99,
      oneShotCLI: (prompt, images, flags, resume) => oneShotCLI(prompt, images, flags, resume, {
        ensureDaemonReady: () => async () => {}, createConnectedTuiClient: async () => client,
      }),
    });
  } catch (error) { stderr += `agenc: ${cliStartupErrorMessage(error)}\n`; }
  finally { out.mockRestore(); err.mockRestore(); warn.mockRestore(); }
  return { stdout, stderr, exitCode, call };
}
function resident(request: PrintInvokeParams, { deny = false, admit = true, complete = true } = {}) {
  let stdout = "", stderr = "";
  let challenge!: string;
  let challenged!: () => void;
  const admission = new Promise<void>(resolve => { challenged = resolve; });
  const call = requests();
  let invocation: PrintInvocation;
  invocation = new PrintInvocation({ home,
    send: async message => {
      const p = message.params as JsonObject;
      if (message.method === "print.admission") {
        challenge = String(p.challenge); challenged();
        if (admit) invocation.admit(challenge);
      } else if (message.method === "print.output") {
        if (p.stream === "stdout") stdout += String(p.data); else stderr += String(p.data);
        invocation.acknowledge(p.sequence as number);
      }
    },
    request: async (method, p) => {
      const response = await call(method, p);
      if (method === "agent.attach" && complete) {
        // Replay before subscribe, just as a fast canonical attached turn can.
        for (const event of events(deny)) await invocation.event(event);
      }
      return response;
    },
  }, request);
  return { invocation, call, admission, challenge: () => challenge, output: () => ({ stdout, stderr }) };
}

describe("canonical/resident print byte and exit parity", () => {
  const cases = [
    ["-p", "hello"], ["-p", "--light", "hello"], ["-p", "--bare", "hello"],
    ["-p", "--full-durability", "hello"],
    ...["default", "plan", "acceptEdits", "bypassPermissions"].map(mode => ["-p", "--permission-mode", mode, "hello"]),
    ["-p", "--dangerously-bypass-approvals-and-sandbox", "hello"],
    ["-p", "--model", "chosen", "--provider", "deepseek", "hello"],
    ["-p", "--output-format", "json", "hello"], ["-p", "--output-format", "stream-json", "hello"],
    ["-p", "--output-format", "bad", "hello"], ["-p", "--input-format", "bad", "hello"],
    ["-p", "--permission-mode", "bad", "hello"], ["-p", "--deadline", "bad", "hello"],
    ["-p", "--profile", "missing", "hello"], ["-p", "--config", "/missing-config.toml", "hello"],
    ["-p", "--image", "/missing-image.png", "hello"], ["-p", "/goal status"],
    ["-p", "--bypass-approvals", "--permission-mode", "plan", "hello"],
    ["-p", "--", "--permission-mode", "bad"],
  ];
  it.each(cases.map(argv => [argv.join(" "), argv] as const))("matches %s", async (_label, argv) => {
    const expected = await canonical([...argv]);
    const f = resident(params([...argv]));
    const result = await f.invocation.run();
    expect({ ...f.output(), ...result }).toEqual({ kind: "exit", exitCode: expected.exitCode, stdout: expected.stdout, stderr: expected.stderr });
    expect(f.call.mock.calls).toEqual(expected.call.mock.calls);
  });
  it.each(["text", "json", "stream-json"])("matches denied-tool output and status for %s", async format => {
    const argv = ["-p", "--output-format", format, "hello"];
    const expected = await canonical(argv, true); const f = resident(params(argv), { deny: true });
    const result = await f.invocation.run();
    expect({ ...f.output(), ...result }).toEqual({ kind: "exit", exitCode: 2, stdout: expected.stdout, stderr: expected.stderr });
    expect(f.call.mock.calls.some(([method]) => method === "tool.deny")).toBe(true);
  });
  it.each(["text", "json", "stream-json"])("matches the 9,521-event long-run shape in %s", async format => {
    // GD's 20-tool smoke retained 9,521 event_msg records: 21 model calls,
    // 8,400 thinking deltas and 641 answer deltas. Keep that cardinality and
    // multi-megabyte structured result without committing a machine rollout.
    const replay: JsonObject[] = Array.from({ length: 8400 }, (_, index) => ({
      method: "event.session", params: { sessionId: "session", event: {
        type: "assistant_thinking_delta", payload: { index: 0, delta: `think-${index} ` + "r".repeat(192) },
      } },
    }));
    for (let i = 0; i < 641; i++) replay.push({ method: "event.message_chunk", params: { sessionId: "session", delta: "π🌍 step " } });
    for (let i = 0; i < 20; i++) replay.push({ method: "event.session", params: { sessionId: "session", event: {
      type: "tool_call_completed", payload: { callId: `tool-${i}`, toolName: "exec_command", result: "done", isError: false },
    } } });
    while (replay.length < 9520) replay.push({ method: "event.session", params: { sessionId: "session", event: {
      type: "session_usage", payload: { modelCalls: 21, totalTokens: 23100 },
    } } });
    replay.push(events()[1]!);
    expect(replay).toHaveLength(9521);
    const argv = ["-p", "--output-format", format, "hello"];
    const expected = await canonical(argv, false, replay);
    const f = resident(params(argv), { complete: false });
    const run = f.invocation.run();
    await vi.waitFor(() => expect(f.call.mock.calls.some(([method]) => method === "agent.attach")).toBe(true));
    for (const event of replay) await f.invocation.event(event);
    const result = await run;
    expect({ ...f.output(), ...result }).toEqual({ kind: "exit", exitCode: expected.exitCode, stdout: expected.stdout, stderr: expected.stderr });
    expect(expected.exitCode).toBe(0);
    if (format !== "text") expect(Buffer.byteLength(expected.stdout)).toBeGreaterThan(2 * 1024 * 1024);
  });
  it.each(["text", "json", "stream-json"])("preserves denied-tool status after a large %s result", async format => {
    const replay = events(true);
    (replay[1]!.params as JsonObject).delta = "x".repeat(2 * 1024 * 1024) + "π🌍";
    const argv = ["-p", "--output-format", format, "hello"];
    const expected = await canonical(argv, true, replay);
    const f = resident(params(argv), { complete: false });
    const run = f.invocation.run();
    await vi.waitFor(() => expect(f.call.mock.calls.some(([method]) => method === "agent.attach")).toBe(true));
    for (const event of replay) await f.invocation.event(event);
    const result = await run;
    expect({ ...f.output(), ...result }).toEqual({ kind: "exit", exitCode: 2, stdout: expected.stdout, stderr: expected.stderr });
    expect(expected.exitCode).toBe(2);
  });
  it("preserves warning bytes and multiplicity without daemon-global stderr", async () => {
    vi.stubEnv("AGENC_MAX_OUTPUT_TOKENS", "invalid");
    const expected = await canonical(["-p", "hello"]);
    const leaked: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(chunk => { leaked.push(String(chunk)); return true; });
    const f = resident(params()); const result = await f.invocation.run(); spy.mockRestore();
    expect({ ...f.output(), ...result }).toEqual({ kind: "exit", exitCode: expected.exitCode, stdout: expected.stdout, stderr: expected.stderr });
    expect(expected.stderr).toContain("AGENC_MAX_OUTPUT_TOKENS"); expect(leaked).toEqual([]);
  });
  it("refuses an untrusted repository before any admission or agent", async () => {
    rmSync(join(home, "trusted-projects.json"));
    // A repo that ships a hook needs review; one that ships nothing would be
    // trusted automatically and reach admission.
    mkdirSync(join(cwd, ".agenc"));
    writeFileSync(join(cwd, ".agenc", "config.toml"), 'config_version = 2\n[[hooks.Stop]]\nhooks = [{ type = "command", command = "./notify.sh" }]\n');
    const argv = ["-p", "--output-format", "bad", "hello"];
    const expected = await canonical(argv); const f = resident(params(argv));
    expect(await f.invocation.run()).toEqual({ kind: "exit", exitCode: 1 });
    expect(f.output()).toEqual({ stdout: expected.stdout, stderr: expected.stderr });
    expect(f.output().stderr).toContain("project is not trusted"); expect(f.challenge()).toBeUndefined(); expect(f.call).not.toHaveBeenCalled();
  });
});

// Use a fresh process with the client environment installed BEFORE module
// import. An in-process thin call would reuse this test daemon's captured OS
// temp fallback and hide the production A-daemon/B-client regression.
function thinRuntimeAuthority(env: Readonly<Record<string, string>>):
  { options: AgentRuntimeOptions } | { error: string } {
  const moduleUrl = new URL("../../src/session/runtime-options.ts", import.meta.url).href;
  const script = `
    import { resolveAgentRuntimeOptions } from ${JSON.stringify(moduleUrl)};
    try {
      const options = resolveAgentRuntimeOptions(process.env, {
        nonInteractive: true, exactOutput: false, relaxedOneShot: true,
      });
      process.stdout.write(JSON.stringify({ options }));
    } catch (error) { process.stdout.write(JSON.stringify({ error: error.message })); }
  `;
  return JSON.parse(execFileSync(process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { env: { ...env, TSX_DISABLE_CACHE: "1" }, encoding: "utf8", timeout: 20_000 }));
}

function clientEnvironment(): Record<string, string> {
  const env = { ...params().env };
  for (const key of ["AGENC_TMPDIR", "TMPDIR", "TMP", "TEMP"]) delete env[key];
  return env;
}

function createdRuntimeOptions(call: ReturnType<typeof requests>): AgentRuntimeOptions {
  const create = call.mock.calls.find(([method]) => method === "agent.create");
  expect(create).toBeDefined();
  return create![1].runtimeOptions as unknown as AgentRuntimeOptions;
}

describe.skipIf(process.platform === "win32")("micro caller sandbox authority", () => {
  it.skipIf(process.platform !== "linux")("matches caller helper refusal and bypass notice despite a different daemon helper", async () => {
    vi.stubEnv("AGENC_TMPDIR", join(home, "client-temp"));
    vi.stubEnv("AGENC_LINUX_SANDBOX_EXE", join(home, "missing-client-helper"));
    const argv = ["-p", "--bypass-approvals", "hello"];
    const request = params(argv);
    const expected = await canonical(argv);
    expect(expected.stderr).toContain("missing-client-helper");
    vi.stubEnv("AGENC_LINUX_SANDBOX_EXE", join(home, "missing-daemon-helper"));
    const f = resident(request);
    expect(await f.invocation.run()).toEqual({ kind: "exit", exitCode: expected.exitCode });
    expect(f.output()).toEqual({ stdout: expected.stdout, stderr: expected.stderr });
    expect(f.call.mock.calls).toEqual(expected.call.mock.calls);
    expect(process.env.AGENC_LINUX_SANDBOX_EXE).toBe(join(home, "missing-daemon-helper"));
  });

  it.each(["TMPDIR", "TMP", "TEMP", "empty", "absent", "explicit", "symlink"])(
    "matches fresh thin process authority for %s without borrowing daemon temp", async selection => {
      const env = clientEnvironment(), clientTemp = join(home, "client-temp");
      mkdirSync(clientTemp);
      if (selection === "TMPDIR" || selection === "TMP" || selection === "TEMP") {
        env[selection] = `${clientTemp}//`;
        if (selection !== "TEMP") env.TEMP = join(home, "lower-precedence-temp");
        if (selection === "TMPDIR") env.TMP = join(home, "lower-precedence-tmp");
      } else if (selection === "empty") {
        env.TMPDIR = ""; env.TMP = ""; env.TEMP = clientTemp;
      } else if (selection === "explicit") {
        env.AGENC_TMPDIR = clientTemp; env.TMPDIR = "relative-platform-temp";
      } else if (selection === "symlink") {
        const alias = join(home, "client-alias"); symlinkSync(clientTemp, alias);
        env.TMPDIR = alias;
      }
      const expected = thinRuntimeAuthority(env);
      expect(expected).toHaveProperty("options");
      if (!("options" in expected)) throw new Error(expected.error);
      expect(expected.options.sessionTempRoot).toBe(realpathSync(selection === "absent" ? "/tmp" : clientTemp));
      vi.stubEnv("TMPDIR", join(home, "daemon-temp"));
      vi.stubEnv("AGENC_TMPDIR", join(home, "daemon-authority"));
      const daemonEnv = { ...process.env };
      const f = resident(params(undefined, { env }));
      expect(await f.invocation.run()).toEqual({ kind: "exit", exitCode: 0 });
      const actual = createdRuntimeOptions(f.call);
      expect(actual).toEqual(expected.options);
      expect(process.env).toEqual(daemonEnv);
      const profile = permissionProfileForSandboxMode("workspace_write", { cwd }).fileSystem;
      expect(getWritableRootsWithCwd(profile, cwd, actual.sessionTempRoot))
        .toEqual(getWritableRootsWithCwd(profile, cwd, expected.options.sessionTempRoot));
    }, 30_000,
  );

  it.each(["relative", "whitespace", "file", "empty-explicit"])(
    "preserves thin refusal bytes for %s before admission or agent creation", async selection => {
      const env = clientEnvironment();
      if (selection === "relative") env.TMPDIR = "relative-temp";
      if (selection === "whitespace") env.TMPDIR = ` ${join(home, "client-temp")}`;
      if (selection === "file") { env.TMPDIR = join(home, "temp-file"); writeFileSync(env.TMPDIR, "file"); }
      if (selection === "empty-explicit") { env.AGENC_TMPDIR = ""; env.TMPDIR = join(home, "client-temp"); }
      const expected = thinRuntimeAuthority(env);
      expect(expected).toHaveProperty("error");
      if (!("error" in expected)) throw new Error("Expected thin refusal");
      const f = resident(params(undefined, { env }));
      expect(await f.invocation.run()).toEqual({ kind: "exit", exitCode: 1 });
      expect(f.output()).toEqual({ stdout: "", stderr: `agenc: ${expected.error}\n` });
      expect(f.challenge()).toBeUndefined(); expect(f.call).not.toHaveBeenCalled();
    }, 30_000,
  );

  it("isolates concurrent callers' complete runtime authorities and write/deny sets", async () => {
    const base = clientEnvironment();
    const clients = ["b", "c"].map(label => ({ ...base,
      TMPDIR: join(home, label, "temp"), AGENC_PLUGIN_CACHE_DIR: join(home, label, "plugins"),
      AGENC_SHELL: label === "b" ? "/bin/bash" : "/bin/zsh",
      AGENC_SHELL_PREFIX: `env CALLER=${label}`,
      AGENC_REMOTE: label === "b" ? "1" : "0",
      AGENC_REMOTE_MEMORY_DIR: join(home, label, "remote-memory"),
      AGENC_COWORK_MEMORY_PATH_OVERRIDE: join(home, label, "cowork-memory"),
      AGENC_COWORK_MEMORY_EXTRA_GUIDELINES: label,
      AGENC_ALLOW_UNTRUSTED_HOOKS: label === "b" ? "1" : "0",
      AGENC_USE_DATA_STDIN: label === "b" ? "1" : "0",
    }));
    const expected = clients.map(env => thinRuntimeAuthority(env));
    for (const result of expected) expect(result).toHaveProperty("options");
    for (const [key, value] of Object.entries(clients[1]!)) {
      if (key.startsWith("AGENC_") && !["AGENC_HOME", "AGENC_WORKSPACE", "AGENC_DAEMON_AUTOSTART"].includes(key)) {
        // Defaults and explicit caller values must not observe daemon-only knobs.
        vi.stubEnv(key, value);
      }
    }
    vi.stubEnv("TMPDIR", join(home, "daemon-temp"));
    vi.stubEnv("AGENC_TMPDIR", join(home, "daemon-authority"));
    const daemonEnv = { ...process.env };
    const fixtures = clients.map(env => resident(params(undefined, { env }), { admit: false }));
    const runs = fixtures.map(f => f.invocation.run());
    await Promise.all(fixtures.map(f => f.admission));
    for (const f of fixtures) { expect(f.call).not.toHaveBeenCalled(); f.invocation.admit(f.challenge()); }
    expect(await Promise.all(runs)).toEqual([{ kind: "exit", exitCode: 0 }, { kind: "exit", exitCode: 0 }]);
    const profile = permissionProfileForSandboxMode("workspace_write", { cwd }).fileSystem;
    for (const [index, f] of fixtures.entries()) {
      const thin = expected[index]!;
      if (!("options" in thin)) throw new Error(thin.error);
      const actual = createdRuntimeOptions(f.call);
      expect(actual).toEqual(thin.options);
      const temp = clients[index]!.TMPDIR, other = clients[1 - index]!.TMPDIR;
      const probes = [join(temp, "ok"), join(other, "no"), join(home, "daemon-temp/no"), join(cwd, "ok"), join(cwd, ".git/config"), join(home, "config.toml")];
      const writes = (root: string) => probes.map(target => canWritePathWithCwd(profile, target, cwd, root));
      expect(writes(actual.sessionTempRoot)).toEqual(writes(thin.options.sessionTempRoot));
      expect(writes(actual.sessionTempRoot)).toEqual([true, false, false, true, false, false]);
    }
    expect(process.env).toEqual(daemonEnv);
  }, 30_000);
});

describe("admission and cancellation", () => {
  it("does not create before one-use admission and rejects a stale challenge", async () => {
    const f = resident(params(), { admit: false }); const run = f.invocation.run();
    await f.admission; expect(f.call).not.toHaveBeenCalled();
    expect(() => f.invocation.admit("wrong")).toThrow("invalid"); expect(f.call).not.toHaveBeenCalled();
    f.invocation.admit(f.challenge());
    expect(() => f.invocation.admit(f.challenge())).toThrow("invalid");
    expect(await run).toEqual({ kind: "exit", exitCode: 0 });
  });
  it("disconnect before admission creates nothing and revokes the challenge", async () => {
    const f = resident(params(), { admit: false }); const run = f.invocation.run();
    await f.admission; await f.invocation.close();
    expect(await run).toEqual({ kind: "exit", exitCode: 130 }); expect(f.call).not.toHaveBeenCalled();
    expect(() => f.invocation.admit(f.challenge())).toThrow("invalid");
  });
  it.each([0, 130])("cancels an admitted invocation with exit %i and joins owned-agent cleanup", async exitCode => {
    const f = resident(params(), { complete: false }); const run = f.invocation.run();
    await vi.waitFor(() => expect(f.call.mock.calls.some(([method]) => method === "agent.attach")).toBe(true));
    f.invocation.cancel({ reason: exitCode === 0 ? "broken_pipe" : "signal", exitCode });
    expect(await run).toEqual({ kind: "exit", exitCode });
    expect(f.call).toHaveBeenCalledWith("agent.stop", { agentId: "agent", reason: "one_shot_cancelled" });
  });
  it.each([[ ["-p"] ], [ ["-c", "hello"] ]])("falls back without output, stdin, trust or agent for %j", async argv => {
    const f = resident(params(argv)); expect(await f.invocation.run()).toEqual({ kind: "fallback" });
    expect(f.output()).toEqual({ stdout: "", stderr: "" }); expect(f.call).not.toHaveBeenCalled();
  });
  it("validates and snapshots the envelope without exposing its environment values", () => {
    const p = params(); const env = { ...p.env }; const parsed = validatePrintInvokeParams({ ...p, env });
    env.PATH = "changed"; expect(parsed.env.PATH).not.toBe("changed");
    expect(() => validatePrintInvokeParams({ ...p, env: { KEY: "secret\0value" } })).toThrow(/^invalid print invocation envelope$/);
    expect(() => validatePrintInvokeParams({ ...p, cwd: "relative" })).toThrow("invalid");
  });
});
