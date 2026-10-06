import * as childProcess from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";

import { failingExecFile } from "../helpers/failed-spawn-child.js";

// The CSV job supervisor's process-start query (ps on darwin) handed its
// AbortSignal to execFile, and so to spawn. Node's own abort handler then
// calls child.kill() even while a failed spawn is still waiting to report,
// and that pid-less handle sends the kill to pid 0: the caller's whole
// process group. The stand-in handles `signal` as Node does, but only
// records the kill.

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

const { createCsvProcessIdentityProbe } = await import(
  "../../src/state/csv-agent-jobs.js"
);
const actualExecFile = (
  await vi.importActual<typeof import("node:child_process")>("node:child_process")
).execFile;
const execFileMock = vi.mocked(childProcess.execFile);

afterEach(() => {
  execFileMock.mockReset();
  execFileMock.mockImplementation(actualExecFile);
});

describe("CSV process identity query abort", () => {
  test("an abort in the same tick as the failed ps spawn signals nothing", async () => {
    const failures = failingExecFile({ code: "EAGAIN" });
    execFileMock.mockImplementation(failures.execFile as never);
    const controller = new AbortController();

    // The probe reaches the ps query synchronously: execFile has been called
    // when this returns, and the abort below lands in the same tick.
    const probe = createCsvProcessIdentityProbe({
      platform: "darwin",
      pid: 424_242,
      signalProcess: () => undefined,
      signal: controller.signal,
    });
    controller.abort();
    await probe.catch(() => undefined);
    await Promise.all(failures.children.map((child) => child.reported));

    expect(failures.children).toHaveLength(1);
    expect(failures.children[0]!.spawnargs).toContain("lstart=");
    expect(failures.children[0]!.groupSignals).toEqual([]);
    expect(failures.children[0]!.uncaught).toEqual([]);
  });
});
