import { describe, expect, it, vi } from "vitest";
import type { ShellCommand } from "../../../src/utils/ShellCommand.js";

// LocalShellTask.tsx:224/333/431 (core-todo.md): background completion handlers
// floated `void shellCommand.result.then(async …)` with no `.catch`. A throwing
// completion callback (updateTaskState/enqueueShellNotification in a torn-down
// state) became an unhandled rejection. The handlers now end in `.catch(logError)`.

vi.mock("bun:bundle", () => ({ feature: () => false }));

// Force the completion callback to throw at updateTaskState.
vi.mock("../../../src/utils/task/framework.js", () => ({
  registerTask: vi.fn(),
  updateTaskState: () => {
    throw new Error("BOOM-completion");
  },
}));

// Spy on logError while keeping the rest of the logging module intact.
vi.mock("../../../src/utils/log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/utils/log.js")>();
  return { ...actual, logError: vi.fn() };
});

const { backgroundExistingForegroundTask } = await import(
  "../../../src/tasks/LocalShellTask/LocalShellTask.js"
);
const { logError } = await import("../../../src/utils/log.js");

function fakeShellCommand(code = 0): ShellCommand {
  return {
    background: () => true,
    result: Promise.resolve({ code, interrupted: false }),
    taskOutput: { flush: async () => {} },
    cleanup: () => {},
  } as unknown as ShellCommand;
}

describe("LocalShellTask background completion handler", () => {
  it("routes a throwing completion callback into logError, not an unhandled rejection", async () => {
    let state: { tasks: Record<string, unknown> } = { tasks: {} };
    const setAppState = (fn: unknown) => {
      state = typeof fn === "function" ? (fn as (p: typeof state) => typeof state)(state) : (fn as typeof state);
    };

    const ok = backgroundExistingForegroundTask(
      "task-1",
      fakeShellCommand(0),
      "echo hi",
      setAppState as never,
    );
    expect(ok).toBe(true);

    // Let the resolved result -> completion callback -> throw -> .catch run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // With the fix the rejection is caught and logged. Without `.catch` it would
    // instead surface as an unhandled rejection and logError would never see it.
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "BOOM-completion" }),
    );
  });
});
