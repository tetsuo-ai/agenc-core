import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgenCDaemonAutostartOptions } from "../../src/app-server/daemon-autostart.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(), processMain: vi.fn(), trust: vi.fn(), enabled: vi.fn(),
  ensure: vi.fn(), cwd: vi.fn(), unavailable: vi.fn(), flush: vi.fn(), begin: vi.fn(), stop: vi.fn(),
  scope: vi.fn(), identity: vi.fn(), closeScope: vi.fn(), scopeReady: vi.fn(), scopeConnect: vi.fn(),
}));
vi.mock("../../src/bin/compile-cache.js", () => ({ flushAgenCCompileCache: mocks.flush, beginProgressiveAgenCCompileCachePublication: mocks.begin }));
vi.mock("../../src/bin/cli-runtime.js", () => ({ prepareCliRuntime: mocks.prepare }));
vi.mock("../../src/bin/cli-process-main.js", () => ({ runCliProcessMain: mocks.processMain }));
vi.mock("../../src/bin/project-trust-preflight.js", () => ({ requireProjectTrustForTui: mocks.trust }));
vi.mock("../../src/bin/cli-cwd.js", () => ({ resolveCliCwdForStartup: mocks.cwd, writeUnavailableCliCwd: mocks.unavailable }));
vi.mock("../../src/app-server/daemon-autostart.js", () => ({
  ensureAgenCDaemonAutostart: mocks.ensure, resolveAgenCDaemonAutostartEnabled: mocks.enabled,
}));
vi.mock("../../src/app-server/daemon-print-connection.js", () => ({ createDaemonPrintConnectionScope: mocks.scope }));
vi.mock("../../src/bin/daemon-one-shot-cli.js", () => ({ oneShotCLI: (...args: unknown[]) => client.oneShotCLI(...args as []) }));
vi.mock("../../src/bin/agenc-main.js", () => { throw new Error("client must be lazy"); });
import { printMain, runPrintCliEntry } from "../../src/bin/print-cli-main.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const savedArgv = process.argv;
const savedStdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const savedStdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const client = {
  bootTUIEntry: vi.fn(async () => 31), resumeTUIEntry: vi.fn(async () => 32),
  continueTUIEntry: vi.fn(async () => 33), oneShotCLI: vi.fn(async () => 7),
};
const load = vi.fn(async () => client);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.begin.mockReturnValue(mocks.stop);
  mocks.prepare.mockReturnValue(null);
  mocks.trust.mockResolvedValue(true);
  mocks.enabled.mockResolvedValue(true);
  mocks.cwd.mockReturnValue({ ok: true, cwd: "/workspace" });
  mocks.unavailable.mockReturnValue(1);
  mocks.scope.mockReturnValue({ requestDaemonInstanceIdentity: mocks.identity,
    ensureDaemonReady: mocks.scopeReady, createConnectedTuiClient: mocks.scopeConnect, close: mocks.closeScope });
  mocks.identity.mockResolvedValue({}); mocks.closeScope.mockResolvedValue(undefined);
  mocks.ensure.mockImplementation(async (options: AgenCDaemonAutostartOptions) => {
    options.onReadinessWaitStarted?.();
  });
  load.mockImplementation(async () => client);
  process.argv = ["node", "/install/bin/agenc.js", "-p", "--light", "hello"];
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => {
  process.argv = savedArgv;
  for (const [stream, descriptor] of [[process.stdin, savedStdinTTY], [process.stdout, savedStdoutTTY]] as const) {
    if (descriptor === undefined) delete stream.isTTY;
    else Object.defineProperty(stream, "isTTY", descriptor);
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("print entry import overlap", () => {
  it("publishes the completed client import while readiness is still pending", async () => {
    const ready = deferred<void>();
    const entered = deferred<void>();
    const imported = deferred<typeof client>();
    load.mockReturnValue(imported.promise);
    mocks.ensure.mockImplementation(async (options: AgenCDaemonAutostartOptions) => {
      options.onReadinessWaitStarted?.();
      entered.resolve();
      await ready.promise;
      options.onReadinessWaitStarted?.();
    });
    const running = printMain(load);
    await entered.promise;
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(mocks.begin).toHaveBeenCalledOnce();
    expect(mocks.stop).not.toHaveBeenCalled();
    imported.resolve(client);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(client.oneShotCLI).not.toHaveBeenCalled();
    ready.resolve();
    expect(await running).toBe(7);
    expect(load).toHaveBeenCalledOnce();
    expect(mocks.flush).toHaveBeenCalledOnce();
  });

  it.each(["import", "readiness"])("waits for trust and both gates when %s finishes first", async (first) => {
    const trust = deferred<boolean>();
    const ready = deferred<void>();
    const entered = deferred<void>();
    const imported = deferred<typeof client>();
    mocks.trust.mockReturnValue(trust.promise);
    load.mockReturnValue(imported.promise);
    mocks.ensure.mockImplementation(async (options: AgenCDaemonAutostartOptions) => {
      options.onReadinessWaitStarted?.();
      options.onReadinessWaitStarted?.(); // bounded autostart restart notifications
      entered.resolve();
      await ready.promise;
    });
    const running = printMain(load);
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    trust.resolve(true);
    await entered.promise;
    expect(load).toHaveBeenCalledTimes(1);
    expect(client.oneShotCLI).not.toHaveBeenCalled();
    if (first === "import") imported.resolve(client);
    else ready.resolve();
    await Promise.resolve();
    expect(client.oneShotCLI).not.toHaveBeenCalled();
    imported.resolve(client);
    ready.resolve();
    await expect(running).resolves.toBe(7);
    expect(load).toHaveBeenCalledTimes(1);
    expect(client.oneShotCLI).toHaveBeenCalledExactlyOnceWith("hello", [], expect.objectContaining({ lightMode: true }), undefined);
    expect(client.bootTUIEntry).not.toHaveBeenCalled();
  });

  it.each(["disabled", "no notification"])("loads at dispatch when autostart is %s", async (mode) => {
    mocks.enabled.mockResolvedValue(mode !== "disabled");
    mocks.ensure.mockResolvedValue(undefined);
    await expect(printMain(load)).resolves.toBe(7);
    expect(load).toHaveBeenCalledTimes(1);
    expect(mocks.ensure).toHaveBeenCalledTimes(mode === "disabled" ? 0 : 1);
  });

  it.each(["ingress", "trust", "cwd", "parser"])("does not load or spawn on %s refusal", async (mode) => {
    if (mode === "ingress") mocks.prepare.mockReturnValue(2);
    if (mode === "trust") mocks.trust.mockResolvedValue(false);
    if (mode === "cwd") mocks.cwd.mockReturnValue({ ok: false });
    if (mode === "parser") process.argv.push("--ignored-prompt-token");
    if (mode === "parser") process.argv.splice(3, 0, "--deadline=invalid");
    expect(await printMain(load)).toBe(mode === "ingress" || mode === "parser" ? 2 : 1);
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(client.oneShotCLI).not.toHaveBeenCalled();
    if (mode !== "trust") expect(mocks.trust).not.toHaveBeenCalled();
  });

  it.each(["synchronous", "asynchronous", "undefined"])("observes %s import failure while readiness is pending", async (mode) => {
    const error = mode === "undefined" ? undefined : new Error("client import failed");
    const imported = deferred<void>();
    const ready = deferred<void>();
    load.mockImplementation(() => {
      imported.resolve();
      if (mode === "synchronous") throw error;
      return Promise.reject(error);
    });
    mocks.ensure.mockImplementation(async (options: AgenCDaemonAutostartOptions) => {
      options.onReadinessWaitStarted?.();
      await ready.promise;
    });
    const running = printMain(load);
    const observed = expect(running).rejects.toBe(error);
    await imported.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(client.oneShotCLI).not.toHaveBeenCalled();
    ready.resolve();
    await observed;
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it.each(["import first", "autostart first"])("keeps the autostart failure authoritative: %s", async (order) => {
    const imported = deferred<typeof client>();
    load.mockReturnValue(imported.promise);
    mocks.ensure.mockImplementation(async (options: AgenCDaemonAutostartOptions) => {
      options.onReadinessWaitStarted?.();
      if (order === "import first") {
        imported.reject(new Error("import"));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      throw new Error("authenticated identity refused");
    });
    await expect(printMain(load)).resolves.toBe(1);
    imported.reject(new Error("import"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith("agenc: daemon autostart failed: authenticated identity refused\n");
    expect(client.oneShotCLI).not.toHaveBeenCalled();
    expect(mocks.flush).not.toHaveBeenCalled();
  });

  it("keeps stdout-TTY autostart fallback and the canonical argument values", async () => {
    vi.stubEnv("AGENC_DAEMON_AUTOSTART_FAILURE", "");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    mocks.ensure.mockRejectedValue(new Error("offline"));
    process.argv = ["node", "/install/bin/agenc.js", "-p", "--light", "--image", "file.png", "--", "--help"];
    await expect(printMain(load)).resolves.toBe(7);
    expect(process.env.AGENC_DAEMON_AUTOSTART_FAILURE).toBe("offline");
    expect(client.oneShotCLI).toHaveBeenCalledExactlyOnceWith("--help", ["file.png"], expect.objectContaining({ lightMode: true }), undefined);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("retains the common error formatter and stream drain entry boundary", () => {
    const result = Promise.resolve();
    mocks.processMain.mockReturnValue(result);
    expect(runPrintCliEntry()).toBe(result);
    expect(mocks.processMain).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
  });
});


describe("exploratory provisional route coordination", () => {
  const provisional = () => ({ cancel: vi.fn(async () => {}), finish: vi.fn(async (
    _io: unknown, ready?: () => void, admission?: () => void | Promise<void>,
  ) => { void admission?.(); ready?.(); }) });
  it("shares one handled import across admission and readiness without early dispatch", async () => {
    const child = provisional();
    const entered = deferred<void>();
    const acknowledged = deferred<void>();
    const imported = deferred<typeof client>();
    load.mockReturnValue(imported.promise);
    child.finish.mockImplementation(async (_io, ready, admission) => {
      void admission?.();
      entered.resolve();
      await acknowledged.promise;
      ready?.(); ready?.();
    });
    const running = printMain(load, async () => child);
    await entered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(load).toHaveBeenCalledOnce();
    imported.resolve(client);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(client.oneShotCLI).not.toHaveBeenCalled();
    acknowledged.resolve();
    expect(await running).toBe(7);
    expect(load).toHaveBeenCalledOnce();
    expect(client.oneShotCLI).toHaveBeenCalledOnce();
  });
  it("keeps failed admission authoritative over an earlier preload rejection", async () => {
    const child = provisional();
    load.mockRejectedValue(new Error("client import failed"));
    child.finish.mockImplementation(async (_io, _ready, admission) => {
      void admission?.();
      await new Promise<void>(resolve => setImmediate(resolve));
      throw new Error("admission failed");
    });
    expect(await printMain(load, async () => child)).toBe(1);
    expect(load).toHaveBeenCalledOnce();
    expect(child.cancel).toHaveBeenCalledOnce();
    expect(process.stderr.write).toHaveBeenCalledExactlyOnceWith("agenc: daemon autostart failed: admission failed\n");
    expect(client.oneShotCLI).not.toHaveBeenCalled();
  });
  it("starts before canonical trust, then admits only after acceptance", async () => {
    const child = provisional();
    const trust = deferred<boolean>();
    const enteredTrust = deferred<void>();
    const prepare = vi.fn(async () => child);
    mocks.trust.mockImplementation(() => { enteredTrust.resolve(); return trust.promise; });
    const run = printMain(load, prepare);
    await enteredTrust.promise;
    expect(prepare).toHaveBeenCalledOnce();
    expect(child.finish).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    trust.resolve(true);
    expect(await run).toBe(7);
    expect(child.finish).toHaveBeenCalledOnce();
    expect(child.cancel).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it("joins refusal cleanup before returning the original exit code", async () => {
    const child = provisional();
    const exit = deferred<void>();
    const cancelling = deferred<void>();
    child.cancel.mockImplementation(() => { cancelling.resolve(); return exit.promise; });
    mocks.trust.mockResolvedValue(false);
    let done = false;
    const run = printMain(load, async () => child).then(code => { done = true; return code; });
    await cancelling.promise;
    expect(done).toBe(false);
    expect(child.finish).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    exit.resolve();
    expect(await run).toBe(1);
    expect(process.stderr.write).not.toHaveBeenCalled();
  });
  it("cancels if the authoritative post-trust config disables autostart", async () => {
    const child = provisional();
    mocks.enabled.mockResolvedValue(false);
    expect(await printMain(load, async () => child)).toBe(7);
    expect(child.cancel).toHaveBeenCalledOnce();
    expect(child.finish).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it("preserves trust errors after exact cleanup", async () => {
    const child = provisional();
    const failure = new Error("canonical malformed project config");
    mocks.trust.mockRejectedValue(failure);
    await expect(printMain(load, async () => child)).rejects.toBe(failure);
    expect(child.cancel).toHaveBeenCalledOnce();
    expect(child.finish).not.toHaveBeenCalled();
  });
  it("joins cancellation and preserves full config validation failure after a provisional hint", async () => {
    const child = provisional();
    const failure = new Error("canonical invalid global configuration");
    const exit = deferred<void>();
    const cancelling = deferred<void>();
    child.cancel.mockImplementation(() => { cancelling.resolve(); return exit.promise; });
    mocks.enabled.mockRejectedValueOnce(failure);
    let settled = false;
    const run = printMain(load, async () => child).finally(() => { settled = true; });
    const observed = expect(run).rejects.toBe(failure);
    await cancelling.promise;
    expect(settled).toBe(false);
    expect(child.finish).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
    exit.resolve();
    await observed;
    expect(child.cancel).toHaveBeenCalledOnce();
  });
  it("keeps failed cleanup visible", async () => {
    const child = provisional();
    mocks.trust.mockResolvedValue(false);
    child.cancel.mockRejectedValue(new Error("exact exit unavailable"));
    await expect(printMain(load, async () => child)).rejects.toThrow("exact exit unavailable");
    expect(child.finish).not.toHaveBeenCalled();
  });
  it.each(["tty", "debug", "cwd", "parser"])("does not speculate for %s", async kind => {
    const prepare = vi.fn(async () => provisional());
    if (kind === "tty") Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    if (kind === "debug") vi.stubEnv("TUI_E2E_DEBUG", "1");
    if (kind === "cwd") mocks.cwd.mockReturnValue({ ok: false });
    if (kind === "parser") process.argv.splice(3, 0, "--deadline=invalid");
    await printMain(load, prepare);
    expect(prepare).not.toHaveBeenCalled();
  });
});


it("the default print loader reaches the thin client without loading the full CLI dispatcher", async () => {
  expect(await printMain()).toBe(7);
  expect(client.oneShotCLI).toHaveBeenCalledWith("hello", [], expect.objectContaining({ lightMode: true }), undefined);
});

it("lends the route identity connection only to fresh native print and closes its scope", async () => {
  mocks.ensure.mockImplementation(async (options: AgenCDaemonAutostartOptions) => {
    options.onReadinessWaitStarted?.();
    await options.requestDaemonInstanceIdentity?.({ pid: 5200, pidPath: "/test/pid" });
  });
  expect(await printMain()).toBe(7);
  expect(mocks.scope).toHaveBeenCalledOnce(); expect(mocks.identity).toHaveBeenCalledOnce();
  expect(client.oneShotCLI).toHaveBeenCalledWith("hello", [], expect.anything(), undefined, {
    ensureDaemonReady: mocks.scopeReady, createConnectedTuiClient: mocks.scopeConnect,
  });
  expect(mocks.closeScope).toHaveBeenCalledOnce();
});

it.each(["custom", "continue", "disabled", "provisional"])("does not retain a connection for %s", async mode => {
  mocks.ensure.mockImplementation(async (options: AgenCDaemonAutostartOptions) => {
    expect(options.requestDaemonInstanceIdentity).toBeUndefined();
    options.onReadinessWaitStarted?.();
  });
  if (mode === "continue") process.argv.splice(3, 0, "--continue");
  if (mode === "disabled") mocks.enabled.mockResolvedValue(false);
  const child = { finish: vi.fn(async () => {}), cancel: vi.fn(async () => {}) };
  expect(await printMain(mode === "custom" ? load : undefined, mode === "provisional" ? async () => child : undefined)).toBe(7);
  expect(mocks.scope).not.toHaveBeenCalled();
});

it("closes an unused connection when native print refuses configuration", async () => {
  mocks.ensure.mockImplementation(async (options: AgenCDaemonAutostartOptions) => {
    await options.requestDaemonInstanceIdentity?.({ pid: 5200, pidPath: "/test/pid" });
  });
  client.oneShotCLI.mockResolvedValueOnce(1);
  expect(await printMain()).toBe(1); expect(mocks.closeScope).toHaveBeenCalledOnce();
});

it("preserves canonical readiness error precedence and closes its partial allocation", async () => {
  mocks.ensure.mockImplementation(async (options: AgenCDaemonAutostartOptions) => {
    await options.requestDaemonInstanceIdentity?.({ pid: 5200, pidPath: "/test/pid" });
    throw new Error("canonical identity refused");
  });
  expect(await printMain()).toBe(1); expect(mocks.closeScope).toHaveBeenCalledOnce();
  expect(client.oneShotCLI).not.toHaveBeenCalled();
  expect(process.stderr.write).toHaveBeenCalledWith("agenc: daemon autostart failed: canonical identity refused\n");
});
