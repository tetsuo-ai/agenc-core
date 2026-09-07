import { PassThrough } from "node:stream";

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ tailFile: vi.fn(), logError: vi.fn() }));
vi.mock("../../../src/utils/fsOperations.js", () => ({
  tailFile: mocks.tailFile,
}));
vi.mock("../../../src/utils/log.js", () => ({ logError: mocks.logError }));
vi.mock("../../../src/utils/task/diskOutput.js", () => ({
  getTaskOutputPath: (id: string) => `/tmp/${id}.log`,
}));

import { createRoot } from "../../../src/tui/ink.js";
import { useTaskTail } from "../../../src/tui/workbench/surfaces/useTaskTail.js";

type Selection = { id?: string; status?: string; maxBytes?: number };

function pendingRead() {
  return Promise.withResolvers<{ content: string }>();
}

async function renderTail(initial: Selection) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  Object.assign(stdin, {
    isTTY: true,
    ref() {},
    unref() {},
    setRawMode() {},
  });
  Object.assign(stdout, { isTTY: true, columns: 100, rows: 24 });
  stdout.resume();
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  const frames: string[] = [];
  function Probe({ id, status, maxBytes = 48_000 }: Selection) {
    frames.push(useTaskTail(id, status, maxBytes));
    return null;
  }
  const update = (selection: Selection) =>
    root.render(<Probe {...selection} />);
  update(initial);
  return {
    frames,
    update,
    close() {
      root.unmount();
      stdin.end();
      stdout.end();
    },
  };
}

describe("useTaskTail", () => {
  let view: Awaited<ReturnType<typeof renderTail>> | undefined;

  beforeEach(() => {
    mocks.tailFile.mockReset();
    mocks.logError.mockReset();
    // Keep React/Ink scheduling real while controlling only tail polling.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

  afterEach(() => {
    view?.close();
    view = undefined;
    vi.useRealTimers();
  });

  it("never renders an empty tail during completion and ignores the old running read", async () => {
    const running = pendingRead();
    const final = pendingRead();
    mocks.tailFile
      .mockResolvedValueOnce({ content: "running output" })
      .mockReturnValueOnce(running.promise)
      .mockReturnValueOnce(final.promise);
    view = await renderTail({ id: "a", status: "running" });
    await vi.waitFor(() => expect(view!.frames.at(-1)).toBe("running output"));
    vi.advanceTimersByTime(1_000);
    expect(mocks.tailFile).toHaveBeenCalledTimes(2);
    const transition = view.frames.length;
    view.update({ id: "a", status: "completed" });
    await vi.waitFor(() => expect(mocks.tailFile).toHaveBeenCalledTimes(3));
    expect(view.frames.slice(transition)).not.toContain("");
    final.resolve({ content: "final output" });
    await vi.waitFor(() => expect(view!.frames.at(-1)).toBe("final output"));
    running.resolve({ content: "stale running output" });
    await running.promise;
    await new Promise((resolve) => setTimeout(resolve, 50));
    vi.advanceTimersByTime(5_000);
    expect(mocks.tailFile).toHaveBeenCalledTimes(3);
    expect(view.frames.at(-1)).toBe("final output");
    expect(view.frames.slice(transition)).not.toContain("");
  });

  it("clears switched and removed tasks and ignores their late reads", async () => {
    const old = pendingRead();
    const next = pendingRead();
    const removed = pendingRead();
    mocks.tailFile
      .mockResolvedValueOnce({ content: "old output" })
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(next.promise)
      .mockReturnValueOnce(removed.promise);
    view = await renderTail({ id: "a", status: "running" });
    await vi.waitFor(() => expect(view!.frames.at(-1)).toBe("old output"));
    vi.advanceTimersByTime(1_000);
    const switchFrame = view.frames.length;
    view.update({ id: "b", status: "running" });
    await vi.waitFor(() => expect(mocks.tailFile).toHaveBeenCalledTimes(3));
    expect(view.frames[switchFrame]).toBe("");
    next.resolve({ content: "new output" });
    await vi.waitFor(() => expect(view!.frames.at(-1)).toBe("new output"));
    old.resolve({ content: "late old output" });
    await old.promise;
    await new Promise((resolve) => setTimeout(resolve, 50));
    vi.advanceTimersByTime(1_000);
    expect(mocks.tailFile).toHaveBeenCalledTimes(4);
    view.update({});
    await vi.waitFor(() => expect(view!.frames.at(-1)).toBe(""));
    removed.resolve({ content: "removed output" });
    await removed.promise;
    await new Promise((resolve) => setTimeout(resolve, 50));
    vi.advanceTimersByTime(5_000);
    expect(mocks.tailFile).toHaveBeenCalledTimes(4);
    expect(view.frames.slice(switchFrame)).not.toContain("late old output");
    expect(view.frames.at(-1)).toBe("");
  });

  it("preserves output after read failures and resumes polling without overlapping reads", async () => {
    const slow = pendingRead();
    const error = new Error("transient disk failure");
    mocks.tailFile
      .mockResolvedValueOnce({ content: "last output" })
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce({ content: "recovered output" });
    view = await renderTail({ id: "a", status: "running" });
    await vi.waitFor(() => expect(view!.frames.at(-1)).toBe("last output"));
    vi.advanceTimersByTime(5_000);
    expect(mocks.tailFile).toHaveBeenCalledTimes(2);
    slow.reject(error);
    await vi.waitFor(() => expect(mocks.logError).toHaveBeenCalledWith(error));
    expect(view.frames.at(-1)).toBe("last output");
    vi.advanceTimersByTime(1_000);
    await vi.waitFor(() =>
      expect(view!.frames.at(-1)).toBe("recovered output"),
    );
    expect(mocks.tailFile).toHaveBeenCalledTimes(3);
  });

  it("ignores failures after unmount and cancels polling", async () => {
    const read = pendingRead();
    mocks.tailFile.mockReturnValue(read.promise);
    view = await renderTail({ id: "a", status: "running" });
    await vi.waitFor(() => expect(mocks.tailFile).toHaveBeenCalledTimes(1));
    const frames = [...view.frames];
    const observed = view.frames;
    view.close();
    view = undefined;
    read.reject(new Error("late failure"));
    await read.promise.catch(() => {});
    vi.advanceTimersByTime(5_000);
    expect(mocks.logError).not.toHaveBeenCalled();
    expect(mocks.tailFile).toHaveBeenCalledTimes(1);
    expect(observed).toEqual(frames);
  });

  it.each([16_000, 24_000, 48_000])(
    "applies the %i-byte surface limit to the final read",
    async (maxBytes) => {
      mocks.tailFile.mockResolvedValue({ content: "bounded output" });
      view = await renderTail({ id: "bounded", status: "completed", maxBytes });
      await vi.waitFor(() =>
        expect(view!.frames.at(-1)).toBe("bounded output"),
      );
      expect(mocks.tailFile).toHaveBeenCalledWith("/tmp/bounded.log", maxBytes);
      vi.advanceTimersByTime(5_000);
      expect(mocks.tailFile).toHaveBeenCalledTimes(1);
    },
  );
});
