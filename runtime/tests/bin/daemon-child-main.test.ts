import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  order: [] as string[], ingress: vi.fn(), harden: vi.fn(),
  parse: vi.fn(), run: vi.fn(), processMain: vi.fn(),
}));
vi.mock("../../src/config/environment-ingress.js", () => ({ assertCanonicalEnvironmentIngress: mocks.ingress }));
vi.mock("../../src/sandbox/hardening/index.js", () => ({ applyBestEffortPreMainProcessHardening: mocks.harden }));
vi.mock("../../src/app-server/daemon-control.js", () => ({ parseAgenCDaemonCliArgs: mocks.parse, runAgenCDaemonCli: mocks.run }));
vi.mock("../../src/bin/cli-process-main.js", () => ({ runCliProcessMain: mocks.processMain }));
vi.mock("../../src/bin/agenc-main.js", () => { throw new Error("general CLI must remain unloaded"); });
import { detachedDaemonMain, runDetachedDaemonChildEntry } from "../../src/bin/daemon-child-main.js";

const savedArgv = process.argv;
const command = { kind: "command", action: "run" };
beforeEach(() => {
  vi.resetAllMocks(); mocks.order.length = 0;
  process.argv = ["node", "/install/bin/agenc", "daemon", "start", "--foreground"];
  mocks.ingress.mockImplementation(() => { mocks.order.push("ingress"); });
  mocks.harden.mockImplementation(() => { mocks.order.push("harden"); });
  mocks.parse.mockImplementation(() => { mocks.order.push("parse"); return command; });
  mocks.run.mockImplementation(async () => { mocks.order.push("run"); return 7; });
});
afterEach(() => { process.argv = savedArgv; vi.restoreAllMocks(); });

describe("detached daemon entry", () => {
  it("retains ingress/hardening before canonical parsing and foreground dispatch", async () => {
    expect(await detachedDaemonMain()).toBe(7);
    expect(mocks.order).toEqual(["ingress", "harden", "parse", "run"]);
    expect(mocks.ingress).toHaveBeenCalledWith(process.env);
    expect(mocks.parse).toHaveBeenCalledWith(["daemon", "start", "--foreground"]);
    expect(mocks.run).toHaveBeenCalledWith(command, { enterDaemonHome: true });
  });
  it("rejects invalid environment before hardening, parsing or daemon startup", async () => {
    mocks.ingress.mockImplementation(() => { throw new Error("retired input"); });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await detachedDaemonMain()).toBe(2);
    expect(stderr).toHaveBeenCalledWith("agenc: retired input\n");
    expect(mocks.harden).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });
  it("propagates daemon failures to the shared error and drain boundary", async () => {
    const error = new Error("identity conflict"); mocks.run.mockRejectedValue(error);
    await expect(detachedDaemonMain()).rejects.toBe(error);
    const promise = Promise.resolve(); mocks.processMain.mockReturnValue(promise);
    expect(runDetachedDaemonChildEntry()).toBe(promise);
    expect(mocks.processMain).toHaveBeenCalledWith(detachedDaemonMain);
  });
});
