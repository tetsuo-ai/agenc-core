import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { renderToString } from "../../utils/staticRender.js";
import { TEST_REMOTE_AUTH_SESSION_CONTEXT } from "../remoteAuthSessionContext.fixture.js";
import { ModelPicker } from "./ModelPicker.js";

const appStateMock = vi.hoisted(() => ({
  fastMode: false,
  effortValue: undefined as string | undefined,
  setAppState: vi.fn(),
}));

const fastModeMock = vi.hoisted(() => ({
  available: true,
  cooldown: false,
  enabled: false,
}));

const selectPropsMock = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | {
        defaultFocusValue: string | undefined;
        defaultValue: string;
        onCancel: () => void;
        onChange: (value: string) => void;
        onFocus: (value: string) => void;
        options: Array<{ label: string; value: string }>;
        visibleOptionCount: number;
      },
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
  useKeybindings: () => {},
}));

vi.mock("../state/AppState.js", () => ({
  useAppState: (selector: (state: { effortValue?: string; fastMode: boolean }) => unknown) =>
    selector({
      effortValue: appStateMock.effortValue,
      fastMode: appStateMock.fastMode,
    }),
  useSetAppState: () => appStateMock.setAppState,
}));

vi.mock("../../utils/fastMode.js", () => ({
  FAST_MODE_MODEL_DISPLAY: "fast-model",
  isFastModeAvailableForContext: () => fastModeMock.available,
  isFastModeCooldownForContext: () => fastModeMock.cooldown,
  isFastModeEnabledForContext: () => fastModeMock.enabled,
}));

vi.mock("../../utils/effort.js", () => ({
  convertEffortValueToLevelForContext: (value: string | undefined) => value,
  effortValueToReasoningEffort: (value: string | undefined) =>
    value === "max" || value === "xhigh" ? "xhigh" : value,
  getAvailableEffortLevelsForContext: (model: string) =>
    model.includes("basic")
      ? []
      : model.includes("max")
        ? ["low", "medium", "high", "max"]
        : ["low", "medium", "high"],
  getDefaultEffortForModelForContext: (model: string) =>
    model.includes("mini") ? undefined : "medium",
  modelSupportsEffortForContext: (model: string) => !model.includes("basic"),
  modelSupportsMaxEffort: (model: string) => model.includes("max"),
  reasoningEffortToEffortLevel: (value: string | undefined) =>
    value === "xhigh" ? "max" : value,
  resolvePickerEffortPersistence: (
    effort: string | undefined,
    defaultEffort: string,
  ) => effort ?? defaultEffort,
  toPersistableEffort: (effort: string | undefined) => effort,
}));

vi.mock("../../utils/model/model.js", () => ({
  getDefaultMainLoopModel: () => "gpt-5.4",
  modelDisplayString: (model: string) => `Display ${model}`,
  parseUserSpecifiedModel: (model: string) => model,
}));

vi.mock("../../utils/model/modelOptions.js", () => ({
  getModelOptions: () => [
    { value: null, label: "No preference", description: "Use default" },
    { value: "gpt-5.4", label: "GPT 5.4", description: "Default" },
    { value: "max-model", label: "Max Model", description: "Max effort" },
    { value: "basic-mini", label: "Basic Mini", description: "No effort" },
    ...Array.from({ length: 8 }, (_, index) => ({
      value: `extra-${index}`,
      label: `Extra ${index}`,
      description: "Overflow option",
    })),
  ],
}));

vi.mock("../../utils/settings/settings.js", () => ({
  getExecutionAuthoritySettings: () => ({}),
  getSettingsForSource: () => ({ reasoning_effort: "low" }),
  updateSettingsForSource: settingsMock.updateSettingsForSource,
}));

vi.mock("./CustomSelect/select.js", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");
  return {
    Select: (props: typeof selectPropsMock.current) => {
      selectPropsMock.current = props;
      const lines = [
        `focus ${props?.defaultFocusValue ?? ""}`,
        ...(props?.options
          .slice(0, props.visibleOptionCount)
          .map(option => option.label) ?? []),
      ];
      return ReactActual.createElement("ink-text", null, lines.join("\n"));
    },
  };
});

describe("ModelPicker rendering", () => {
  beforeEach(() => {
    appStateMock.fastMode = false;
    appStateMock.effortValue = undefined;
    appStateMock.setAppState.mockReset();
    fastModeMock.available = true;
    fastModeMock.cooldown = false;
    fastModeMock.enabled = false;
    selectPropsMock.current = undefined;
    settingsMock.updateSettingsForSource.mockReset();
  });

  test("renders session, overflow, effort, fast-mode, and standalone hints", async () => {
    fastModeMock.enabled = true;
    appStateMock.fastMode = true;
    appStateMock.effortValue = "medium";

    const output = await renderToString(
      <ModelPicker
        initial="legacy-model"
        sessionModel="plan-model"
        onSelect={() => {}}
        remoteAuthSessionContext={TEST_REMOTE_AUTH_SESSION_CONTEXT}
        isStandaloneCommand
        showFastModeNotice
        headerText="Choose carefully"
      />,
      { columns: 120 },
    );

    expect(output).toContain("Select model");
    expect(output).toContain("Choose carefully");
    expect(output).toContain("Currently using Display plan-model");
    expect(output).toContain("focus legacy-model");
    expect(output).toContain("and 3 more");
    expect(output).toContain("Medium effort (default)");
    expect(output).toContain("Fast mode is ON");
    expect(output).toContain("Enter");
    expect(output).toContain("Esc");
  });

  test("selects no preference and persists model effort when settings writes are enabled", async () => {
    const onSelect = vi.fn();

    await renderToString(
      <ModelPicker initial={null} onSelect={onSelect} remoteAuthSessionContext={TEST_REMOTE_AUTH_SESSION_CONTEXT} />,
      { columns: 120 },
    );

    expect(selectPropsMock.current?.defaultValue).toBe("__NO_PREFERENCE__");

    selectPropsMock.current?.onChange("__NO_PREFERENCE__");
    expect(onSelect).toHaveBeenCalledWith(null, undefined);
    expect(settingsMock.updateSettingsForSource).toHaveBeenCalledWith(
      "userSettings",
      { reasoning_effort: "medium" },
    );
    expect(appStateMock.setAppState).toHaveBeenCalledTimes(1);

    selectPropsMock.current?.onFocus("basic-mini");
    selectPropsMock.current?.onChange("gpt-5.4");
    expect(onSelect).toHaveBeenCalledWith("gpt-5.4", undefined);
  });

  test("can skip global settings writes", async () => {
    const onSelect = vi.fn();

    await renderToString(
      <ModelPicker initial="gpt-5.4" onSelect={onSelect} skipSettingsWrite remoteAuthSessionContext={TEST_REMOTE_AUTH_SESSION_CONTEXT} />,
      { columns: 120 },
    );

    selectPropsMock.current?.onChange("gpt-5.4");

    expect(onSelect).toHaveBeenCalledWith("gpt-5.4", undefined);
    expect(settingsMock.updateSettingsForSource).not.toHaveBeenCalled();
    expect(appStateMock.setAppState).not.toHaveBeenCalled();
  });
});
