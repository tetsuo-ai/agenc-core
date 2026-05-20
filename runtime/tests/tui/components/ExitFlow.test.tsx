import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { renderToString } from "../../utils/staticRender.js";
import { Text } from "../ink.js";
import { ExitFlow } from "./ExitFlow.js";
import { gracefulShutdown } from "../../utils/gracefulShutdown.js";

const mocks = vi.hoisted(() => ({
  dialogProps: undefined as
    | {
        onCancel?: () => void;
        onDone: (message?: string) => Promise<void>;
      }
    | undefined,
  sampleResult: "See ya!" as string | undefined,
}));

vi.mock("lodash-es/sample.js", () => ({
  default: () => mocks.sampleResult,
}));

vi.mock("../../utils/gracefulShutdown.js", () => ({
  gracefulShutdown: vi.fn(async () => {}),
}));

vi.mock("./WorktreeExitDialog", () => ({
  WorktreeExitDialog: (props: {
    onCancel?: () => void;
    onDone: (message?: string) => Promise<void>;
  }) => {
    mocks.dialogProps = props;
    return <Text>worktree-dialog</Text>;
  },
}));

function RerenderExitFlow({
  onCancel,
  onDone,
  showWorktree,
}: React.ComponentProps<typeof ExitFlow>) {
  const [tick, setTick] = React.useState(0);

  React.useLayoutEffect(() => {
    if (tick === 0) {
      setTick(1);
    }
  }, [tick]);

  return (
    <ExitFlow
      onCancel={onCancel}
      onDone={onDone}
      showWorktree={showWorktree}
    />
  );
}

describe("ExitFlow", () => {
  beforeEach(() => {
    mocks.dialogProps = undefined;
    mocks.sampleResult = "See ya!";
    vi.mocked(gracefulShutdown).mockClear();
  });

  test("renders nothing when worktree confirmation is disabled", async () => {
    const output = await renderToString(
      <ExitFlow onDone={vi.fn()} showWorktree={false} />,
      80,
    );

    expect(output.trim()).toBe("");
    expect(mocks.dialogProps).toBeUndefined();
  });

  test("renders the worktree dialog and exits with the provided result message", async () => {
    const onCancel = vi.fn();
    const onDone = vi.fn();

    const output = await renderToString(
      <RerenderExitFlow
        onCancel={onCancel}
        onDone={onDone}
        showWorktree
      />,
      80,
    );

    expect(output).toContain("worktree-dialog");
    expect(mocks.dialogProps?.onCancel).toBe(onCancel);

    await mocks.dialogProps?.onDone("Saved transcript");

    expect(onDone).toHaveBeenCalledWith("Saved transcript");
    expect(gracefulShutdown).toHaveBeenCalledWith(0, "prompt_input_exit");
  });

  test("uses a sampled goodbye message when the dialog supplies no result", async () => {
    const onDone = vi.fn();

    await renderToString(<ExitFlow onDone={onDone} showWorktree />, 80);
    await mocks.dialogProps?.onDone();

    expect(onDone).toHaveBeenCalledWith("See ya!");
    expect(gracefulShutdown).toHaveBeenCalledWith(0, "prompt_input_exit");
  });

  test("falls back to the default goodbye when sampling returns nothing", async () => {
    mocks.sampleResult = undefined;
    const onDone = vi.fn();

    await renderToString(<ExitFlow onDone={onDone} showWorktree />, 80);
    await mocks.dialogProps?.onDone();

    expect(onDone).toHaveBeenCalledWith("Goodbye!");
    expect(gracefulShutdown).toHaveBeenCalledWith(0, "prompt_input_exit");
  });
});
