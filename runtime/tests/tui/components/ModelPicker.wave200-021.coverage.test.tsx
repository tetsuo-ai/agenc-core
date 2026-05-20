import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { createRoot } from "../ink/root.js";
import { ModelPicker } from "./ModelPicker.js";

type AppState = {
  effortValue?: string;
  fastMode: boolean;
};

type SelectProps = {
  defaultFocusValue: string | undefined;
  defaultValue: string;
  onCancel: () => void;
  onChange: (value: string) => void;
  onFocus: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  visibleOptionCount: number;
};

type ModelPickerKeybindings = {
  "modelPicker:decreaseEffort": () => void;
  "modelPicker:increaseEffort": () => void;
};

const appStateMock = vi.hoisted(() => ({
  setAppState: vi.fn(),
  state: {
    effortValue: "max" as string | undefined,
    fastMode: false,
  },
}));

const fastModeMock = vi.hoisted(() => ({
  available: true,
  cooldown: false,
  enabled: true,
}));

const keybindingsMock = vi.hoisted(() => ({
  current: undefined as ModelPickerKeybindings | undefined,
}));

const selectPropsMock = vi.hoisted(() => ({
  current: undefined as SelectProps | undefined,
}));

const settingsMock = vi.hoisted(() => ({
  updateSettingsForSource: vi.fn(),
}));

vi.mock("src/tui/hooks/useExitOnCtrlCDWithKeybindings.js", () => ({
  useExitOnCtrlCDWithKeybindings: () => ({
    keyName: "Ctrl+D",
    pending: false,
  }),
}));

vi.mock("../keybindings/useKeybinding.js", () => ({
  useKeybindings: (bindings: ModelPickerKeybindings) => {
    keybindingsMock.current = bindings;
  },
}));

vi.mock("../state/AppState.js", () => ({
  useAppState: (selector: (state: AppState) => unknown) =>
    selector(appStateMock.state),
  useSetAppState: () => (updater: (state: AppState) => AppState) => {
    appStateMock.setAppState(updater);
    appStateMock.state = updater(appStateMock.state);
  },
}));

vi.mock("../../services/analytics/index.js", () => ({
  logEvent: () => {},
}));

vi.mock("../../utils/fastMode.js", () => ({
  FAST_MODE_MODEL_DISPLAY: "fast-model",
  isFastModeAvailable: () => fastModeMock.available,
  isFastModeCooldown: () => fastModeMock.cooldown,
  isFastModeEnabled: () => fastModeMock.enabled,
}));

vi.mock("../../utils/effort.js", () => ({
  convertEffortValueToLevel: (value: string | undefined) => value,
  getDefaultEffortForModel: (model: string) => {
    if (model === "basic-mini") return undefined;
    if (model === "max-model") return "max";
    return "medium";
  },
  modelSupportsEffort: (model: string) => model !== "basic-mini",
  modelSupportsMaxEffort: (model: string) => model === "max-model",
  resolvePickerEffortPersistence: (
    effort: string | undefined,
    defaultEffort: string,
    _persistedEffort: string | undefined,
    hasToggledEffort: boolean,
  ) => (hasToggledEffort ? effort : defaultEffort),
  toPersistableEffort: (effort: string | undefined) => effort,
}));

vi.mock("../../utils/model/model.js", () => ({
  getDefaultMainLoopModel: () => "standard-model",
  modelDisplayString: (model: string) => `Display ${model}`,
  parseUserSpecifiedModel: (model: string) => model,
}));

vi.mock("../../utils/model/modelOptions.js", () => ({
  getModelOptions: () => [
    {
      value: "standard-model",
      label: "Standard Model",
      description: "No max effort",
    },
    {
      value: "max-model",
      label: "Max Model",
      description: "Supports max effort",
    },
    {
      value: "basic-mini",
      label: "Basic Mini",
      description: "No effort support",
    },
  ],
}));

vi.mock("../../utils/settings/settings.js", () => ({
  getSettingsForSource: () => ({ effortLevel: "medium" }),
  updateSettingsForSource: settingsMock.updateSettingsForSource,
}));

vi.mock("./CustomSelect/select.js", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");
  return {
    Select: (props: SelectProps) => {
      selectPropsMock.current = props;
      return ReactActual.createElement(
        "ink-text",
        null,
        props.options
          .slice(0, props.visibleOptionCount)
          .map(option => option.label)
          .join("\n"),
      );
    },
  };
});

const waitForRender = () => new Promise(resolve => setTimeout(resolve, 30));

describe("ModelPicker coverage worker 021", () => {
  beforeEach(() => {
    appStateMock.setAppState.mockReset();
    appStateMock.state = {
      effortValue: "max",
      fastMode: false,
    };
    fastModeMock.available = true;
    fastModeMock.cooldown = false;
    fastModeMock.enabled = true;
    keybindingsMock.current = undefined;
    selectPropsMock.current = undefined;
    settingsMock.updateSettingsForSource.mockReset();
  });

  test("cycles effort keybindings and keeps unsupported selections from returning effort", async () => {
    const onSelect = vi.fn();
    let output = "";
    const stdout = new PassThrough();
    stdout.on("data", chunk => {
      output += chunk.toString();
    });
    (stdout as unknown as { columns: number }).columns = 120;

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

    const root = await createRoot({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    });

    try {
      root.render(
        <ModelPicker
          initial="standard-model"
          isStandaloneCommand
          onSelect={onSelect}
        />,
      );
      await waitForRender();

      expect(stripAnsi(output)).toContain("High effort");
      expect(stripAnsi(output)).toContain("Use /fast");
      expect(selectPropsMock.current?.defaultFocusValue).toBe("standard-model");

      keybindingsMock.current?.["modelPicker:increaseEffort"]();
      await waitForRender();
      selectPropsMock.current?.onChange("standard-model");
      expect(onSelect).toHaveBeenLastCalledWith("standard-model", "low");
      expect(settingsMock.updateSettingsForSource).toHaveBeenLastCalledWith(
        "userSettings",
        { effortLevel: "low" },
      );

      selectPropsMock.current?.onFocus("max-model");
      await waitForRender();
      keybindingsMock.current?.["modelPicker:decreaseEffort"]();
      await waitForRender();
      selectPropsMock.current?.onChange("max-model");
      expect(onSelect).toHaveBeenLastCalledWith("max-model", "max");
      expect(settingsMock.updateSettingsForSource).toHaveBeenLastCalledWith(
        "userSettings",
        { effortLevel: "max" },
      );

      selectPropsMock.current?.onFocus("basic-mini");
      await waitForRender();
      keybindingsMock.current?.["modelPicker:increaseEffort"]();
      await waitForRender();
      selectPropsMock.current?.onChange("basic-mini");
      expect(onSelect).toHaveBeenLastCalledWith("basic-mini", undefined);

      selectPropsMock.current?.onCancel();
      expect(appStateMock.setAppState).toHaveBeenCalledTimes(3);
      expect(appStateMock.state.effortValue).toBe("max");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});
