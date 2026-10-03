import { afterEach, describe, expect, it, vi } from "vitest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const savedSend = Object.getOwnPropertyDescriptor(process, "send");
const savedConnected = Object.getOwnPropertyDescriptor(process, "connected");
afterEach(() => {
  for (const [key, descriptor] of [["send", savedSend], ["connected", savedConnected]] as const) {
    if (descriptor) Object.defineProperty(process, key, descriptor);
    else Reflect.deleteProperty(process, key);
  }
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function fixture() {
  vi.resetModules();
  const events: string[] = [];
  const importing = deferred<void>();
  const imported = deferred<void>();
  const allowImport = deferred<void>();
  const decision = deferred<{ kind: "admitted" | "aborted" }>();
  const cancelled = deferred<void>();
  let cancellationRequested = false;
  const release = vi.fn(async () => { events.push("release"); });
  const guard = {
    requested: cancelled.promise,
    wasRequested: () => cancellationRequested,
    acknowledgeAfterCleanup: vi.fn(async () => { events.push("cleanup-ack"); }),
  };
  const admission = {
    decision: decision.promise,
    abort: vi.fn(() => decision.resolve({ kind: "aborted" })),
    close: vi.fn(),
  };
  const host = { env: {}, userHome: "/daemon-home", pid: 321 };
  const foreground = vi.fn(async (_command, options) => {
    events.push("foreground");
    expect(options.host.startupGuardReceiver).toBe(guard);
    expect(options.enterDaemonHome).toBe(true);
    await options.releaseProvisionalLifecycleLock();
    return 0;
  });
  const removePid = vi.fn(async (path: string, pid: number) => {
    events.push("remove-pid");
    expect(path).toBe("/daemon-home/daemon.pid");
    expect(pid).toBe(321);
  });
  vi.doMock("../../src/app-server/daemon-startup-guard.js", () => ({
    takeAgenCDaemonStartupGuardToken: () => "private-test-token",
    createAgenCDaemonStartupGuardReceiver: () => guard,
  }));
  vi.doMock("../../src/app-server/daemon-provisional-admission.js", () => ({
    AGENC_DAEMON_PROVISIONAL_ENV: "AGENC_DAEMON_PROVISIONAL_START",
    createAgenCProvisionalAdmissionReceiver: () => admission,
  }));
  vi.doMock("../../src/bin/cli-process-main.js", () => ({
    runCliProcessMain: async (main: () => Promise<number>) => { await main(); },
  }));
  vi.doMock("../../src/bin/cli-runtime.js", () => ({ prepareCliRuntime: () => null }));
  vi.doMock("../../src/app-server/daemon-control.js", () => ({
    createNodeDaemonCliHost: () => host,
    acquireAgenCDaemonLifecycleLock: async () => { events.push("lock"); return release; },
    resolveAgenCDaemonPidPath: () => "/daemon-home/daemon.pid",
    removeAgenCDaemonPid: removePid,
    runAgenCDaemonCli: foreground,
  }));
  vi.doMock("../../src/app-server/daemon-cli.js", async () => {
    events.push("import-begin"); importing.resolve();
    await allowImport.promise;
    events.push("import-end"); imported.resolve();
    return {};
  });
  const send = vi.fn((_message, callback: (error: Error | null) => void) => {
    events.push("admission-ack"); callback(null); return true;
  });
  Object.defineProperty(process, "send", { configurable: true, value: send });
  Object.defineProperty(process, "connected", { configurable: true, value: true });
  vi.stubEnv("AGENC_DAEMON_PROVISIONAL_START", "1");
  const { runProvisionalDaemonChildEntry } = await import("../../src/bin/daemon-provisional-child-main.js");
  return {
    events, importing, imported, allowImport, decision, release, guard, admission, send,
    foreground, removePid, run: runProvisionalDaemonChildEntry,
    cancel() { cancellationRequested = true; cancelled.resolve(); },
  };
}

describe("provisional foreground import gate", () => {
  it("loads while admission is pending, retaining the lock and deferring foreground execution", async () => {
    const f = await fixture();
    const running = f.run();
    await f.importing.promise;
    expect(f.events).toEqual(["lock", "import-begin"]);
    f.allowImport.resolve(); await f.imported.promise;
    expect(f.foreground).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    f.decision.resolve({ kind: "admitted" });
    await running;
    expect(f.events).toEqual(["lock", "import-begin", "import-end", "admission-ack", "foreground", "release"]);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.removePid).not.toHaveBeenCalled();
  });

  it.each([false, true])("cleans exact ownership when cancelled during import, including queued ADMIT=%s", async (admitFirst) => {
    const f = await fixture();
    const running = f.run();
    await f.importing.promise;
    if (admitFirst) f.decision.resolve({ kind: "admitted" });
    f.cancel();
    f.allowImport.resolve();
    await running;
    expect(f.foreground).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.events).toEqual(["lock", "import-begin", "import-end", "remove-pid", "release", "cleanup-ack"]);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.guard.acknowledgeAfterCleanup).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.admission.close).toHaveBeenCalledOnce();
  });

  it("releases the lock and propagates import failure without acknowledging admission", async () => {
    const f = await fixture();
    const error = new Error("foreground import failed");
    const running = f.run();
    const observed = expect(running).rejects.toBe(error);
    await f.importing.promise;
    f.allowImport.reject(error);
    await observed;
    expect(f.foreground).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.admission.close).toHaveBeenCalledOnce();
  });
});
