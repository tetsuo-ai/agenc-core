import type { ReactNode } from "react";
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { renderToString } from "../../utils/staticRender.js";

type WorktreeExitDialogProps = {
  readonly onCancel?: () => void;
  readonly onDone: (message?: string) => void | Promise<void>;
};

const harness = vi.hoisted(() => ({
  dialogProps: undefined as WorktreeExitDialogProps | undefined,
  gracefulShutdown: vi.fn(),
  sample: vi.fn(),
}));

vi.mock("lodash-es/sample.js", () => ({
  default: harness.sample,
}));

vi.mock("../../utils/gracefulShutdown.js", () => ({
  gracefulShutdown: harness.gracefulShutdown,
}));

vi.mock("./WorktreeExitDialog", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");

  return {
    WorktreeExitDialog: (props: WorktreeExitDialogProps): ReactNode => {
      harness.dialogProps = props;
      return ReactActual.createElement("ink-text", null, "worktree-exit");
    },
  };
});

import { ExitFlow } from "./ExitFlow.js";

describe("ExitFlow coverage", () => {
  beforeEach(() => {
    harness.dialogProps = undefined;
    harness.gracefulShutdown.mockReset();
    harness.sample.mockReset();
  });

  test("renders only for worktree exits and completes with explicit or fallback messages", async () => {
    const onCancel = vi.fn();
    const onDone = vi.fn();

    const hidden = await renderToString(
      <ExitFlow showWorktree={false} onDone={onDone} onCancel={onCancel} />,
      80,
    );

    expect(hidden.trim()).toBe("");
    expect(harness.dialogProps).toBeUndefined();

    const shown = await renderToString(
      <ExitFlow showWorktree={true} onDone={onDone} onCancel={onCancel} />,
      80,
    );

    expect(shown).toContain("worktree-exit");
    expect(harness.dialogProps?.onCancel).toBe(onCancel);

    await harness.dialogProps?.onDone("Preserved worktree");

    expect(onDone).toHaveBeenLastCalledWith("Preserved worktree");
    expect(harness.sample).not.toHaveBeenCalled();
    expect(harness.gracefulShutdown).toHaveBeenLastCalledWith(
      0,
      "prompt_input_exit",
    );

    harness.sample.mockReturnValue(undefined);

    await harness.dialogProps?.onDone();

    expect(harness.sample).toHaveBeenCalledWith([
      "Goodbye!",
      "See ya!",
      "Bye!",
      "Catch you later!",
    ]);
    expect(onDone).toHaveBeenLastCalledWith("Goodbye!");
    expect(harness.gracefulShutdown).toHaveBeenCalledTimes(2);
  });
});
