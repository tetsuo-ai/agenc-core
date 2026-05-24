import { PassThrough } from "node:stream";

import React, { useState } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => ({
  entries: [] as HistoryEntryLike[],
  features: new Set<string>(),
  inputSubscription: undefined as
    | undefined
    | { handler: (input: string, key: unknown, event: { keypress: string }) => void; isActive: boolean },
  keybinding: new Map<
    string,
    { handler: () => void; isActive: boolean; context: string }
  >(),
  keybindings: new Map<
    string,
    { handler: () => void; isActive: boolean; context: string }
  >(),
  readers: [] as Array<{
    next: ReturnType<typeof vi.fn>;
    return: ReturnType<typeof vi.fn>;
  }>,
  nextDelays: [] as Array<Promise<void>>,
  readerError: null as Error | null,
  logError: vi.fn(),
  reset() {
    harness.entries = [];
    harness.features = new Set();
    harness.inputSubscription = undefined;
    harness.keybinding = new Map();
    harness.keybindings = new Map();
    harness.readers = [];
    harness.nextDelays = [];
    harness.readerError = null;
    harness.logError.mockClear();
  },
}));

type HistoryEntryLike = {
  display: string;
  pastedContents?: Record<string, unknown>;
};

vi.mock("bun:bundle", () => ({
  feature: (name: string) => harness.features.has(name),
}));

vi.mock("../history/history.js", () => ({
  makeHistoryReader: () => {
    let index = 0;
    const reader = {
      next: vi.fn(async () => {
        const delay = harness.nextDelays.shift();
        if (delay) await delay;
        if (harness.readerError) throw harness.readerError;
        if (index >= harness.entries.length) {
          return { done: true, value: undefined };
        }
        const value = harness.entries[index++];
        return { done: false, value };
      }),
      return: vi.fn(async () => ({ done: true, value: undefined })),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    harness.readers.push(reader);
    return reader;
  },
}));

vi.mock("../../utils/log.js", () => ({
  logError: harness.logError,
}));

vi.mock("../keybindings/useKeybinding.js", () => ({
  useKeybinding: (
    command: string,
    handler: () => void,
    options: { context: string; isActive: boolean },
  ) => {
    harness.keybinding.set(command, {
      context: options.context,
      handler,
      isActive: options.isActive,
    });
  },
  useKeybindings: (
    handlers: Record<string, () => void>,
    options: { context: string; isActive: boolean },
  ) => {
    for (const [command, handler] of Object.entries(handlers)) {
      harness.keybindings.set(command, {
        context: options.context,
        handler,
        isActive: options.isActive,
      });
    }
  },
}));

vi.mock("../ink.js", () => ({
  useInput: (
    handler: (input: string, key: unknown, event: { keypress: string }) => void,
    options: { isActive: boolean },
  ) => {
    harness.inputSubscription = {
      handler,
      isActive: options.isActive,
    };
  },
}));

import { createRoot } from "../ink/root.js";
import { useHistorySearch } from "./useHistorySearch.js";

type HookResult = ReturnType<typeof useHistorySearch>;

function createStreams(): {
  stdout: PassThrough;
  stdin: PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  stdout.resume();
  return { stdin, stdout };
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await sleep(25);
    }
  }
  throw lastError;
}

async function renderHistoryHarness(
  initial: {
    currentCursorOffset?: number;
    currentInput?: string;
    currentMode?: "bash" | "prompt";
    currentPastedContents?: Record<string, unknown>;
  } = {},
): Promise<{
  callbacks: {
    onAcceptHistory: ReturnType<typeof vi.fn>;
    onCursorChange: ReturnType<typeof vi.fn>;
    onInputChange: ReturnType<typeof vi.fn>;
    onModeChange: ReturnType<typeof vi.fn>;
    setPastedContents: ReturnType<typeof vi.fn>;
  };
  dispose: () => Promise<void>;
  isSearching: () => boolean;
  result: () => HookResult;
}> {
  let latest: HookResult | undefined;
  let latestIsSearching = false;
  const callbacks = {
    onAcceptHistory: vi.fn(),
    onCursorChange: vi.fn(),
    onInputChange: vi.fn(),
    onModeChange: vi.fn(),
    setPastedContents: vi.fn(),
  };
  const { stdin, stdout } = createStreams();
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  function Harness(): null {
    const [isSearching, setIsSearching] = useState(false);
    latestIsSearching = isSearching;
    latest = useHistorySearch(
      callbacks.onAcceptHistory,
      initial.currentInput ?? "original input",
      callbacks.onInputChange,
      callbacks.onCursorChange,
      initial.currentCursorOffset ?? 9,
      callbacks.onModeChange,
      initial.currentMode ?? "prompt",
      isSearching,
      setIsSearching,
      callbacks.setPastedContents,
      initial.currentPastedContents ?? { original: true },
    );
    return null;
  }
  root.render(<Harness />);
  await sleep();
  return {
    callbacks,
    dispose: async () => {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    },
    isSearching: () => latestIsSearching,
    result: () => {
      if (!latest) throw new Error("hook did not render");
      return latest;
    },
  };
}

describe("useHistorySearch", () => {
  beforeEach(() => {
    harness.reset();
  });

  test("starts search through the global history keybinding unless the picker owns it", async () => {
    const rendered = await renderHistoryHarness();

    try {
      expect(harness.keybinding.get("history:search")).toMatchObject({
        context: "Global",
        isActive: true,
      });
      harness.keybinding.get("history:search")?.handler();
      await waitFor(() => expect(rendered.isSearching()).toBe(true));
      expect(harness.inputSubscription?.isActive).toBe(true);
      expect(harness.keybindings.get("historySearch:accept")).toMatchObject({
        context: "HistorySearch",
        isActive: true,
      });
      expect(harness.readers).toHaveLength(1);
    } finally {
      await rendered.dispose();
    }

    harness.reset();
    harness.features.add("HISTORY_PICKER");
    const gated = await renderHistoryHarness();
    try {
      expect(harness.keybinding.get("history:search")).toMatchObject({
        isActive: false,
      });
    } finally {
      await gated.dispose();
    }
  });

  test("searches history, deduplicates matches, and resumes to the next result", async () => {
    harness.entries = [
      { display: "first miss" },
      { display: "!echo hello", pastedContents: { one: true } },
      { display: "!echo hello", pastedContents: { duplicate: true } },
      { display: "say hello again", pastedContents: { two: true } },
    ];
    const rendered = await renderHistoryHarness();

    try {
      harness.keybinding.get("history:search")?.handler();
      await waitFor(() => expect(rendered.isSearching()).toBe(true));
      rendered.result().setHistoryQuery("hello");
      await waitFor(() =>
        expect(rendered.callbacks.onInputChange).toHaveBeenLastCalledWith("!echo hello"),
      );

      expect(rendered.result().historyFailedMatch).toBe(false);
      expect(rendered.result().historyMatch).toMatchObject({
        display: "!echo hello",
      });
      expect(rendered.callbacks.onModeChange).toHaveBeenLastCalledWith("bash");
      expect(rendered.callbacks.setPastedContents).toHaveBeenLastCalledWith({
        one: true,
      });
      expect(rendered.callbacks.onCursorChange).toHaveBeenLastCalledWith(5);

      harness.keybindings.get("historySearch:next")?.handler();
      await waitFor(() =>
        expect(rendered.callbacks.onInputChange).toHaveBeenLastCalledWith("say hello again"),
      );
      expect(rendered.result().historyMatch).toMatchObject({
        display: "say hello again",
      });
      expect(rendered.callbacks.setPastedContents).toHaveBeenLastCalledWith({
        two: true,
      });
    } finally {
      await rendered.dispose();
    }
  });

  test("marks failed matches and restores the original input when the query is cleared", async () => {
    harness.entries = [{ display: "nothing relevant" }];
    const rendered = await renderHistoryHarness({
      currentCursorOffset: 4,
      currentInput: "keep me",
      currentMode: "bash",
      currentPastedContents: { keep: true },
    });

    try {
      harness.keybinding.get("history:search")?.handler();
      await waitFor(() => expect(rendered.isSearching()).toBe(true));
      rendered.result().setHistoryQuery("missing");
      await waitFor(() => expect(rendered.result().historyFailedMatch).toBe(true));

      rendered.result().setHistoryQuery("");
      await waitFor(() =>
        expect(rendered.callbacks.onInputChange).toHaveBeenLastCalledWith("keep me"),
      );
      expect(rendered.result().historyMatch).toBeUndefined();
      expect(rendered.result().historyFailedMatch).toBe(false);
      expect(rendered.callbacks.onCursorChange).toHaveBeenLastCalledWith(4);
      expect(rendered.callbacks.onModeChange).toHaveBeenLastCalledWith("bash");
      expect(rendered.callbacks.setPastedContents).toHaveBeenLastCalledWith({
        keep: true,
      });
      expect(harness.readers.at(-1)?.return).toHaveBeenCalled();
    } finally {
      await rendered.dispose();
    }
  });

  test("logs history reader failures and marks the search as failed", async () => {
    const error = new Error("history read failed");
    harness.readerError = error;
    const rendered = await renderHistoryHarness({
      currentInput: "keep me",
      currentPastedContents: { keep: true },
    });

    try {
      harness.keybinding.get("history:search")?.handler();
      await waitFor(() => expect(rendered.isSearching()).toBe(true));
      rendered.result().setHistoryQuery("needle");

      await waitFor(() =>
        expect(rendered.result().historyFailedMatch).toBe(true),
      );
      expect(harness.logError).toHaveBeenCalledWith(error);
      expect(rendered.callbacks.onInputChange).not.toHaveBeenCalledWith(
        "needle",
      );
      expect(rendered.result().historyMatch).toBeUndefined();
    } finally {
      await rendered.dispose();
    }
  });

  test("ignores a match that resolves after history search is canceled", async () => {
    let releaseNext: () => void = () => {};
    harness.nextDelays = [
      new Promise<void>(resolve => {
        releaseNext = resolve;
      }),
    ];
    harness.entries = [
      { display: "late needle match", pastedContents: { late: true } },
    ];
    const rendered = await renderHistoryHarness({
      currentInput: "keep original",
      currentCursorOffset: 6,
      currentPastedContents: { original: true },
    });

    try {
      harness.keybinding.get("history:search")?.handler();
      await waitFor(() => expect(rendered.isSearching()).toBe(true));
      rendered.result().setHistoryQuery("needle");
      await sleep();

      harness.keybindings.get("historySearch:cancel")?.handler();
      await waitFor(() => expect(rendered.isSearching()).toBe(false));
      expect(rendered.callbacks.onInputChange).toHaveBeenLastCalledWith(
        "keep original",
      );
      expect(rendered.callbacks.onCursorChange).toHaveBeenLastCalledWith(6);

      releaseNext();
      await sleep(50);

      expect(rendered.callbacks.onInputChange).not.toHaveBeenCalledWith(
        "late needle match",
      );
      expect(rendered.callbacks.setPastedContents).not.toHaveBeenCalledWith({
        late: true,
      });
      expect(rendered.result().historyMatch).toBeUndefined();
    } finally {
      await rendered.dispose();
    }
  });

  test("accepts, executes, and cancels history search state", async () => {
    harness.entries = [{ display: "!run accepted", pastedContents: { ok: true } }];
    const rendered = await renderHistoryHarness({
      currentInput: "original command",
      currentPastedContents: { original: true },
    });

    try {
      harness.keybinding.get("history:search")?.handler();
      await waitFor(() => expect(rendered.isSearching()).toBe(true));
      rendered.result().setHistoryQuery("accepted");
      await waitFor(() =>
        expect(rendered.callbacks.onInputChange).toHaveBeenLastCalledWith("!run accepted"),
      );

      harness.keybindings.get("historySearch:accept")?.handler();
      await waitFor(() => expect(rendered.isSearching()).toBe(false));
      expect(rendered.callbacks.onInputChange).toHaveBeenLastCalledWith("run accepted");
      expect(rendered.callbacks.onModeChange).toHaveBeenLastCalledWith("bash");
      expect(rendered.callbacks.setPastedContents).toHaveBeenLastCalledWith({
        ok: true,
      });

      harness.keybinding.get("history:search")?.handler();
      await waitFor(() => expect(rendered.isSearching()).toBe(true));
      harness.keybindings.get("historySearch:execute")?.handler();
      await waitFor(() => expect(rendered.isSearching()).toBe(false));
      expect(rendered.callbacks.onAcceptHistory).toHaveBeenLastCalledWith({
        display: "original command",
        pastedContents: { original: true },
      });

      harness.keybinding.get("history:search")?.handler();
      await waitFor(() => expect(rendered.isSearching()).toBe(true));
      rendered.result().setHistoryQuery("");
      const event = { key: "backspace", preventDefault: vi.fn() };
      rendered.result().handleKeyDown(event as never);
      await waitFor(() => expect(rendered.isSearching()).toBe(false));
      expect(event.preventDefault).toHaveBeenCalled();
      expect(rendered.callbacks.onInputChange).toHaveBeenLastCalledWith("original command");
    } finally {
      await rendered.dispose();
    }
  });

  test("ignores keydown and input bridge events while inactive", async () => {
    const rendered = await renderHistoryHarness();

    try {
      const event = { key: "backspace", preventDefault: vi.fn() };
      rendered.result().handleKeyDown(event as never);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(harness.inputSubscription?.isActive).toBe(false);
      harness.inputSubscription?.handler("", {}, { keypress: "backspace" });
      expect(event.preventDefault).not.toHaveBeenCalled();
    } finally {
      await rendered.dispose();
    }
  });
});
