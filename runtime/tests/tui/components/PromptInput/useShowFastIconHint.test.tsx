import { PassThrough } from "node:stream";

import { afterEach, describe, expect, test, vi } from "vitest";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

type Cleanup = () => void;

const cleanupRoots: Cleanup[] = [];

function createTestStreams(): {
  stdin: TestStdin;
  stdout: PassThrough;
} {
  const stdout = new PassThrough();
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 24;

  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};

  return { stdin, stdout };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}

async function createHarness(snapshots: boolean[], resetModules = true) {
  if (resetModules) {
    vi.resetModules();
  }
  const [{ default: React }, { createRoot }, { default: Text }, hookModule] =
    await Promise.all([
      import("react"),
      import("../../ink/root.js"),
      import("../../ink/components/Text.js"),
      import("./useShowFastIconHint.js"),
    ]);

  function FastIconHintProbe({ showFastIcon }: { showFastIcon: boolean }) {
    const showHint = hookModule.useShowFastIconHint(showFastIcon);

    React.useLayoutEffect(() => {
      snapshots.push(showHint);
    }, [showHint]);

    return React.createElement(Text, null, showHint ? "shown" : "hidden");
  }

  const { stdin, stdout } = createTestStreams();
  const root = await createRoot({
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
  });

  cleanupRoots.push(() => {
    root.unmount();
    stdin.end();
    stdout.end();
  });

  const render = (showFastIcon: boolean) => {
    root.render(React.createElement(FastIconHintProbe, { showFastIcon }));
  };

  return { render };
}

afterEach(() => {
  for (const cleanup of cleanupRoots.splice(0)) cleanup();
  vi.restoreAllMocks();
});

describe("useShowFastIconHint", () => {
  test("does not show the hint when the fast icon is hidden", async () => {
    const snapshots: boolean[] = [];
    const { render } = await createHarness(snapshots);

    render(false);
    await waitFor(() => snapshots.includes(false));

    expect(snapshots).not.toContain(true);
  });

  test("shows the hint once, hides it on timeout, and clears the timer on cleanup", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let hintTimeout: (() => void) | undefined;
    const hintTimer = 1_234_567 as unknown as ReturnType<typeof setTimeout>;

    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((callback, delay, ...args) => {
        if (delay === 5_000) {
          hintTimeout = () => {
            (callback as (...args: unknown[]) => void)(...args);
          };
          return hintTimer;
        }
        return realSetTimeout(callback, delay, ...args);
      }) as typeof setTimeout);

    const clearTimeoutSpy = vi
      .spyOn(globalThis, "clearTimeout")
      .mockImplementation(((timer) => {
        if (timer === hintTimer) return;
        return realClearTimeout(timer);
      }) as typeof clearTimeout);

    const firstSnapshots: boolean[] = [];
    const first = await createHarness(firstSnapshots);

    first.render(true);
    await waitFor(() => firstSnapshots.includes(true));

    expect(setTimeoutSpy).toHaveBeenCalledWith(
      expect.any(Function),
      5_000,
      false,
    );

    hintTimeout?.();
    await waitFor(() => firstSnapshots.at(-1) === false);

    const secondSnapshots: boolean[] = [];
    const second = await createHarness(secondSnapshots, false);

    second.render(true);
    await waitFor(() => secondSnapshots.includes(false));
    expect(secondSnapshots).not.toContain(true);

    second.render(false);
    await waitFor(() => secondSnapshots.at(-1) === false);

    for (const cleanup of cleanupRoots.splice(0)) cleanup();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(hintTimer);
  });
});
