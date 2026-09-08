import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ execFileSync: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: dependencies.execFileSync,
}));

import {
  BOUNDED_COMMAND_TIMEOUT_MS,
  METADATA_COMMAND_SETTLEMENT_TIMEOUT_MS,
  METADATA_COMMAND_WORKER_OVERHEAD_MS,
  runBoundedCommandText,
} from "../../benchmarks/fnd/provenance.mjs";

const RUNTIME_ROOT = join(import.meta.dirname, "../..");
const PRIVATE_MARKER = "/private/operator-workspace/hidden-command";

beforeEach(() => {
  dependencies.execFileSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function commandFailure() {
  try {
    runBoundedCommandText(process.execPath, ["--version"], {
      cwd: RUNTIME_ROOT,
      label: "resolve benchmark source revision",
    });
  } catch (error) {
    return error;
  }
  throw new Error("expected the metadata command to fail");
}

function workerResponse(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    backstopExpired: false,
    exitCode: 0,
    signal: null,
    stderrBase64: "",
    stdoutBase64: Buffer.from("ready\n").toString("base64"),
    workerElapsedMs: 0,
    ...overrides,
  });
}

describe("bounded metadata command diagnostics", () => {
  test.each([
    {
      phase: "command_timeout",
      response: { stopReason: "timeout", exitCode: null, signal: "SIGKILL" },
    },
    {
      phase: "settlement_failed",
      response: { backstopExpired: true, stopReason: "timeout", exitCode: null },
    },
    {
      phase: "command_failed",
      response: { error: PRIVATE_MARKER, exitCode: null },
    },
    {
      phase: "command_stopped",
      response: { stopReason: "output_limit", exitCode: null },
    },
  ])("retains $phase without exposing command paths", ({ phase, response }) => {
    dependencies.execFileSync.mockReturnValue(workerResponse(response));
    const failure = commandFailure();
    expect(failure).toMatchObject({
      message: expect.stringContaining("resolve benchmark source revision"),
      metadataCommand: {
        phase,
        commandTimeoutMs: 5_000,
        workerTimeoutMs: 9_000,
        elapsedMs: expect.any(Number),
        workerElapsedMs: 0,
        backstopExpired: response.backstopExpired ?? false,
        stopReason: response.stopReason ?? null,
      },
    });
    expect(String(failure)).toContain(phase);
    expect(String(failure)).not.toContain(PRIVATE_MARKER);
  });

  test.each([
    { code: "ETIMEDOUT", phase: "worker_timeout" },
    { code: "EACCES", phase: "worker_failed" },
  ])("distinguishes $phase from the child deadline", ({ code, phase }) => {
    dependencies.execFileSync.mockImplementation(() => {
      throw Object.assign(new Error(PRIVATE_MARKER), { code });
    });
    const failure = commandFailure();
    expect(failure).toMatchObject({
      metadataCommand: {
        phase,
        commandTimeoutMs: 5_000,
        workerTimeoutMs: 9_000,
        elapsedMs: expect.any(Number),
        workerElapsedMs: null,
        backstopExpired: null,
        stopReason: null,
      },
    });
    expect(String(failure)).toContain(phase);
    expect(String(failure)).not.toContain(PRIVATE_MARKER);
    expect((failure as Error).cause?.toString()).not.toContain(PRIVATE_MARKER);
  });

  test.each([
    { workerElapsedMs: -1 },
    { workerElapsedMs: Infinity },
    { workerElapsedMs: "slow" },
    { stopReason: PRIVATE_MARKER },
    { signal: PRIVATE_MARKER },
  ])("rejects invalid worker metadata %j", (response) => {
    dependencies.execFileSync.mockReturnValue(workerResponse(response));
    expect(commandFailure()).toMatchObject({
      metadataCommand: { phase: "protocol_error" },
    });
  });

  test("keeps the child deadline separate from delayed helper startup", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
    const startupDelayMs = 1_100;
    const timeoutMs = 1_000;
    const delayModule = `data:text/javascript,${encodeURIComponent(
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${startupDelayMs});`,
    )}`;
    let observedResponse: unknown;
    dependencies.execFileSync.mockImplementation((command, args, options) => {
      expect(JSON.parse(options.input).timeoutMs).toBe(timeoutMs);
      expect(options.stdio).toBe("pipe");
      expect(options.timeout).toBe(
        timeoutMs + METADATA_COMMAND_SETTLEMENT_TIMEOUT_MS + METADATA_COMMAND_WORKER_OVERHEAD_MS,
      );
      const output = actual.execFileSync(command, ["--import", delayModule, ...args], options);
      observedResponse = JSON.parse(String(output));
      return output;
    });

    expect(runBoundedCommandText(process.execPath, ["-e", 'process.stdout.write("ready")'], {
      cwd: RUNTIME_ROOT,
      timeoutMs,
    })).toBe("ready");
    expect(observedResponse).toMatchObject({
      backstopExpired: false,
      exitCode: 0,
      workerElapsedMs: expect.any(Number),
    });
    expect(BOUNDED_COMMAND_TIMEOUT_MS).toBe(5_000);
  });

  test("serializes the macOS native slice without enabling its workflow", () => {
    const workflow = readFileSync(join(RUNTIME_ROOT, "../.github/workflows/platform-tests.yml"), "utf8");
    const nativeStep = workflow.split("- name: Run the exact macOS FND/native capability lane")[1]?.split("\n      - name:")[0];
    expect(nativeStep).toContain("--maxWorkers=1");
  });
});
