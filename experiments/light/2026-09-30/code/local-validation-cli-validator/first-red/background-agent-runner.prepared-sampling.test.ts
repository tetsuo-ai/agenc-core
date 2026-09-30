import { afterEach, describe, expect, it, vi } from "vitest";
import * as bootstrapModule from "../../src/bin/bootstrap.js";
import { AgenCDelegateBackgroundAgentRunner } from "../../src/app-server/background-agent-runner.js";
import { runAgenCDaemonForeground } from "../../src/app-server/daemon-cli.js";
import type { PreparedSamplingValidator } from "../../src/session/prepared-sampling-evidence.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";

afterEach(() => vi.restoreAllMocks());

describe("trusted runner prepared-sampling forwarding", () => {
  it.each([true, false])("captures supplied=%s constructor authority for both start and restore", async supplied => {
    const sentinel = new Error("stop at canonical bootstrap boundary");
    // Spy on the default function; do NOT pass options.bootstrap. This preserves
    // the runner's canonical sandbox-required branch, while preventing startup.
    const bootstrap = vi.spyOn(bootstrapModule, "bootstrapLocalRuntimeSession").mockRejectedValue(sentinel);
    const selected: PreparedSamplingValidator = () => undefined;
    const replacement: PreparedSamplingValidator = () => { throw new Error("not selected"); };
    const options = { ...(supplied ? { validatePreparedSampling: selected } : {}), env: {}, argv: ["node", "agenc"] };
    const runner = new AgenCDelegateBackgroundAgentRunner(options);
    Object.assign(options, { validatePreparedSampling: replacement });
    runner.updateRuntimeConfig({});
    const runtimeOptions = resolveAgentRuntimeOptions({}, { lightMode: true });
    await expect(runner.startAgent({ objective: "fixture", deferInitialTurn: true, runtimeOptions, unattendedAllow: [], unattendedDeny: [] })).rejects.toBe(sentinel);
    await expect(runner.restoreAgent({ agentId: "fixture-restored", objective: "fixture", explicitColdResume: true, runtimeOptions })).rejects.toBe(sentinel);
    expect(bootstrap).toHaveBeenCalledTimes(2);
    for (const [input] of bootstrap.mock.calls) {
      expect(input.requireSandboxReadyAtStartup).toBe(true);
      expect(input.executionAdmissionAutonomous).toBe(true);
      if (supplied) expect(input.validatePreparedSampling).toBe(selected);
      else expect(input).not.toHaveProperty("validatePreparedSampling");
    }
    expect(bootstrap.mock.calls[1]?.[0]).toMatchObject({ conversationId: "fixture-restored", resumeConversation: true });
  });

  it("foreground rejects validator plus custom runner before any host/lifecycle access", async () => {
    const touched = vi.fn(() => { throw new Error("foreground side effect before refusal"); });
    const host = new Proxy({}, { get: touched }) as Parameters<typeof runAgenCDaemonForeground>[0];
    const io = new Proxy({}, { get: touched }) as Parameters<typeof runAgenCDaemonForeground>[1];
    const runner = new Proxy({}, { get: touched }) as NonNullable<Parameters<typeof runAgenCDaemonForeground>[2]>["runner"];
    await expect(runAgenCDaemonForeground(host, io, { enterDaemonHome: true, runner, validatePreparedSampling: () => undefined }))
      .rejects.toThrow("Prepared sampling validation requires the canonical daemon runner");
    expect(touched).not.toHaveBeenCalled();
  });
});
