import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgenCDaemonAutostartOptions } from "../../src/app-server/daemon-autostart.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(), processMain: vi.fn(), trust: vi.fn(), enabled: vi.fn(),
  ensure: vi.fn(), cwd: vi.fn(), unavailable: vi.fn(),
}));
vi.mock("../../src/bin/cli-runtime.js", () => ({ prepareCliRuntime: mocks.prepare }));
vi.mock("../../src/bin/cli-process-main.js", () => ({ runCliProcessMain: mocks.processMain }));
vi.mock("../../src/bin/project-trust-preflight.js", () => ({ requireProjectTrustForTui: mocks.trust }));
vi.mock("../../src/bin/cli-cwd.js", () => ({ resolveCliCwdForStartup: mocks.cwd, writeUnavailableCliCwd: mocks.unavailable }));
vi.mock("../../src/app-server/daemon-autostart.js", () => ({
  ensureAgenCDaemonAutostart: mocks.ensure, resolveAgenCDaemonAutostartEnabled: mocks.enabled,
}));
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
  mocks.prepare.mockReturnValue(null);
  mocks.trust.mockResolvedValue(true);
  mocks.enabled.mockResolvedValue(true);
  mocks.cwd.mockReturnValue({ ok: true, cwd: "/workspace" });
  mocks.unavailable.mockReturnValue(1);
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
  });

  it("keeps stdout-TTY autostart fallback and the canonical argument values", async () => {
    vi.stubEnv("AGENC_DAEMON_AUTOSTART_FAILURE", "");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    mocks.ensure.mockRejectedValue(new Error("offline"));
    process.argv = ["node", "/install/bin/agenc.js", "-p", "--full-durability", "--image", "file.png", "--", "--help"];
    await expect(printMain(load)).resolves.toBe(7);
    expect(process.env.AGENC_DAEMON_AUTOSTART_FAILURE).toBe("offline");
    expect(client.oneShotCLI).toHaveBeenCalledExactlyOnceWith("--help", ["file.png"], expect.objectContaining({ fullDurability: true }), undefined);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("retains the common error formatter and stream drain entry boundary", () => {
    const result = Promise.resolve();
    mocks.processMain.mockReturnValue(result);
    expect(runPrintCliEntry()).toBe(result);
    expect(mocks.processMain).toHaveBeenCalledExactlyOnceWith(printMain);
  });
});
