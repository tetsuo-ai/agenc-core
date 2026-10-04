import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PhaseEvent } from "../../src/phases/events.js";
import type { Terminal } from "../../src/session/turn-state.js";
import type { RunSingleTurnOpts } from "../../src/bin/local-turn-runtime.js";

type LocalRuntime = typeof import("../../src/bin/local-turn-runtime.js");
type Cli = typeof import("../../src/bin/agenc-main.js");

const lazy = vi.hoisted(() => ({
  evaluations: 0,
  run: vi.fn<LocalRuntime["runSingleTurn"]>(),
  prepare: vi.fn<LocalRuntime["prepareTurnRuntimeInputs"]>(),
}));

// Only replace the newly lazy boundary, not agenc-main or its import graph.
// An accidental eager import invokes this factory during the CLI import and
// fails the boundary assertion. No local turn/provider is executed here.
vi.mock("../../src/bin/local-turn-runtime.js", () => {
  lazy.evaluations++;
  return { runSingleTurn: lazy.run, prepareTurnRuntimeInputs: lazy.prepare };
});

let cli: Cli;
let evaluationsAfterCliImport: number;

beforeAll(async () => {
  const previous = process.env.AGENC_CLI_ENTRY_DISABLE;
  process.env.AGENC_CLI_ENTRY_DISABLE = "1";
  try {
    cli = await import("../../src/bin/agenc-main.js");
    evaluationsAfterCliImport = lazy.evaluations;
  } finally {
    if (previous === undefined) delete process.env.AGENC_CLI_ENTRY_DISABLE;
    else process.env.AGENC_CLI_ENTRY_DISABLE = previous;
  }
}, 30_000);

beforeEach(() => {
  lazy.run.mockReset();
  lazy.prepare.mockReset();
});

function options(): RunSingleTurnOpts {
  // Opaque inputs are intentional: this test proves forwarding, not the moved
  // implementation's assembly behavior (covered by existing agenc tests).
  return Object.freeze({
    session: {} as RunSingleTurnOpts["session"],
    ctx: {} as RunSingleTurnOpts["ctx"],
    input: "synthetic local-turn boundary",
    configStore: {} as RunSingleTurnOpts["configStore"],
    configReloadLatch: { requested: false },
    provider: "synthetic",
    displayInput: null,
    userStopGenerationToRelease: 7,
    reloadConfigFn: vi.fn(),
  });
}

const first: PhaseEvent = { type: "turn_start", turnIndex: 1 };
const second: PhaseEvent = { type: "assistant_text", content: "synthetic" };
const terminal = { reason: "completed" } as Terminal;

describe("CLI local-turn lazy boundary", () => {
  it("does not evaluate the local runtime while importing agenc-main", () => {
    expect(evaluationsAfterCliImport).toBe(0);
    expect(cli.runSingleTurn).toBeTypeOf("function");
    expect(cli.prepareTurnRuntimeInputs).toBeTypeOf("function");
  });

  it("does not start a generator merely by constructing or closing it", async () => {
    const count = lazy.evaluations;
    const iterator = cli.runSingleTurn(options());
    expect(lazy.evaluations).toBe(count);
    expect(lazy.run).not.toHaveBeenCalled();
    await expect(iterator.return(terminal)).resolves.toEqual({ done: true, value: terminal });
    expect(lazy.evaluations).toBe(count);
    expect(lazy.run).not.toHaveBeenCalled();
  });

  it("loads once across both wrappers and preserves exact options/default reload", async () => {
    lazy.run.mockImplementation(async function* () { return terminal; });
    const prepared = { memoryPromptText: "", allMemories: [],
      enabledToolNames: new Set<string>(), mcpServers: [] };
    lazy.prepare.mockResolvedValue(prepared);
    const opts = options();
    const params = Object.freeze({ fixture: "exact parameter object" }) as unknown as
      Parameters<LocalRuntime["prepareTurnRuntimeInputs"]>[0];

    await expect(cli.runSingleTurn(opts).next()).resolves.toEqual({ done: true, value: terminal });
    expect(lazy.evaluations).toBe(1);
    expect(lazy.run.mock.calls[0]?.[0]).toBe(opts);
    expect(lazy.run.mock.calls[0]?.[1]).toBe(cli.maybeReloadConfigBetweenTurns);
    // The wrapper must not replace an explicit per-call override with default.
    expect(lazy.run.mock.calls[0]?.[0].reloadConfigFn).toBe(opts.reloadConfigFn);
    expect(opts.reloadConfigFn).not.toHaveBeenCalled();
    await expect(cli.prepareTurnRuntimeInputs(params)).resolves.toBe(prepared);
    expect(lazy.prepare.mock.calls[0]?.[0]).toBe(params);
    await cli.runSingleTurn(opts).next();
    await cli.prepareTurnRuntimeInputs(params);
    expect(lazy.evaluations).toBe(1);
    expect(lazy.run).toHaveBeenCalledTimes(2);
    expect(lazy.prepare).toHaveBeenCalledTimes(2);
  });

  it("preserves event objects, next input and the terminal return value", async () => {
    const received: unknown[] = [];
    lazy.run.mockImplementation(async function* () {
      received.push(yield first);
      received.push(yield second);
      return terminal;
    });
    const iterator = cli.runSingleTurn(options());
    expect((await iterator.next()).value).toBe(first);
    const nextInput = { continuation: "opaque" };
    expect((await iterator.next(nextInput)).value).toBe(second);
    const end = await iterator.next("last");
    expect(end.done).toBe(true);
    expect(end.value).toBe(terminal);
    expect(received).toEqual([nextInput, "last"]);
    expect(received[0]).toBe(nextInput);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("preserves an undefined terminal rather than inventing completion", async () => {
    lazy.run.mockImplementation(async function* () { yield first; return undefined; });
    const iterator = cli.runSingleTurn(options());
    await iterator.next();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("propagates prepare sync throws and rejected promises without wrapping", async () => {
    const params = {} as Parameters<LocalRuntime["prepareTurnRuntimeInputs"]>[0];
    const failure = new Error("synthetic prepare failure");
    lazy.prepare.mockImplementationOnce(() => { throw failure; });
    await expect(cli.prepareTurnRuntimeInputs(params)).rejects.toBe(failure);
    lazy.prepare.mockRejectedValueOnce(failure);
    await expect(cli.prepareTurnRuntimeInputs(params)).rejects.toBe(failure);
    expect(lazy.prepare).toHaveBeenCalledTimes(2);
  });

  it("propagates generator failures before and after events with cleanup", async () => {
    const failure = new Error("synthetic turn failure");
    lazy.run.mockImplementationOnce(() => { throw failure; });
    await expect(cli.runSingleTurn(options()).next()).rejects.toBe(failure);
    const cleanup = vi.fn();
    lazy.run.mockImplementationOnce(async function* () {
      try { yield first; throw failure; } finally { cleanup(); }
    });
    const iterator = cli.runSingleTurn(options());
    expect((await iterator.next()).value).toBe(first);
    await expect(iterator.next()).rejects.toBe(failure);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("delegates consumer return cancellation and awaits generator cleanup", async () => {
    const cleanup = vi.fn();
    lazy.run.mockImplementation(async function* () {
      try { yield first; yield second; return terminal; }
      finally { await Promise.resolve(); cleanup(); }
    });
    const iterator = cli.runSingleTurn(options());
    await iterator.next();
    const cancelled = { reason: "aborted_streaming" } as Terminal;
    const end = await iterator.return(cancelled);
    expect(end.done).toBe(true);
    expect(end.value).toBe(cancelled);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("delegates thrown cancellation to the inner generator without swallowing", async () => {
    const cancellation = new Error("synthetic consumer cancellation");
    const observed = vi.fn();
    const cleanup = vi.fn();
    lazy.run.mockImplementation(async function* () {
      try { yield first; }
      catch (error) { observed(error); yield second; throw error; }
      finally { cleanup(); }
    });
    const iterator = cli.runSingleTurn(options());
    await iterator.next();
    expect((await iterator.throw(cancellation)).value).toBe(second);
    expect(observed).toHaveBeenCalledExactlyOnceWith(cancellation);
    await expect(iterator.next()).rejects.toBe(cancellation);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
