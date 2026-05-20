import { PassThrough } from "node:stream";
import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { createRoot } from "../../ink/root.js";
import { SelectInputOption } from "./select-input-option.js";

const keybindingMock = vi.hoisted(() => ({
  single: new Map<
    string,
    Array<{
      handler: () => void | Promise<void>;
      options: { isActive?: boolean };
    }>
  >(),
  multi: undefined as
    | undefined
    | {
        handlers: Record<string, () => void>;
        options: { isActive?: boolean };
      },
}));

const textInputMock = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | {
        onChange: (value: string) => void;
        onChangeCursorOffset: (offset: number) => void;
        onExit: () => void;
        onImagePaste?: (base64: string) => void;
        onPaste: (value: string) => void;
        onSubmit: (value: string) => void;
        placeholder?: string;
        value: string;
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

vi.mock("../../keybindings/useKeybinding.js", () => ({
  useKeybinding: (
    action: string,
    handler: () => void | Promise<void>,
    options: { isActive?: boolean },
  ) => {
    const existing = keybindingMock.single.get(action) ?? [];
    existing.push({ handler, options });
    keybindingMock.single.set(action, existing);
  },
  useKeybindings: (
    handlers: Record<string, () => void>,
    options: { isActive?: boolean },
  ) => {
    keybindingMock.multi = { handlers, options };
  },
}));

vi.mock("../../ink.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../ink.js")>();
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

vi.mock("../TextInput.js", async () => {
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

vi.mock("../ClickableImageRef.js", async () => {
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

vi.mock("../ConfigurableShortcutHint.js", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");
  return {
    ConfigurableShortcutHint: ({
      fallback,
      description,
    }: {
      fallback: string;
      description: string;
    }) => ReactActual.createElement("ink-text", null, `${fallback} ${description}`),
  };
});

vi.mock("../../../utils/imagePaste.js", () => ({
  getImageFromClipboard: async () => ({
    base64: "image-bytes",
    dimensions: { height: 20, width: 10 },
    mediaType: "image/png",
  }),
}));

function makeInputOption(onChange = vi.fn()) {
  return {
    description: "Prompt description",
    dimDescription: false,
    label: "Prompt",
    labelValueSeparator: ": ",
    onChange,
    placeholder: "Write prompt",
    showLabelWithValue: true,
    type: "input",
  } as const;
}

async function renderOptionToText(node: React.ReactNode): Promise<string> {
  let output = "";
  const stdout = new PassThrough();
  stdout.on("data", chunk => {
    output += chunk.toString();
  });

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number }).columns = 100;

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });

  try {
    root.render(node);
    await new Promise(resolve => setTimeout(resolve, 30));
    return stripAnsi(output);
  } finally {
    root.unmount();
    stdin.end();
  }
}

describe("SelectInputOption rendering", () => {
  beforeEach(() => {
    keybindingMock.single.clear();
    keybindingMock.multi = undefined;
    textInputMock.current = undefined;
    inputMock.current = undefined;
  });

  test("renders focused labeled input with image attachments and wires handlers", async () => {
    const optionOnChange = vi.fn();
    const onInputChange = vi.fn();
    const onSubmit = vi.fn();
    const onExit = vi.fn();
    const onOpenEditor = vi.fn();
    const onImagePaste = vi.fn();
    const onRemoveImage = vi.fn();
    const onImagesSelectedChange = vi.fn();
    const onSelectedImageIndexChange = vi.fn();

    const output = await renderOptionToText(
      <SelectInputOption
        option={makeInputOption(optionOnChange)}
        isFocused
        isSelected
        shouldShowDownArrow
        shouldShowUpArrow={false}
        maxIndexWidth={2}
        index={3}
        inputValue="abc"
        onInputChange={onInputChange}
        onSubmit={onSubmit}
        onExit={onExit}
        layout="expanded"
        showLabel
        onOpenEditor={onOpenEditor}
        resetCursorOnUpdate
        onImagePaste={onImagePaste}
        pastedContents={{
          1: { id: 1, type: "image" },
          2: { id: 2, type: "text", text: "ignored" },
          3: { id: 3, type: "image" },
        } as never}
        onRemoveImage={onRemoveImage}
        imagesSelected
        selectedImageIndex={1}
        onImagesSelectedChange={onImagesSelectedChange}
        onSelectedImageIndexChange={onSelectedImageIndexChange}
      />,
    );

    expect(output).toContain("3.");
    expect(output).toContain("Prompt");
    expect(output).toContain("abc");
    expect(output).toContain("Prompt description");
    expect(output).toContain("[image 1]");
    expect(output).toContain("[image 3 selected]");
    expect(output).toContain("right next");
    expect(output).toContain("backspace remove");

    textInputMock.current?.onChange("changed");
    expect(onInputChange).toHaveBeenCalledWith("changed");
    expect(optionOnChange).toHaveBeenCalledWith("changed");

    textInputMock.current?.onPaste("!");
    expect(onInputChange).toHaveBeenCalledWith("abc!");
    expect(optionOnChange).toHaveBeenCalledWith("abc!");

    textInputMock.current?.onSubmit("final");
    textInputMock.current?.onExit();
    expect(onSubmit).toHaveBeenCalledWith("final");
    expect(onExit).toHaveBeenCalledTimes(1);

    await keybindingMock.single.get("chat:externalEditor")?.[0]?.handler();
    expect(onOpenEditor).toHaveBeenCalledWith("abc", onInputChange);

    await keybindingMock.single.get("chat:imagePaste")?.[0]?.handler();
    expect(onImagePaste).toHaveBeenCalledWith(
      "image-bytes",
      "image/png",
      undefined,
      { height: 20, width: 10 },
    );

    keybindingMock.multi?.handlers["attachments:next"]();
    expect(onSelectedImageIndexChange).toHaveBeenCalledWith(0);

    keybindingMock.multi?.handlers["attachments:previous"]();
    expect(onSelectedImageIndexChange).toHaveBeenCalledWith(0);

    keybindingMock.multi?.handlers["attachments:remove"]();
    expect(onRemoveImage).toHaveBeenCalledWith(3);
    expect(onSelectedImageIndexChange).toHaveBeenCalledWith(0);

    keybindingMock.multi?.handlers["attachments:exit"]();
    inputMock.current?.handler("", { upArrow: true });
    expect(onImagesSelectedChange).toHaveBeenCalledWith(false);
  });

  test("renders placeholder branch and removes the last image before image selection", async () => {
    const onRemoveImage = vi.fn();
    const onImagesSelectedChange = vi.fn();

    const output = await renderOptionToText(
      <SelectInputOption
        option={{ ...makeInputOption(), showLabelWithValue: false }}
        isFocused
        isSelected={false}
        shouldShowDownArrow={false}
        shouldShowUpArrow
        maxIndexWidth={1}
        index={1}
        inputValue=""
        onInputChange={() => {}}
        onSubmit={() => {}}
        layout="compact"
        pastedContents={{ 4: { id: 4, type: "image" } } as never}
        onRemoveImage={onRemoveImage}
        imagesSelected={false}
        onImagesSelectedChange={onImagesSelectedChange}
      />,
    );

    expect(output).toContain("1.");
    expect(output).toContain("Write prompt");
    expect(output).toContain("[image 4]");

    keybindingMock.single
      .get("attachments:remove")
      ?.find(binding => binding.options.isActive)
      ?.handler();
    expect(onRemoveImage).toHaveBeenCalledWith(4);
  });

  test("clears image selection when focus leaves the input", async () => {
    const onImagesSelectedChange = vi.fn();

    await renderOptionToText(
      <SelectInputOption
        option={makeInputOption()}
        isFocused={false}
        isSelected={false}
        shouldShowDownArrow={false}
        shouldShowUpArrow={false}
        maxIndexWidth={1}
        index={1}
        inputValue="done"
        onInputChange={() => {}}
        onSubmit={() => {}}
        layout="compact"
        imagesSelected
        onImagesSelectedChange={onImagesSelectedChange}
      />,
    );

    expect(onImagesSelectedChange).toHaveBeenCalledWith(false);
  });
});
