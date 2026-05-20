import type { ReactNode } from "react";
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { renderToString } from "../../utils/staticRender.js";
import {
  AUTO_MODE_DESCRIPTION,
  AutoModeOptInDialog,
} from "./AutoModeOptInDialog.js";

type SelectMockProps = {
  readonly onCancel: () => void;
  readonly onChange: (value: string) => void;
  readonly options: Array<{ readonly label: string; readonly value: string }>;
};

type DialogMockProps = {
  readonly children: ReactNode;
  readonly color?: string;
  readonly onCancel: () => void;
  readonly title: ReactNode;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const harness = vi.hoisted(() => ({
  dialogProps: undefined as DialogMockProps | undefined,
  logEvent: vi.fn(),
  selectProps: undefined as SelectMockProps | undefined,
  updateSettingsForSource: vi.fn(),
}));

vi.mock("../../services/analytics/index.js", () => ({
  logEvent: harness.logEvent,
}));

vi.mock("../../utils/settings/settings.js", () => ({
  updateSettingsForSource: harness.updateSettingsForSource,
}));

vi.mock("./CustomSelect/select", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");

  return {
    Select: (props: SelectMockProps) => {
      harness.selectProps = props;
      return ReactActual.createElement(
        "ink-text",
        null,
        props.options.map(option => option.label).join("\n"),
      );
    },
  };
});

vi.mock("./design-system/Dialog", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");

  return {
    Dialog: (props: DialogMockProps) => {
      harness.dialogProps = props;
      return ReactActual.createElement(
        "ink-box",
        { flexDirection: "column" },
        ReactActual.createElement("ink-text", null, props.title),
        props.children,
      );
    },
  };
});

describe("AutoModeOptInDialog coverage", () => {
  beforeEach(() => {
    harness.dialogProps = undefined;
    harness.selectProps = undefined;
    harness.logEvent.mockReset();
    harness.updateSettingsForSource.mockReset();
  });

  test("renders exit/go-back decline labels and handles every decision", async () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();

    const exitOutput = await renderToString(
      <AutoModeOptInDialog
        onAccept={onAccept}
        onDecline={onDecline}
        declineExits
      />,
      { columns: 240 },
    );

    expect(exitOutput).toContain("Enable auto mode?");
    expect(normalizeWhitespace(exitOutput)).toContain(
      normalizeWhitespace(AUTO_MODE_DESCRIPTION),
    );
    expect(harness.dialogProps).toMatchObject({
      color: "warning",
      onCancel: onDecline,
      title: "Enable auto mode?",
    });
    expect(harness.selectProps?.onCancel).toBe(onDecline);
    expect(harness.selectProps?.options).toEqual([
      {
        label: "Yes, and make it my default mode",
        value: "accept-default",
      },
      { label: "Yes, enable auto mode", value: "accept" },
      { label: "No, exit", value: "decline" },
    ]);
    expect(harness.logEvent).toHaveBeenCalledWith(
      "agenc_auto_mode_opt_in_dialog_shown",
      {},
    );

    harness.selectProps?.onChange("accept-default");

    expect(harness.logEvent).toHaveBeenCalledWith(
      "agenc_auto_mode_opt_in_dialog_accept_default",
      {},
    );
    expect(harness.updateSettingsForSource).toHaveBeenLastCalledWith(
      "userSettings",
      {
        skipAutoPermissionPrompt: true,
        permissions: { defaultMode: "auto" },
      },
    );
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onDecline).not.toHaveBeenCalled();

    harness.selectProps?.onChange("accept");

    expect(harness.logEvent).toHaveBeenCalledWith(
      "agenc_auto_mode_opt_in_dialog_accept",
      {},
    );
    expect(harness.updateSettingsForSource).toHaveBeenLastCalledWith(
      "userSettings",
      { skipAutoPermissionPrompt: true },
    );
    expect(onAccept).toHaveBeenCalledTimes(2);
    expect(onDecline).not.toHaveBeenCalled();

    harness.selectProps?.onChange("decline");

    expect(harness.logEvent).toHaveBeenCalledWith(
      "agenc_auto_mode_opt_in_dialog_decline",
      {},
    );
    expect(onDecline).toHaveBeenCalledTimes(1);

    await renderToString(
      <AutoModeOptInDialog onAccept={onAccept} onDecline={onDecline} />,
      { columns: 240 },
    );

    expect(harness.selectProps?.options.at(-1)).toEqual({
      label: "No, go back",
      value: "decline",
    });
  });
});
