import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import {
  consumeEarlyInput,
  startCapturingEarlyInput,
  stopCapturingEarlyInput,
  waitForTerminalReports,
} from "../../src/utils/earlyInput.js";
import {
  getTerminalBackground,
  isTerminalBackgroundDetected,
  resetTerminalBackgroundCacheForTest,
} from "../../src/utils/terminalBackground.js";

const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
const originalStdout = Object.getOwnPropertyDescriptor(process, "stdout")!;
const argv = process.argv;

afterEach(() => {
  stopCapturingEarlyInput();
  consumeEarlyInput();
  Object.defineProperty(process, "stdin", originalStdin);
  Object.defineProperty(process, "stdout", originalStdout);
  process.argv = argv;
  resetTerminalBackgroundCacheForTest();
});

function fakeTerminal() {
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn(),
  });
  const written: string[] = [];
  const stdout = { isTTY: true, write: vi.fn((chunk: string) => { written.push(chunk); return true; }) };
  Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
  Object.defineProperty(process, "stdout", { configurable: true, value: stdout });
  process.argv = ["node", "agenc"];
  return { stdin, written };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("asks the terminal for its background at startup and records a light reply", async () => {
  resetTerminalBackgroundCacheForTest();
  const { stdin, written } = fakeTerminal();
  startCapturingEarlyInput();
  // The background query, then DA1 as the sentinel every terminal answers.
  expect(written).toEqual(["\x1b]11;?\x07\x1b[c"]);

  // Terminal.app answers within a millisecond; typed text around the report stays.
  const waited = waitForTerminalReports(5_000);
  stdin.write("hi\x1b]11;rgb:ffff/ffff/ffff\x07 there\x1b[?1;2c");
  await waited; // settled by the DA1 reply, long before the timeout
  expect(isTerminalBackgroundDetected()).toBe(true);
  expect(getTerminalBackground()).toBe("light");
  expect(consumeEarlyInput()).toBe("hi there");
  stdin.destroy();
});

test("records a dark reply split across chunks and ends with ST", async () => {
  resetTerminalBackgroundCacheForTest();
  const { stdin } = fakeTerminal();
  startCapturingEarlyInput();
  stdin.write("\x1b]11;rgb:1e1e/1e1e");
  await tick();
  stdin.write("/1e1e\x1b\\");
  await tick();
  expect(getTerminalBackground()).toBe("dark");
  expect(isTerminalBackgroundDetected()).toBe(true);
  expect(consumeEarlyInput()).toBe("");
  stdin.destroy();
});

test("a terminal that never answers keeps the undetected default", async () => {
  resetTerminalBackgroundCacheForTest();
  const { stdin } = fakeTerminal();
  startCapturingEarlyInput();
  stdin.write("draft");
  await tick();
  expect(isTerminalBackgroundDetected()).toBe(false);
  expect(consumeEarlyInput()).toBe("draft");
  stdin.destroy();
});

test("a terminal that answers DA1 but has no OSC 11 ends the wait without a background", async () => {
  resetTerminalBackgroundCacheForTest();
  const { stdin } = fakeTerminal();
  startCapturingEarlyInput();
  const waited = waitForTerminalReports(5_000);
  stdin.write("\x1b[?62;22c");
  await waited;
  expect(isTerminalBackgroundDetected()).toBe(false);
  expect(consumeEarlyInput()).toBe("");
  stdin.destroy();
});

test("the wait is bounded when the terminal answers nothing", async () => {
  resetTerminalBackgroundCacheForTest();
  const { stdin } = fakeTerminal();
  startCapturingEarlyInput();
  const started = Date.now();
  await waitForTerminalReports(30);
  expect(Date.now() - started).toBeLessThan(1_000);
  // Stopping the capture settles any wait still pending.
  const pending = waitForTerminalReports(5_000);
  stopCapturingEarlyInput();
  await pending;
  stdin.destroy();
});
