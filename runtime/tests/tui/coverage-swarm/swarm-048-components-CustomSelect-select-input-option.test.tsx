import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRoot } from "../../../src/tui/ink/root.js";
import {
  computeSelectInputColumns,
  SelectInputOption,
} from "../../../src/tui/components/CustomSelect/select-input-option.js";
import { logError } from "../../../src/utils/log.js";

const keybindingMock = vi.hoisted(() => ({
  single: new Map<
    string,
    Array<{
      handler: () => void | Promise<void>;
      options: { context?: string; isActive?: boolean };
    }>
  >(),
  multi: undefined as
    | undefined
    | {
        handlers: Record<string, () => void>;
        options: { context?: string; isActive?: boolean };
      },
}));

const inputMock = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | {
        handler: (_input: string, key: { upArrow?: boolean }) => void;
        options: { isActive?: boolean };
      },
}));

const textInputMock = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | {
        columns: number;
        cursorOffset: number;
        focus: boolean;
        onChange: (value: string) => void;
        onChangeCursorOffset: (offset: number) => void;
        onExit?: () => void;
        onImagePaste?: (base64: string) => void;
        onPaste: (value: string) => void;
        onSubmit: (value: string) => void;
        placeholder?: string;
        value: string;
      },
}));

const imagePasteMock = vi.hoisted(() => {
  const state = {
    result: undefined as
      | undefined
      | {
          base64: string;
          dimensions?: { height: number; width: number };
          mediaType?: string;
        },
    getImageFromClipboard: vi.fn(async () => state.result),
  };

  return state;
});

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybinding: (
    action: string,
    handler: () => void | Promise<void>,
    options: { context?: string; isActive?: boolean },
  ) => {
    const bindings = keybindingMock.single.get(action) ?? [];
    bindings.push({ handler, options });
    keybindingMock.single.set(action, bindings);
  },
  useKeybindings: (
    handlers: Record<string, () => void>,
    options: { context?: string; isActive?: boolean },
  ) => {
    keybindingMock.multi = { handlers, options };
  },
}));

vi.mock("../../../src/tui/ink.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/tui/ink.js")>();

  return {
    ...actual,
    useInput: (
      handler: (_input: string, key: { upArrow?: boolean }) => void,
      options: { isActive?: boolean },
    ) => {
      inputMock.current = { handler, options };
    },
  };
});

vi.mock("../../../src/tui/components/TextInput.js", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");

  return {
    default: (props: typeof textInputMock.current) => {
      textInputMock.current = props;

      return ReactActual.createElement(
        "ink-text",
        null,
        props?.value || props?.placeholder || "",
      );
    },
  };
});

vi.mock("../../../src/tui/components/ClickableImageRef.js", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");

  return {
    ClickableImageRef: ({
      imageId,
      isSelected,
    }: {
      imageId: number;
      isSelected?: boolean;
    }) =>
      ReactActual.createElement(
        "ink-text",
        null,
        isSelected ? `[image ${imageId} selected]` : `[image ${imageId}]`,
      ),
  };
});

vi.mock("../../../src/tui/components/ConfigurableShortcutHint.js", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");

  return {
    ConfigurableShortcutHint: ({
      description,
      fallback,
    }: {
      description: string;
      fallback: string;
    }) => ReactActual.createElement("ink-text", null, `${fallback} ${description}`),
  };
});

vi.mock("../../../src/utils/imagePaste.js", () => ({
  getImageFromClipboard: imagePasteMock.getImageFromClipboard,
}));

vi.mock("../../../src/utils/log.js", () => ({
  logError: vi.fn(),
}));

type TestRoot = Awaited<ReturnType<typeof createRoot>>;

const mountedRoots: Array<{ root: TestRoot; stdin: PassThrough }> = [];

function inputOption(overrides = {}) {
  return {
    description: "Prompt details",
    dimDescription: true,
    label: "Prompt",
    labelValueSeparator: ": ",
    onChange: vi.fn(),
    placeholder: "Write prompt",
    showLabelWithValue: true,
    type: "input",
    ...overrides,
  } as const;
}

async function waitForRender(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 30));
}

async function renderOption(node: React.ReactNode): Promise<() => string> {
  let output = "";
  const stdout = new PassThrough();
  stdout.on("data", chunk => {
    output += chunk.toString();
  });

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number }).columns = 80;

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  mountedRoots.push({ root, stdin });

  root.render(node);
  await waitForRender();

  return () => stripAnsi(output);
}

describe("computeSelectInputColumns coverage", () => {
  test("floors fractional terminal measurements before reserving input chrome", () => {
    expect(computeSelectInputColumns(40.9, 2.9, true, "Prompt", ": ")).toBe(26);
  });

  test("clamps non-positive terminal measurements to one usable column", () => {
    expect(computeSelectInputColumns(0, -4, true, "Prompt")).toBe(1);
  });
});

describe("SelectInputOption coverage", () => {
  beforeEach(() => {
    keybindingMock.single.clear();
    keybindingMock.multi = undefined;
    inputMock.current = undefined;
    textInputMock.current = undefined;
    imagePasteMock.result = undefined;
    imagePasteMock.getImageFromClipboard.mockClear();
    vi.mocked(logError).mockClear();
  });

  afterEach(() => {
    for (const { root, stdin } of mountedRoots.splice(0)) {
      root.unmount();
      stdin.end();
    }
  });

  test("renders an unfocused labeled value and filters pasted content to images", async () => {
    const text = await renderOption(
      <SelectInputOption
        option={inputOption()}
        isFocused={false}
        isSelected={false}
        shouldShowDownArrow={false}
        shouldShowUpArrow={false}
        maxIndexWidth={2}
        index={7}
        inputValue="saved prompt"
        onInputChange={() => {}}
        onSubmit={() => {}}
        layout="expanded"
        pastedContents={{
          1: { id: 1, type: "text", text: "ignored paste" },
          2: { id: 2, type: "image" },
        } as never}
      />,
    );

    expect(text()).toContain("7.");
    expect(text()).toContain("Prompt");
    expect(text()).toContain(": saved prompt");
    expect(text()).toContain("Prompt details");
    expect(text()).toContain("[image 2]");
    expect(text()).not.toContain("ignored paste");

    await keybindingMock.single.get("chat:imagePaste")?.at(-1)?.handler();
    expect(imagePasteMock.getImageFromClipboard).not.toHaveBeenCalled();
    expect(
      keybindingMock.single.get("chat:externalEditor")?.at(-1)?.options.isActive,
    ).toBe(false);
  });

  test("leaves image paste callback untouched when the clipboard has no image", async () => {
    const onImagePaste = vi.fn();

    await renderOption(
      <SelectInputOption
        option={inputOption({ showLabelWithValue: false })}
        isFocused
        isSelected={false}
        shouldShowDownArrow={false}
        shouldShowUpArrow={false}
        maxIndexWidth={1}
        index={1}
        inputValue=""
        onInputChange={() => {}}
        onSubmit={() => {}}
        layout="compact"
        onImagePaste={onImagePaste}
      />,
    );

    await keybindingMock.single.get("chat:imagePaste")?.at(-1)?.handler();

    expect(imagePasteMock.getImageFromClipboard).toHaveBeenCalledTimes(1);
    expect(onImagePaste).not.toHaveBeenCalled();
  });

  test("logs rejected image paste shortcut lookups without routing image callbacks", async () => {
    const error = new Error("clipboard read failed");
    imagePasteMock.getImageFromClipboard.mockRejectedValueOnce(error);
    const onImagePaste = vi.fn();

    await renderOption(
      <SelectInputOption
        option={inputOption({ showLabelWithValue: false })}
        isFocused
        isSelected={false}
        shouldShowDownArrow={false}
        shouldShowUpArrow={false}
        maxIndexWidth={1}
        index={1}
        inputValue=""
        onInputChange={() => {}}
        onSubmit={() => {}}
        layout="compact"
        onImagePaste={onImagePaste}
      />,
    );

    await keybindingMock.single.get("chat:imagePaste")?.at(-1)?.handler();
    await waitForRender();

    expect(imagePasteMock.getImageFromClipboard).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(error);
    expect(onImagePaste).not.toHaveBeenCalled();
  });

  test("uses single-image attachment controls without cycling selection", async () => {
    const onImagesSelectedChange = vi.fn();
    const onRemoveImage = vi.fn();
    const onSelectedImageIndexChange = vi.fn();

    const text = await renderOption(
      <SelectInputOption
        option={inputOption()}
        isFocused
        isSelected
        shouldShowDownArrow={false}
        shouldShowUpArrow={false}
        maxIndexWidth={1}
        index={2}
        inputValue=""
        onInputChange={() => {}}
        onSubmit={() => {}}
        layout="compact"
        pastedContents={{ 5: { id: 5, type: "image" } } as never}
        imagesSelected
        selectedImageIndex={0}
        onImagesSelectedChange={onImagesSelectedChange}
        onRemoveImage={onRemoveImage}
        onSelectedImageIndexChange={onSelectedImageIndexChange}
      />,
    );

    expect(text()).toContain("[image 5 selected]");
    expect(text()).toContain("backspace remove");
    expect(text()).toContain("esc cancel");
    expect(text()).not.toContain("right next");

    keybindingMock.multi?.handlers["attachments:next"]();
    keybindingMock.multi?.handlers["attachments:previous"]();
    expect(onSelectedImageIndexChange).not.toHaveBeenCalled();

    keybindingMock.multi?.handlers["attachments:remove"]();
    expect(onRemoveImage).toHaveBeenCalledWith(5);
    expect(onImagesSelectedChange).toHaveBeenCalledWith(false);

    inputMock.current?.handler("", {});
    expect(onImagesSelectedChange).toHaveBeenCalledTimes(1);

    inputMock.current?.handler("", { upArrow: true });
    expect(onImagesSelectedChange).toHaveBeenCalledTimes(2);
    expect(onImagesSelectedChange).toHaveBeenLastCalledWith(false);
  });

  test("does not remove an attachment when selected image index is out of range", async () => {
    const onImagesSelectedChange = vi.fn();
    const onRemoveImage = vi.fn();

    await renderOption(
      <SelectInputOption
        option={inputOption()}
        isFocused
        isSelected={false}
        shouldShowDownArrow={false}
        shouldShowUpArrow={false}
        maxIndexWidth={1}
        index={3}
        inputValue=""
        onInputChange={() => {}}
        onSubmit={() => {}}
        layout="compact"
        pastedContents={{ 8: { id: 8, type: "image" } } as never}
        imagesSelected
        selectedImageIndex={3}
        onImagesSelectedChange={onImagesSelectedChange}
        onRemoveImage={onRemoveImage}
      />,
    );

    keybindingMock.multi?.handlers["attachments:remove"]();

    expect(onRemoveImage).not.toHaveBeenCalled();
    expect(onImagesSelectedChange).not.toHaveBeenCalled();
  });
});
