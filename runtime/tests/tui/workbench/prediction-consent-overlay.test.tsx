import { PassThrough } from "node:stream";

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRoot } from "../../../src/tui/ink/root.js";
import type { Key } from "../../../src/tui/ink/events/input-event.js";

type CapturedInput = {
  readonly handler: (
    input: string,
    key: Key,
    event: { readonly stopImmediatePropagation: () => void },
  ) => boolean;
  readonly options: {
    readonly context?: string;
    readonly isActive?: boolean;
  };
};

const consentHarness = vi.hoisted(() => ({
  input: null as CapturedInput | null,
  inputVersion: 0,
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useInputCapture: (
    handler: CapturedInput["handler"],
    options: CapturedInput["options"],
  ) => {
    consentHarness.input = { handler, options };
    consentHarness.inputVersion += 1;
  },
}));

vi.mock("../../../src/tui/context/overlayContext.js", () => ({
  useRegisterOverlay: () => {},
}));

vi.mock("../../../src/tui/keybindings/KeybindingContext.js", () => ({
  useRegisterKeybindingContext: () => {},
}));

const renderedRoots: Array<{
  readonly unmount: () => void;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
}> = [];

beforeEach(() => {
  consentHarness.input = null;
  consentHarness.inputVersion = 0;
});

afterEach(() => {
  for (const rendered of renderedRoots.splice(0)) {
    rendered.unmount();
    rendered.stdin.end();
    rendered.stdout.end();
  }
});

describe("PredictionConsentOverlay", () => {
  it("passes ordinary editing input through without granting or denying consent", async () => {
    const onAllow = vi.fn(async () => {});
    const onDecline = vi.fn(async () => {});
    const onDismiss = vi.fn();
    await renderConsent({ onAllow, onDecline, onDismiss });

    expect(press("y")).toBe(false);
    expect(press("n")).toBe(false);
    expect(press("q")).toBe(false);
    expect(press("", { return: true })).toBe(false);
    expect(press("source text")).toBe(false);

    expect(onAllow).not.toHaveBeenCalled();
    expect(onDecline).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("requires explicit Alt choices and lets Escape reach Neovim after dismissing", async () => {
    const onAllow = vi.fn(async () => {});
    const onDecline = vi.fn(async () => {});
    const onDismiss = vi.fn();
    await renderConsent({ onAllow, onDecline, onDismiss });

    expect(press("", { escape: true, meta: true })).toBe(false);
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onAllow).not.toHaveBeenCalled();
    expect(onDecline).not.toHaveBeenCalled();

    expect(press("y", { meta: true })).toBe(true);
    expect(onAllow).toHaveBeenCalledOnce();
    expect(onDecline).not.toHaveBeenCalled();
  });

  it("persists an explicit Alt+N refusal", async () => {
    const onAllow = vi.fn(async () => {});
    const onDecline = vi.fn(async () => {});
    await renderConsent({
      onAllow,
      onDecline,
      onDismiss: vi.fn(),
    });

    expect(press("n", { meta: true })).toBe(true);
    expect(onDecline).toHaveBeenCalledOnce();
    expect(onAllow).not.toHaveBeenCalled();
  });

  it("passes editing input through while persistence is pending and consumes only repeated consent decisions", async () => {
    let finishAllow: (() => void) | undefined;
    const onAllow = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishAllow = resolve;
        }),
    );
    const onDecline = vi.fn(async () => {});
    const onDismiss = vi.fn();
    await renderConsent({ onAllow, onDecline, onDismiss });

    const beforePendingRender = consentHarness.inputVersion;
    expect(press("y", { meta: true })).toBe(true);
    await vi.waitFor(() =>
      expect(consentHarness.inputVersion).toBeGreaterThan(beforePendingRender),
    );
    expect(onAllow).toHaveBeenCalledOnce();

    expect(press("source text")).toBe(false);
    expect(press("", { return: true })).toBe(false);
    expect(press("y")).toBe(false);

    expect(press("y", { meta: true })).toBe(true);
    expect(press("n", { meta: true })).toBe(true);
    expect(press("", { escape: true })).toBe(false);
    expect(onAllow).toHaveBeenCalledOnce();
    expect(onDecline).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();

    if (finishAllow === undefined) {
      throw new Error("Expected the consent write to remain pending");
    }
    finishAllow();
  });
});

async function renderConsent({
  onAllow,
  onDecline,
  onDismiss,
}: {
  readonly onAllow: () => Promise<void>;
  readonly onDecline: () => Promise<void>;
  readonly onDismiss: () => void;
}): Promise<void> {
  const { PredictionConsentOverlay } =
    await import("../../../src/tui/workbench/PredictionConsentOverlay.js");
  const { stdin, stdout } = stdio();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(
    <PredictionConsentOverlay
      onAllow={onAllow}
      onDecline={onDecline}
      onDismiss={onDismiss}
    />,
  );
  await vi.waitFor(() => expect(consentHarness.input).not.toBeNull());
  expect(consentHarness.input?.options).toEqual({
    context: "Modal",
    isActive: true,
  });
  renderedRoots.push({
    unmount: () => root.unmount(),
    stdin,
    stdout,
  });
}

function press(input: string, overrides: Partial<Key> = {}): boolean {
  const capture = consentHarness.input;
  if (capture === null) throw new Error("Consent input was not registered");
  return capture.handler(
    input,
    {
      upArrow: false,
      downArrow: false,
      leftArrow: false,
      rightArrow: false,
      pageDown: false,
      pageUp: false,
      wheelUp: false,
      wheelDown: false,
      home: false,
      end: false,
      return: false,
      escape: false,
      ctrl: false,
      shift: false,
      fn: false,
      tab: false,
      backspace: false,
      delete: false,
      meta: false,
      super: false,
      ...overrides,
    },
    { stopImmediatePropagation: () => {} },
  );
}

function stdio(): {
  readonly stdin: PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  readonly stdout: PassThrough;
} {
  const stdout = new PassThrough();
  (stdout as unknown as { columns: number; rows: number }).columns = 100;
  (stdout as unknown as { columns: number; rows: number }).rows = 20;
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
  return { stdin, stdout };
}
