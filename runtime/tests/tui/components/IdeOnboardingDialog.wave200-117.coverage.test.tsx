import type { ReactNode } from "react";
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { renderToString } from "../../utils/staticRender.js";
import {
  hasIdeOnboardingDialogBeenShown,
  IdeOnboardingDialog,
} from "./IdeOnboardingDialog.js";

type TestConfig = {
  hasIdeOnboardingBeenShown?: Record<string, boolean>;
};

type DialogMockProps = {
  children: ReactNode;
  color?: string;
  hideInputGuide?: boolean;
  onCancel: () => void;
  subtitle?: ReactNode;
  title: ReactNode;
};

type KeybindingHandlers = Record<string, () => void>;

const harness = vi.hoisted(() => ({
  config: {} as TestConfig,
  dialogProps: undefined as DialogMockProps | undefined,
  getGlobalConfig: vi.fn(),
  keybindings: undefined as
    | undefined
    | {
      handlers: KeybindingHandlers;
      options: unknown;
    },
  platform: "linux",
  saveGlobalConfig: vi.fn(),
  statusDot: "*",
  terminal: "agenc-terminal" as string | null,
  terminalIdeType: "vscode" as string | null,
  titleStaticPrefix: "*",
}));

vi.mock("../../utils/config.js", () => ({
  getGlobalConfig: harness.getGlobalConfig,
  saveGlobalConfig: harness.saveGlobalConfig,
}));

vi.mock("../../utils/env.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils/env.js")>(
    "../../utils/env.js",
  );

  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, property, receiver) {
        if (property === "platform") return harness.platform;
        return Reflect.get(target, property, receiver);
      },
    }),
  };
});

vi.mock("../../utils/envDynamic.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../utils/envDynamic.js")
  >("../../utils/envDynamic.js");

  return {
    ...actual,
    envDynamic: new Proxy(actual.envDynamic, {
      get(target, property, receiver) {
        if (property === "terminal") return harness.terminal;
        return Reflect.get(target, property, receiver);
      },
    }),
  };
});

vi.mock("../../utils/ide.js", () => ({
  getTerminalIdeType: () => harness.terminalIdeType,
  isJetBrainsIde: (ide: string | null) =>
    ide === "intellij" || ide === "pycharm",
  toIDEDisplayName: (ide: string | null) => {
    if (ide === "intellij") return "IntelliJ IDEA";
    if (ide === "vscode") return "VS Code";
    return "IDE";
  },
}));

vi.mock("../glyphs.js", () => ({
  selectAgenCTuiGlyphs: () => ({
    statusDot: harness.statusDot,
    titleStaticPrefix: harness.titleStaticPrefix,
  }),
}));

vi.mock("../keybindings/useKeybinding.js", () => ({
  useKeybindings: (handlers: KeybindingHandlers, options: unknown) => {
    harness.keybindings = { handlers, options };
  },
}));

vi.mock("./design-system/Dialog.js", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");

  return {
    Dialog: (props: DialogMockProps) => {
      harness.dialogProps = props;
      return ReactActual.createElement(
        "ink-box",
        { flexDirection: "column" },
        props.title,
        props.subtitle
          ? ReactActual.createElement("ink-text", null, props.subtitle)
          : null,
        props.children,
      );
    },
  };
});

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

describe("IdeOnboardingDialog wave200 coverage", () => {
  beforeEach(() => {
    harness.config = {};
    harness.dialogProps = undefined;
    harness.keybindings = undefined;
    harness.platform = "linux";
    harness.statusDot = "*";
    harness.terminal = "agenc-terminal";
    harness.terminalIdeType = "vscode";
    harness.titleStaticPrefix = "*";
    harness.getGlobalConfig.mockReset();
    harness.getGlobalConfig.mockImplementation(() => harness.config);
    harness.saveGlobalConfig.mockReset();
    harness.saveGlobalConfig.mockImplementation(
      (updater: (current: TestConfig) => TestConfig) => {
        const next = updater(harness.config);
        if (next !== harness.config) {
          harness.config = next;
        }
      },
    );
  });

  test("renders IDE-specific onboarding and records the terminal as shown", async () => {
    const onDone = vi.fn();

    expect(hasIdeOnboardingDialogBeenShown()).toBe(false);

    const jetBrainsOutput = normalizeWhitespace(
      await renderToString(
        <IdeOnboardingDialog
          onDone={onDone}
          installationStatus={{
            error: null,
            ideType: "intellij" as never,
            installed: true,
            installedVersion: "2.4.6",
          }}
        />,
        { columns: 160, rows: 30 },
      ),
    );

    expect(jetBrainsOutput).toContain("* Welcome to AgenC for IntelliJ IDEA");
    expect(jetBrainsOutput).toContain("installed plugin v2.4.6");
    expect(jetBrainsOutput).toContain(
      "* AgenC has context of open files and selected lines",
    );
    expect(jetBrainsOutput).toContain(
      "* Review AgenC's changes +11 -22 in the comfort of your IDE",
    );
    expect(jetBrainsOutput).toContain("* Cmd+Esc for Quick Launch");
    expect(jetBrainsOutput).toContain(
      "* Ctrl+Alt+K to reference files or lines in your input",
    );
    expect(jetBrainsOutput).toContain("Press Enter to continue");
    expect(harness.dialogProps).toMatchObject({
      color: "ide",
      hideInputGuide: true,
      onCancel: onDone,
      subtitle: "installed plugin v2.4.6",
    });
    expect(harness.keybindings?.options).toEqual({ context: "Confirmation" });

    harness.keybindings?.handlers["confirm:yes"]?.();
    harness.keybindings?.handlers["confirm:no"]?.();

    expect(onDone).toHaveBeenCalledTimes(2);
    expect(harness.config.hasIdeOnboardingBeenShown).toEqual({
      "agenc-terminal": true,
    });
    expect(hasIdeOnboardingDialogBeenShown()).toBe(true);

    await renderToString(
      <IdeOnboardingDialog
        onDone={onDone}
        installationStatus={{
          error: null,
          ideType: "intellij" as never,
          installed: true,
          installedVersion: "2.4.6",
        }}
      />,
      { columns: 160, rows: 30 },
    );

    expect(harness.config.hasIdeOnboardingBeenShown).toEqual({
      "agenc-terminal": true,
    });

    harness.platform = "darwin";
    harness.terminal = null;
    harness.terminalIdeType = "vscode";
    harness.titleStaticPrefix = "";

    const vscodeOutput = normalizeWhitespace(
      await renderToString(
        <IdeOnboardingDialog onDone={onDone} installationStatus={null} />,
        { columns: 160, rows: 30 },
      ),
    );

    expect(vscodeOutput).toContain("Welcome to AgenC for VS Code");
    expect(vscodeOutput).not.toContain("installed extension");
    expect(vscodeOutput).toContain(
      "* Cmd+Option+K to reference files or lines in your input",
    );
    expect(harness.dialogProps?.subtitle).toBeUndefined();
    expect(harness.config.hasIdeOnboardingBeenShown).toEqual({
      "agenc-terminal": true,
      unknown: true,
    });
    expect(hasIdeOnboardingDialogBeenShown()).toBe(true);
  });
});
