import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { AutoModeOptInDialog } from "../../../src/tui/components/AutoModeOptInDialog.js";
import { renderToString } from "../../../src/utils/staticRender.js";

type SelectOption = {
  label: string;
  value: "accept" | "accept-default" | "decline";
};

type SelectProps = {
  onCancel: () => void;
  onChange: (value: string) => void;
  options: SelectOption[];
};

type DialogProps = {
  children: React.ReactNode;
  color?: string;
  onCancel: () => void;
  title: React.ReactNode;
};

const harness = vi.hoisted(() => ({
  dialogProps: [] as DialogProps[],
  selectProps: [] as SelectProps[],
  updateSettingsForSource: vi.fn(),
}));

vi.mock("../../../src/utils/settings/settings.js", () => ({
  updateSettingsForSource: harness.updateSettingsForSource,
}));

vi.mock("../../../src/tui/components/CustomSelect/select.js", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");

  return {
    Select: (props: SelectProps) => {
      harness.selectProps.push(props);

      return ReactActual.createElement(
        "ink-text",
        null,
        props.options.map(option => option.label).join("\n"),
      );
    },
  };
});

vi.mock("../../../src/tui/components/design-system/Dialog.js", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");

  return {
    Dialog: (props: DialogProps) => {
      harness.dialogProps.push(props);

      return ReactActual.createElement(
        "ink-box",
        null,
        ReactActual.createElement(
          "ink-text",
          null,
          `Dialog:${String(props.title)}:${props.color ?? "none"}`,
        ),
        props.children,
      );
    },
  };
});

async function renderDialog(
  props: Partial<React.ComponentProps<typeof AutoModeOptInDialog>> = {},
): Promise<string> {
  return renderToString(
    <AutoModeOptInDialog
      onAccept={vi.fn()}
      onDecline={vi.fn()}
      {...props}
    />,
    { columns: 120, rows: 24 },
  );
}

function latestSelectProps(): SelectProps {
  const props = harness.selectProps.at(-1);
  expect(props).toBeDefined();
  return props!;
}

describe("AutoModeOptInDialog coverage swarm row 107", () => {
  beforeEach(() => {
    harness.dialogProps = [];
    harness.selectProps = [];
    harness.updateSettingsForSource.mockReset();
  });

  test("renders the warning dialog with the default decline label", async () => {
    const onDecline = vi.fn();
    const output = await renderDialog({ onDecline });

    expect(output).toContain("Dialog:Enable auto mode?:warning");
    expect(output).toContain(
      "Auto mode lets AgenC handle permission prompts automatically",
    );
    expect(latestSelectProps().options).toEqual([
      {
        label: "Yes, and make it my default mode",
        value: "accept-default",
      },
      {
        label: "Yes, enable auto mode",
        value: "accept",
      },
      {
        label: "No, go back",
        value: "decline",
      },
    ]);
    expect(harness.dialogProps.at(-1)).toMatchObject({
      color: "warning",
      title: "Enable auto mode?",
    });
    expect(harness.dialogProps.at(-1)?.onCancel).toEqual(expect.any(Function));
  });

  test("uses the exit decline label for startup gating", async () => {
    await renderDialog({ declineExits: true });

    expect(latestSelectProps().options.at(-1)).toEqual({
      label: "No, exit",
      value: "decline",
    });
  });

  test("accept stores the skip-prompt setting and accepts the dialog", async () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    await renderDialog({ onAccept, onDecline });

    latestSelectProps().onChange("accept");

    expect(harness.updateSettingsForSource).toHaveBeenCalledWith(
      "userSettings",
      {
        skipAutoPermissionPrompt: true,
      },
    );
    expect(onAccept).toHaveBeenCalledOnce();
    expect(onDecline).not.toHaveBeenCalled();
  });

  test("accept-default also stores auto as the default permission mode", async () => {
    const onAccept = vi.fn();
    await renderDialog({ onAccept });

    latestSelectProps().onChange("accept-default");

    expect(harness.updateSettingsForSource).toHaveBeenCalledWith(
      "userSettings",
      {
        permissions: {
          defaultMode: "auto",
        },
        skipAutoPermissionPrompt: true,
      },
    );
    expect(onAccept).toHaveBeenCalledOnce();
  });

  test("decline routes through the decline handler without changing settings", async () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    await renderDialog({ onAccept, onDecline });

    latestSelectProps().onChange("decline");

    expect(harness.updateSettingsForSource).not.toHaveBeenCalled();
    expect(onAccept).not.toHaveBeenCalled();
    expect(onDecline).toHaveBeenCalledOnce();
  });

  test("routes select and dialog cancellation through decline handling", async () => {
    const onDecline = vi.fn();
    await renderDialog({ onDecline });

    latestSelectProps().onCancel();

    expect(onDecline).toHaveBeenCalledOnce();

    harness.dialogProps.at(-1)?.onCancel();

    expect(onDecline).toHaveBeenCalledTimes(2);
  });
});
