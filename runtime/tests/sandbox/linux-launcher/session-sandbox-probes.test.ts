import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSandbox } from "../../../src/sandbox/linux-launcher/session-sandbox.js";
import * as direct from "../../../src/sandbox/linux-launcher/direct-bwrap.js";
import * as probes from "../../../src/sandbox/linux-launcher/probe-cache.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
});

describe("session sandbox startup probes", () => {
  it("offers identity-bound cached probe evidence to a new namespace and invalidates a declined plan", async () => {
    const input = { program: process.execPath, args: ["launcher", "--", "/bin/true"], cwd: process.cwd(), env: {} };
    const hintedArgs = ["launcher", "--bwrap-capability-hint", "evidence", "--", "/bin/true"];
    const invalidate = vi.fn();
    const prepareHint = vi.spyOn(probes, "prepareLinuxSandboxProbeHint").mockReturnValue({ args: hintedArgs, invalidate });
    const preparePlan = vi.spyOn(direct, "prepareSessionBwrapPlan").mockReturnValue(undefined);
    const sandbox = new SessionSandbox();
    try {
      expect(await sandbox.spawn(input, () => {})).toBeUndefined();
      expect(prepareHint).toHaveBeenCalledWith(input.args, input.cwd, input.env);
      expect(preparePlan).toHaveBeenCalledWith({ ...input, args: hintedArgs });
      expect(invalidate).toHaveBeenCalledOnce();
    } finally { await sandbox.close(); }
  });

  it("keeps the ordinary planner on a cache miss", async () => {
    const input = { program: process.execPath, args: ["launcher", "--", "/bin/true"], cwd: process.cwd(), env: {} };
    vi.spyOn(probes, "prepareLinuxSandboxProbeHint").mockReturnValue(undefined);
    const prepare = vi.spyOn(direct, "prepareSessionBwrapPlan").mockReturnValue(undefined);
    const sandbox = new SessionSandbox();
    try {
      expect(await sandbox.spawn(input, () => {})).toBeUndefined();
      expect(prepare).toHaveBeenCalledWith(input);
    } finally { await sandbox.close(); }
  });
});
