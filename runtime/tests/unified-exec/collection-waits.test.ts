import { afterEach, describe, expect, it, vi } from "vitest";

const waits = vi.hoisted(() => [] as Array<{ ms: number; signal?: AbortSignal }>);
vi.mock("node:timers/promises", () => ({
  setTimeout: vi.fn((ms: number, value?: unknown, options?: { signal?: AbortSignal }) => {
    waits.push({ ms, signal: options?.signal });
    return Promise.resolve(value);
  }),
}));

import { UnifiedExecProcessManager } from "../../src/unified-exec/process-manager.js";

function interactiveManager() {
  const manager = new UnifiedExecProcessManager();
  let data: (chunk: string) => void = () => {};
  let exit: (event: { exitCode: number }) => void = () => {};
  const terminal = {
    pid: 0,
    write: vi.fn(() => { data("final output\n"); exit({ exitCode: 7 }); }),
    resize: vi.fn(),
    kill: vi.fn(() => exit({ exitCode: 0 })),
    onData: (listener: typeof data) => { data = listener; return { dispose() {} }; },
    onExit: (listener: typeof exit) => { exit = listener; return { dispose() {} }; },
  };
  Object.assign(manager, { loadPty: async () => ({ spawn: () => terminal }) });
  return { manager, terminal };
}

afterEach(() => { waits.length = 0; });

describe("unified exec collection waits", () => {
  it("collects an input-triggered exit without a separate stdin settle delay", async () => {
    const { manager, terminal } = interactiveManager();
    try {
      const running = await manager.execCommand({ cmd: "interactive", tty: true, yield_time_ms: 1000 });
      waits.length = 0;
      const result = await manager.writeStdin({ session_id: running.session_id!, chars: "finish\n", yield_time_ms: 1000 });
      expect(terminal.write).toHaveBeenCalledWith("finish\n");
      expect(result.exit_code).toBe(7);
      expect(result.output).toContain("final output");
      expect(result.session_id).toBeUndefined();
      expect(waits.map(wait => wait.ms)).toEqual([1000]);
    } finally { await manager.closeAll(); }
  });

  it("cancels the collection deadline once collection has settled", async () => {
    const { manager } = interactiveManager();
    const source = new AbortController();
    try {
      const running = await manager.execCommand({ cmd: "interactive", tty: true, yield_time_ms: 1000,
        __abortSignal: source.signal });
      const first = waits[0]!;
      expect(first.signal).toBeDefined();
      expect(first.signal!.aborted).toBe(true);
      expect(source.signal.aborted).toBe(false);
      waits.length = 0;
      await manager.writeStdin({ session_id: running.session_id!, chars: "finish\n", yield_time_ms: 1000 });
      expect(waits.at(-1)!.signal?.aborted).toBe(true);
    } finally { await manager.closeAll(); }
  });
});
