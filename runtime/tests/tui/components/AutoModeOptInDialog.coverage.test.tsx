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
  readonly onChange: (value: string) => void | Promise<void>;
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
  selectProps: undefined as SelectMockProps | undefined,
  updateSettingsForSource: vi.fn(),
  recordSecurityAcknowledgement: vi.fn(),
}));

vi.mock("../../utils/settings/settings.js", () => ({
  getExecutionAuthoritySettings: () => ({}),
  updateSettingsForSource: harness.updateSettingsForSource,
}));

vi.mock("../../utils/settings/canonicalAuthority.js", () => ({
  getCanonicalSettingsAuthority: () => ({
    homeContext: { path: "/agenc-home" },
  }),
}));

vi.mock("../../permissions/trust/project-trust.js", () => ({
  recordSecurityAcknowledgement: harness.recordSecurityAcknowledgement,
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
    harness.updateSettingsForSource.mockReset();
    harness.recordSecurityAcknowledgement.mockReset();
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
      title: "Enable auto mode?",
    });
    expect(harness.dialogProps?.onCancel).toEqual(expect.any(Function));
    expect(harness.selectProps?.onCancel).toEqual(expect.any(Function));
    expect(harness.selectProps?.options).toEqual([
      {
        label: "Yes, and make it my default mode",
        value: "accept-default",
      },
      { label: "Yes, enable auto mode", value: "accept" },
      { label: "No, exit", value: "decline" },
    ]);

    await harness.selectProps?.onChange("accept-default");

    expect(harness.recordSecurityAcknowledgement).toHaveBeenLastCalledWith(
      "auto-mode-permission-prompt",
      { agencHome: "/agenc-home" },
    );
    expect(harness.updateSettingsForSource).toHaveBeenLastCalledWith(
      "userSettings",
      { permissions: { defaultMode: "auto" } },
    );
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onDecline).not.toHaveBeenCalled();

    await harness.selectProps?.onChange("accept");

    expect(harness.recordSecurityAcknowledgement).toHaveBeenCalledTimes(2);
    expect(harness.updateSettingsForSource).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledTimes(2);
    expect(onDecline).not.toHaveBeenCalled();

    await harness.selectProps?.onChange("decline");

    expect(onDecline).toHaveBeenCalledTimes(1);

    harness.selectProps?.onCancel();

    expect(onDecline).toHaveBeenCalledTimes(2);

    harness.dialogProps?.onCancel();

    expect(onDecline).toHaveBeenCalledTimes(3);

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
