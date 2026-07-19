import { PassThrough } from "node:stream";
import * as path from "node:path";

import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

type PickerAction = {
  action: string;
  handler: (item: string) => void;
};

type CapturedPickerProps = {
  title: string;
  placeholder?: string;
  items: readonly string[];
  visibleCount: number;
  previewPosition: "bottom" | "right";
  onQueryChange: (query: string) => void;
  onFocus?: (item: string | undefined) => void;
  onSelect: (item: string) => void;
  onTab?: PickerAction;
  onShiftTab?: PickerAction;
  onCancel: () => void;
  emptyMessage?: string | ((query: string) => string);
  selectAction?: string;
  renderPreview?: (item: string) => React.ReactNode;
};

type Suggestion = {
  id: string;
  displayText: string;
};

const harness = vi.hoisted(() => ({
  cwd: "/workspace/project",
  generateFileSuggestions: vi.fn(),
  openFileInExternalEditor: vi.fn(),
  pickerProps: undefined as CapturedPickerProps | undefined,
  readFileInRange: vi.fn(),
  registerOverlay: vi.fn(),
  terminal: {
    columns: 120,
    rows: 10,
  },
}));

vi.mock("src/tui/context/overlayContext.js", () => ({
  useRegisterOverlay: harness.registerOverlay,
}));

vi.mock("src/tui/hooks/fileSuggestions.js", () => ({
  generateFileSuggestions: harness.generateFileSuggestions,
}));

vi.mock("src/tui/hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => harness.terminal,
}));

vi.mock("src/utils/cwd.js", () => ({
  getCwd: () => harness.cwd,
}));

vi.mock("src/utils/editor.js", () => ({
  openFileInExternalEditor: harness.openFileInExternalEditor,
}));

vi.mock("src/utils/readFileInRange.js", () => ({
  readFileInRange: harness.readFileInRange,
}));

vi.mock("src/tui/components/design-system/FuzzyPicker.js", () => ({
  FuzzyPicker: (props: CapturedPickerProps) => {
    harness.pickerProps = props;
    return null;
  },
}));

import { createRoot } from "src/tui/ink/root.js";
import { renderToString } from "src/utils/staticRender.js";
import {
  computeQuickOpenLayout,
  QuickOpenDialog,
} from "src/tui/components/QuickOpenDialog.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

type TestStdout = PassThrough & {
  columns: number;
  isTTY: boolean;
  rows: number;
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function resetHarness() {
  harness.terminal.columns = 120;
  harness.terminal.rows = 10;
  harness.pickerProps = undefined;
  harness.registerOverlay.mockClear();
  harness.generateFileSuggestions.mockReset();
  harness.generateFileSuggestions.mockResolvedValue([]);
  harness.openFileInExternalEditor.mockReset();
  harness.openFileInExternalEditor.mockReturnValue(false);
  harness.readFileInRange.mockReset();
  harness.readFileInRange.mockResolvedValue({ content: "" });
}

function pickerProps(): CapturedPickerProps {
  const props = harness.pickerProps;
  if (!props) throw new Error("QuickOpenDialog picker props were not captured");
  return props;
}

function createStreams(): {
  stdin: TestStdin;
  stdout: TestStdout;
} {
  const stdin = new PassThrough() as TestStdin;
  const stdout = new PassThrough() as TestStdout;

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};

  stdout.columns = harness.terminal.columns;
  stdout.rows = harness.terminal.rows;
  stdout.isTTY = true;
  stdout.resume();

  return { stdin, stdout };
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(10);
  }

  throw new Error(message);
}

async function renderDialog(): Promise<{
  onDone: ReturnType<typeof vi.fn>;
  onInsert: ReturnType<typeof vi.fn>;
  dispose: () => Promise<void>;
}> {
  const onDone = vi.fn();
  const onInsert = vi.fn();
  const { stdin, stdout } = createStreams();
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });

  root.render(<QuickOpenDialog onDone={onDone} onInsert={onInsert} />);
  await waitFor(
    () => harness.pickerProps !== undefined,
    "QuickOpenDialog did not render",
  );

  return {
    onDone,
    onInsert,
    dispose: async () => {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    },
  };
}

async function renderedPreview(item: string): Promise<string> {
  return renderToString(pickerProps().renderPreview?.(item), 120);
}

describe("QuickOpenDialog coverage swarm row 165", () => {
  beforeEach(() => {
    resetHarness();
  });

  test("keeps layout dimensions bounded at terminal breakpoints", () => {
    expect(
      computeQuickOpenLayout(
        undefined as unknown as number,
        undefined as unknown as number,
      ),
    ).toMatchObject({
      effectivePreviewLines: 0,
      maxPathWidth: 1,
      previewOnRight: false,
      previewWidth: 1,
      visibleResults: 1,
    });

    expect(computeQuickOpenLayout(119, 14)).toMatchObject({
      effectivePreviewLines: 3,
      previewOnRight: false,
      visibleResults: 1,
    });

    expect(computeQuickOpenLayout(120, 14)).toMatchObject({
      effectivePreviewLines: 1,
      maxPathWidth: 44,
      previewOnRight: true,
      previewWidth: 62,
      visibleResults: 1,
    });
  });

  test("ignores stale searches while normalizing only file suggestions", async () => {
    const rendered = await renderDialog();
    const firstSearch = deferred<Suggestion[]>();
    const secondSearch = deferred<Suggestion[]>();

    try {
      harness.generateFileSuggestions
        .mockReturnValueOnce(firstSearch.promise)
        .mockReturnValueOnce(secondSearch.promise);

      expect(pickerProps().title).toBe("Quick Open");
      expect(pickerProps().previewPosition).toBe("right");
      expect(pickerProps().visibleCount).toBe(1);
      expect(harness.registerOverlay).toHaveBeenCalledWith("quick-open");

      pickerProps().onQueryChange("old");
      await waitFor(
        () => harness.generateFileSuggestions.mock.calls.length === 1,
        "Quick open did not start the first search",
      );

      pickerProps().onQueryChange("new");
      await waitFor(
        () => harness.generateFileSuggestions.mock.calls.length === 2,
        "Quick open did not start the second search",
      );

      secondSearch.resolve([
        { id: "command-help", displayText: "help" },
        { id: "file-directory", displayText: `src${path.sep}` },
        { id: "file-new", displayText: path.join("src", "new.ts") },
      ]);
      await waitFor(
        () => pickerProps().items.join("\0") === "src/new.ts",
        "Quick open did not render filtered second-search results",
      );

      firstSearch.resolve([{ id: "file-old", displayText: "src/old.ts" }]);
      await sleep();
      expect(pickerProps().items).toEqual(["src/new.ts"]);

      pickerProps().onSelect("src/new.ts");
      expect(harness.openFileInExternalEditor).toHaveBeenCalledWith(
        "/workspace/project/src/new.ts",
      );
      expect(rendered.onDone).toHaveBeenCalledTimes(1);
    } finally {
      await rendered.dispose();
    }
  });

  test("aborts stale preview reads and resets the preview when focus clears", async () => {
    const rendered = await renderDialog();
    const slowPreview = deferred<{ content: string }>();
    const fastPreview = deferred<{ content: string }>();
    const previewSignals: AbortSignal[] = [];

    try {
      harness.readFileInRange.mockImplementation(
        (
          _file: string,
          _start: number,
          _lines: number,
          _encoding: undefined,
          signal: AbortSignal,
        ) => {
          previewSignals.push(signal);
          return previewSignals.length === 1
            ? slowPreview.promise
            : fastPreview.promise;
        },
      );

      pickerProps().onFocus?.("src/slow.ts");
      await waitFor(
        () => previewSignals.length === 1,
        "Quick open did not request the first preview",
      );

      pickerProps().onFocus?.("src/fast.ts");
      await waitFor(
        () => previewSignals.length === 2,
        "Quick open did not request the second preview",
      );
      expect(previewSignals[0]?.aborted).toBe(true);
      expect(harness.readFileInRange).toHaveBeenLastCalledWith(
        "/workspace/project/src/fast.ts",
        0,
        1,
        undefined,
        expect.any(AbortSignal),
      );

      slowPreview.resolve({ content: "stale preview" });
      fastPreview.resolve({ content: "fresh preview" });
      await waitFor(
        async () => (await renderedPreview("src/fast.ts")).includes("fresh preview"),
        "Quick open did not render the fresh preview",
      );
      expect(await renderedPreview("src/fast.ts")).not.toContain("stale preview");

      pickerProps().onFocus?.(undefined);
      await waitFor(
        async () =>
          (await renderedPreview("src/fast.ts")).includes("Loading preview..."),
        "Quick open did not clear the preview when focus cleared",
      );
    } finally {
      await rendered.dispose();
    }
  });

  test("reports preview failures and inserts paths through alternate picker actions", async () => {
    const rendered = await renderDialog();

    try {
      harness.generateFileSuggestions.mockResolvedValueOnce([
        { id: "file-broken", displayText: "src/broken.ts" },
      ]);
      harness.readFileInRange.mockRejectedValueOnce(new Error("cannot preview"));

      pickerProps().onQueryChange("broken");
      await waitFor(
        () => pickerProps().items.length === 1,
        "Quick open did not render the broken file result",
      );

      pickerProps().onFocus?.("src/broken.ts");
      await waitFor(
        async () =>
          (await renderedPreview("src/broken.ts")).includes(
            "(preview unavailable)",
          ),
        "Quick open did not render preview failure content",
      );

      pickerProps().onTab?.handler("src/broken.ts");
      expect(rendered.onInsert).toHaveBeenCalledWith("@src/broken.ts ");

      pickerProps().onShiftTab?.handler("src/broken.ts");
      expect(rendered.onInsert).toHaveBeenCalledWith("src/broken.ts ");
      expect(rendered.onDone).toHaveBeenCalledTimes(2);
    } finally {
      await rendered.dispose();
    }
  });
});
