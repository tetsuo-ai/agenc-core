import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAdmittedExecutionCall } from "../../src/execution/call-context.js";
import { runDockerBoundRipgrep, type BoundRipgrepInput } from "../../src/execution/docker-ripgrep.js";
import type { DockerExecutionProcesses } from "../../src/execution/docker-process.js";
import { ExecutionEnvironmentError, type ExecutionProcess, type ExecutionProcessSpecification } from "../../src/execution/types.js";

const bindings = { cwd: { workerId: "a".repeat(32), handle: 1 } };
const defaults: BoundRipgrepInput = { program: "/usr/bin/rg", args: ["--no-config", "--no-follow", "pattern"],
  env: {}, timeoutMs: 2000, maxOutputBytes: 10000 };
function fixture(parts: { stdout?: Buffer; stderr?: Buffer }[] = [], live = false) {
  let cursor = 0;
  let stopped = false;
  const boundaries = vi.fn();
  const process: ExecutionProcess = {
    operationId: "b".repeat(32), sessionId: 1234, specification: {} as ExecutionProcessSpecification,
    inspect: vi.fn(async () => ({ operationId: "b".repeat(32), leaderExited: true,
      outputComplete: !live || stopped, cleanupProven: !live || stopped, exitCode: stopped ? 137 : 0 })),
    output: vi.fn(async (offset) => {
      expect(offset).toBe(cursor);
      const part = parts.shift();
      const stdout = part?.stdout ?? Buffer.alloc(0), stderr = part?.stderr ?? Buffer.alloc(0);
      cursor += stdout.length + stderr.length;
      return { stdout, stderr, nextOffset: cursor };
    }),
    write: vi.fn(async (_identity, _bytes, _eof, dispatch) => { dispatch?.crossEffectBoundary(); }),
    terminate: vi.fn(async () => { stopped = true; return { terminated: true, cleanupProven: true }; }),
    resize: vi.fn(),
  };
  const launch = vi.fn(async (_spec, _identity, dispatch) => { dispatch.crossEffectBoundary(); return process; });
  const owner = { launch } as unknown as DockerExecutionProcesses;
  const admitted = <T>(action: () => Promise<T>) => withAdmittedExecutionCall({ runId: "run", callId: "search", attempt: 1 },
    { signal: new AbortController().signal, crossEffectBoundary: boundaries }, action);
  const run = (input: Partial<BoundRipgrepInput> = {}) => admitted(() => runDockerBoundRipgrep(owner, "/app", bindings, { ...defaults, ...input }));
  return { process, launch, owner, admitted, run, boundaries };
}

it("drains retained binary output and gives every input chunk and EOF an admitted coordinate", async () => {
  const f = fixture([{ stdout: Buffer.from([0, 255]), stderr: Buffer.from("α") }, { stdout: Buffer.from("tail") }]);
  const input = Buffer.alloc(131075, 255);
  const result = await f.run({ stdin: input, argv0: "alternate", env: { ONLY: "explicit" } });
  expect(result).toMatchObject({ stdout: Buffer.from([0, 255, ...Buffer.from("tail")]), stderr: Buffer.from("α"), exitCode: 0 });
  const writes = vi.mocked(f.process.write).mock.calls;
  expect(Buffer.concat(writes.map((call) => call[1]))).toEqual(input);
  expect(writes.map((call) => [call[0].operationIndex, call[2]])).toEqual([[1, false], [2, false], [3, true]]);
  expect(f.boundaries).toHaveBeenCalledTimes(4);
  expect(f.launch.mock.calls[0][0]).toMatchObject({ environment: { ONLY: "explicit" }, argv0: "alternate", cwd: "/app" });
  expect(f.process.output).toHaveBeenCalledTimes(3);
  expect(f.process.terminate).not.toHaveBeenCalled();
});

it("does not settle on leader exit or report a limit result before strict cleanup completes", async () => {
  const f = fixture([{ stdout: Buffer.from("one\ntwo\n") }], true);
  let release!: () => void;
  const original = vi.mocked(f.process.terminate).getMockImplementation()!;
  vi.mocked(f.process.terminate).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return original();
  });
  const done = f.run({ lineLimit: 1 });
  let settled = false;
  void done.then(() => { settled = true; });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(settled).toBe(false);
  release();
  expect(await done).toMatchObject({ killedAfterLimit: true, exitCode: 137 });
});

it("preserves structured exclusions and line windows while stopping managed descendants", async () => {
  const f = fixture([{ stdout: Buffer.from("excluded\0first\0second\0third\0") }], true);
  const result = await f.run({ structuredLineLimit: { outputMode: "files_with_matches", maximumLines: 1,
    maximumRecordBytes: 128, skipLines: 1, excludedPaths: ["excluded"] } });
  expect(result.stdout).toEqual(Buffer.from("second\0"));
  expect(result.killedAfterLimit).toBe(true);
  expect(result.processedLines).toBe(3);
  expect(f.process.terminate).toHaveBeenCalledTimes(1);
});

it("treats malformed structured output as data and cleans up its managed process", async () => {
  const f = fixture([{ stdout: Buffer.from("globalThis.taskOutputWasExecuted = true\n") }], true);
  const result = await f.run({ structuredLineLimit: { outputMode: "content", maximumLines: 10, maximumRecordBytes: 1024 } });
  expect(result.spawnError?.message).toMatch(/MALFORMED_JSON/);
  expect("taskOutputWasExecuted" in globalThis).toBe(false);
  expect(f.process.terminate).toHaveBeenCalledTimes(1);
});

it("spools raw stdout outside its diagnostic byte budget and refuses an existing spool", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agenc-bound-search-"));
  try {
    const path = join(directory, "output");
    const f = fixture([{ stdout: Buffer.alloc(100, 255), stderr: Buffer.from("err") }]);
    const result = await f.run({ stdoutSpoolPath: path, maxSpoolBytes: 200, maxOutputBytes: 3 });
    expect(result.spooledBytes).toBe(100);
    expect(result.stdout).toHaveLength(0);
    expect(result.stderr).toEqual(Buffer.from("err"));
    expect(await readFile(path)).toEqual(Buffer.alloc(100, 255));
    const second = fixture();
    await expect(second.run({ stdoutSpoolPath: path, maxSpoolBytes: 200 })).rejects.toMatchObject({ code: "EEXIST" });
    expect(second.launch).not.toHaveBeenCalled();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each(["timeout", "aborted"])("awaits cleanup on %s while keeping leader exit separate from output completion", async (reason) => {
  const f = fixture([], true);
  const signal = new AbortController();
  const promise = f.run({ timeoutMs: reason === "timeout" ? 10 : 2000, signal: signal.signal });
  if (reason === "aborted") { await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce()); signal.abort(); }
  expect(await promise).toMatchObject({ stopReason: reason, aborted: reason === "aborted", exitCode: 137 });
  expect(f.process.terminate).toHaveBeenCalledTimes(1);
});

it("never resends input after a lost acknowledgement", async () => {
  const f = fixture([], true);
  vi.mocked(f.process.write).mockRejectedValueOnce(new ExecutionEnvironmentError("unknown_outcome", "lost input ack", true));
  await expect(f.run({ stdin: Buffer.from("effect") })).rejects.toMatchObject({ code: "unknown_outcome" });
  expect(f.process.write).toHaveBeenCalledTimes(1);
  expect(f.launch).toHaveBeenCalledTimes(1);
  expect(f.process.terminate).toHaveBeenCalledTimes(1);
});

it("keeps cleanup failure explicit and does not fabricate complete output after environment loss", async () => {
  const f = fixture([], true);
  vi.mocked(f.process.terminate).mockRejectedValue(new ExecutionEnvironmentError("cleanup_unproven", "scope unavailable", true));
  await expect(f.run({ timeoutMs: 5 })).rejects.toMatchObject({ message: "Bound search failed and cleanup was not proved" });
  const lost = fixture();
  vi.mocked(lost.process.inspect).mockResolvedValue({ operationId: lost.process.operationId, leaderExited: true,
    cleanupProven: true, outputComplete: false, exitCode: null, failure: "Docker daemon died" });
  await expect(lost.run()).rejects.toMatchObject({ code: "output_incomplete" });
});

it("rejects follow flags, cancelled admission and contradictory input before launching", async () => {
  const f = fixture();
  for (const args of [["--follow"], ["-nL"]]) await expect(f.run({ args })).rejects.toMatchObject({ requestSent: false });
  await expect(f.run({ signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "aborted", requestSent: false });
  await expect(f.admitted(() => runDockerBoundRipgrep(f.owner, "/app", { ...bindings, stdin: bindings.cwd },
    { ...defaults, stdin: "replacement" }))).rejects.toMatchObject({ requestSent: false });
  expect(f.launch).not.toHaveBeenCalled();
});
