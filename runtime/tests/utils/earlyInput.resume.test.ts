import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import { consumeEarlyInput, startCapturingEarlyInput, stopCapturingEarlyInput } from "../../src/utils/earlyInput.js";

test("resume handoff retains whitespace and restores raw mode when consumed", async () => {
  const original = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const argv = process.argv;
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn(),
  });
  Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
  process.argv = ["node", "agenc"];
  try {
    startCapturingEarlyInput();
    stdin.write("\x1b[20");
    await new Promise<void>(resolve => setImmediate(resolve));
    stdin.write("0~  Keep my indented draft 😅\x1b[201~\x1b[A\r\x03\x03");
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(consumeEarlyInput({ preserveWhitespace: true, restoreRawMode: true })).toBe("  Keep my indented draft 😅\n");
    expect(stdin.listenerCount("readable")).toBe(0);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.unref).toHaveBeenCalledOnce();
    expect(consumeEarlyInput()).toBe("");
  } finally {
    stopCapturingEarlyInput();
    consumeEarlyInput();
    Object.defineProperty(process, "stdin", original);
    process.argv = argv;
    stdin.destroy();
  }
});
