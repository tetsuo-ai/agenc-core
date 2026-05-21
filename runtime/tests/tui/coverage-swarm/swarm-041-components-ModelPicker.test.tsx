import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { ModelPicker } from "../../../src/tui/components/ModelPicker.js";
import { renderToString } from "../../../src/utils/staticRender.js";

type AppState = {
  effortValue?: string;
  fastMode: boolean;
};

type ModelOption = {
  description: string;
  label: string;
  value: string | null;
};

type SelectProps = {
  defaultFocusValue: string | undefined;
  defaultValue: string;
  onCancel: () => void;
  onChange: (value: string) => void;
  onFocus: (value: string | undefined) => void;
  options: Array<{ label: string; value: string }>;
  visibleOptionCount: number;
};

const harness = vi.hoisted(() => ({
  appState: {
    effortValue: undefined as string | undefined,
    fastMode: false,
  },
  defaultEfforts: new Map<string, string | undefined>(),
  defaultModel: "default-model",
  exitState: {
    keyName: "Ctrl+Q",
    pending: false,
  },
  fastMode: {
    available: true,
    cooldown: false,
    enabled: false,
  },
  keybindings: undefined as Record<string, () => void> | undefined,
  logEvent: vi.fn(),
  maxModels: new Set<string>(),
  options: [] as ModelOption[],
  persistEfforts: true,
  selectProps: undefined as SelectProps | undefined,
  setAppState: vi.fn(),
  settingsEffort: undefined as string | undefined,
  unsupportedModels: new Set<string>(),
  updateSettingsForSource: vi.fn(),
}));

vi.mock("src/tui/hooks/useExitOnCtrlCDWithKeybindings.js", () => ({
  useExitOnCtrlCDWithKeybindings: () => harness.exitState,
}));

vi.mock("../keybindings/useKeybinding.js", () => ({
  useKeybindings: (bindings: Record<string, () => void>) => {
    harness.keybindings = bindings;
  },
}));

vi.mock("../state/AppState.js", () => ({
  useAppState: (selector: (state: AppState) => unknown) =>
    selector(harness.appState),
  useSetAppState: () => (updater: (state: AppState) => AppState) => {
    harness.setAppState(updater);
    harness.appState = updater(harness.appState);
  },
}));

vi.mock("../../services/analytics/index.js", () => ({
  logEvent: harness.logEvent,
}));

vi.mock("../../utils/fastMode.js", () => ({
  FAST_MODE_MODEL_DISPLAY: "fast-model",
  isFastModeAvailable: () => harness.fastMode.available,
  isFastModeCooldown: () => harness.fastMode.cooldown,
  isFastModeEnabled: () => harness.fastMode.enabled,
}));

vi.mock("../../utils/effort.js", () => ({
  convertEffortValueToLevel: (value: string | undefined) => value,
  getDefaultEffortForModel: (model: string) => harness.defaultEfforts.get(model),
  modelSupportsEffort: (model: string) =>
    !harness.unsupportedModels.has(model),
  modelSupportsMaxEffort: (model: string) => harness.maxModels.has(model),
  resolvePickerEffortPersistence: (
    effort: string | undefined,
    defaultEffort: string,
    persistedEffort: string | undefined,
    hasToggledEffort: boolean,
  ) => (hasToggledEffort ? effort : effort ?? persistedEffort ?? defaultEffort),
  toPersistableEffort: (effort: string | undefined) =>
    harness.persistEfforts ? effort : undefined,
}));

vi.mock("../../utils/model/model.js", () => ({
  getDefaultMainLoopModel: () => harness.defaultModel,
  modelDisplayString: (model: string) => `Display ${model}`,
  parseUserSpecifiedModel: (model: string) => model,
}));

vi.mock("../../utils/model/modelOptions.js", () => ({
  getModelOptions: () => harness.options,
}));

vi.mock("../../utils/settings/settings.js", () => ({
  getSettingsForSource: () => ({ effortLevel: harness.settingsEffort }),
  updateSettingsForSource: harness.updateSettingsForSource,
}));

vi.mock("../components/CustomSelect/select.js", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");

  return {
    Select: (props: SelectProps) => {
      harness.selectProps = props;
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

describe("ModelPicker coverage swarm 041", () => {
  beforeEach(() => {
    harness.appState = {
      effortValue: undefined,
      fastMode: false,
    };
    harness.defaultEfforts = new Map<string, string | undefined>([
      ["default-model", "medium"],
    ]);
    harness.defaultModel = "default-model";
    harness.exitState = {
      keyName: "Ctrl+Q",
      pending: false,
    };
    harness.fastMode = {
      available: true,
      cooldown: false,
      enabled: false,
    };
    harness.keybindings = undefined;
    harness.logEvent.mockReset();
    harness.maxModels = new Set<string>();
    harness.options = [
      {
        description: "Use default",
        label: "Default Model",
        value: "default-model",
      },
    ];
    harness.persistEfforts = true;
    harness.selectProps = undefined;
    harness.setAppState.mockReset();
    harness.settingsEffort = undefined;
    harness.unsupportedModels = new Set<string>();
    harness.updateSettingsForSource.mockReset();
  });

  test("handles an empty option list and non-persistable default effort", async () => {
    harness.defaultEfforts = new Map<string, string | undefined>([
      ["default-basic", undefined],
    ]);
    harness.defaultModel = "default-basic";
    harness.options = [];
    harness.persistEfforts = false;
    harness.unsupportedModels = new Set(["default-basic"]);

    const onSelect = vi.fn();
    const output = await renderToString(
      <ModelPicker initial={null} onSelect={onSelect} />,
      { columns: 120 },
    );

    expect(output).toContain("Effort not supported");
    expect(harness.selectProps).toMatchObject({
      defaultFocusValue: undefined,
      defaultValue: "__NO_PREFERENCE__",
      options: [],
      visibleOptionCount: 0,
    });

    harness.selectProps?.onChange("__NO_PREFERENCE__");

    expect(harness.logEvent).toHaveBeenCalledWith(
      "tengu_model_command_menu_effort",
      { effort: undefined },
    );
    expect(onSelect).toHaveBeenCalledWith(null, undefined);
    expect(harness.updateSettingsForSource).not.toHaveBeenCalled();
    expect(harness.setAppState).toHaveBeenCalledTimes(1);
    expect(harness.appState.effortValue).toBe("high");
  });

  test("suppresses the fast-mode prompt when fast mode cannot be enabled", async () => {
    harness.fastMode = {
      available: false,
      cooldown: false,
      enabled: true,
    };
    harness.exitState = {
      keyName: "Ctrl+Q",
      pending: true,
    };

    const unavailableOutput = await renderToString(
      <ModelPicker initial="default-model" isStandaloneCommand onSelect={() => {}} />,
      { columns: 120 },
    );

    expect(unavailableOutput).toContain("Press Ctrl+Q again to exit");
    expect(unavailableOutput).not.toContain("Use /fast");
    expect(unavailableOutput).not.toContain("Fast mode is ON");

    harness.fastMode = {
      available: true,
      cooldown: true,
      enabled: true,
    };
    harness.exitState = {
      keyName: "Ctrl+Q",
      pending: false,
    };

    const cooldownOutput = await renderToString(
      <ModelPicker initial="default-model" onSelect={() => {}} />,
      { columns: 120 },
    );

    expect(cooldownOutput).not.toContain("Use /fast");
    expect(cooldownOutput).not.toContain("Fast mode is ON");
  });
});
