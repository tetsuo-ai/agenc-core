import { PassThrough } from "node:stream";

import { afterEach, describe, expect, test, vi } from "vitest";

const inkMock = vi.hoisted(() => ({
  constructorOptions: [] as Array<Record<string, unknown>>,
  instances: [] as Array<{
    render: ReturnType<typeof vi.fn>;
    unmount: ReturnType<typeof vi.fn>;
    waitUntilExit: ReturnType<typeof vi.fn>;
  }>,
}));

const registryMock = vi.hoisted(() => ({
  map: new Map<NodeJS.WriteStream, unknown>(),
}));

const debugMock = vi.hoisted(() => ({
  logForDebugging: vi.fn(),
}));

vi.mock("../../../src/tui/ink/ink.js", () => {
  class MockInk {
    render = vi.fn();
    unmount = vi.fn();
    waitUntilExit = vi.fn(async () => undefined);

    constructor(options: Record<string, unknown>) {
      inkMock.constructorOptions.push(options);
      inkMock.instances.push(this);
    }
  }

  return {
    default: MockInk,
  };
});

vi.mock("../../../src/tui/ink/instances.js", () => ({
  deleteInkInstance: vi.fn((stdout: NodeJS.WriteStream) =>
    registryMock.map.delete(stdout),
  ),
  getInkInstance: vi.fn((stdout: NodeJS.WriteStream = process.stdout) =>
    registryMock.map.get(stdout),
  ),
  setInkInstance: vi.fn((stdout: NodeJS.WriteStream, instance: unknown) => {
    registryMock.map.set(stdout, instance);
  }),
}));

vi.mock("../../../src/utils/debug.js", () => ({
  logForDebugging: debugMock.logForDebugging,
}));

import wrappedRender, {
  createRoot,
  renderSync,
} from "../../../src/tui/ink/root.js";

function createStdout(): NodeJS.WriteStream {
  return new PassThrough() as unknown as NodeJS.WriteStream;
}

function createStdin(): NodeJS.ReadStream {
  return new PassThrough() as unknown as NodeJS.ReadStream;
}

afterEach(() => {
  inkMock.constructorOptions.length = 0;
  inkMock.instances.length = 0;
  registryMock.map.clear();
  vi.clearAllMocks();
});

describe("Ink root coverage swarm row 177", () => {
  test("renderSync accepts a stdout stream option, reuses the registered instance, and can clean it up", () => {
    const stdout = createStdout();

    const first = renderSync("first render", stdout);
    const second = renderSync("second render", { stdout });

    expect(inkMock.constructorOptions).toHaveLength(1);
    expect(inkMock.constructorOptions[0]).toMatchObject({
      stdout,
      stdin: process.stdin,
      stderr: process.stderr,
      exitOnCtrlC: true,
      patchConsole: true,
    });
    expect(inkMock.instances[0]?.render).toHaveBeenNthCalledWith(
      1,
      "first render",
    );
    expect(inkMock.instances[0]?.render).toHaveBeenNthCalledWith(
      2,
      "second render",
    );

    second.rerender("third render");
    second.unmount();
    expect(first.waitUntilExit).toBe(inkMock.instances[0]?.waitUntilExit);
    expect(inkMock.instances[0]?.render).toHaveBeenNthCalledWith(
      3,
      "third render",
    );
    expect(inkMock.instances[0]?.unmount).toHaveBeenCalledTimes(1);

    expect(registryMock.map.has(stdout)).toBe(true);
    expect(first.cleanup()).toBe(true);
    expect(registryMock.map.has(stdout)).toBe(false);
  });

  test("renderSync passes explicit render options through when creating a fresh instance", () => {
    const stdout = createStdout();
    const stdin = createStdin();
    const stderr = createStdout();
    const onFrame = vi.fn();

    renderSync("custom options", {
      stdout,
      stdin,
      stderr,
      exitOnCtrlC: false,
      patchConsole: false,
      onFrame,
    });

    expect(inkMock.constructorOptions).toEqual([
      {
        stdout,
        stdin,
        stderr,
        exitOnCtrlC: false,
        patchConsole: false,
        onFrame,
      },
    ]);
    expect(inkMock.instances[0]?.render).toHaveBeenCalledWith(
      "custom options",
    );
  });

  test("wrapped render preserves the async boundary and logs after rendering", async () => {
    const stdout = createStdout();

    const pendingRender = wrappedRender("wrapped render", { stdout });

    expect(inkMock.instances).toHaveLength(0);

    const instance = await pendingRender;

    expect(instance).toMatchObject({
      rerender: inkMock.instances[0]?.render,
      waitUntilExit: inkMock.instances[0]?.waitUntilExit,
    });
    expect(inkMock.instances[0]?.render).toHaveBeenCalledWith(
      "wrapped render",
    );
    expect(debugMock.logForDebugging).toHaveBeenCalledWith(
      expect.stringContaining("[render] first ink render:"),
    );
  });

  test("createRoot applies defaults, registers the instance, and delegates root methods", async () => {
    const root = await createRoot();

    expect(inkMock.constructorOptions).toEqual([
      {
        stdout: process.stdout,
        stdin: process.stdin,
        stderr: process.stderr,
        exitOnCtrlC: true,
        patchConsole: true,
        onFrame: undefined,
      },
    ]);
    expect(registryMock.map.get(process.stdout)).toBe(inkMock.instances[0]);

    root.render("root node");
    root.unmount();
    await root.waitUntilExit();

    expect(inkMock.instances[0]?.render).toHaveBeenCalledWith("root node");
    expect(inkMock.instances[0]?.unmount).toHaveBeenCalledTimes(1);
    expect(inkMock.instances[0]?.waitUntilExit).toHaveBeenCalledTimes(1);
  });
});
