import { execFile } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { createMacOSTools } from "./macos.js";

const originalPlatform = process.platform;
const mockedExecFile = vi.mocked(execFile);

describe("system.macos tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("surfaces actionable Accessibility guidance for blocked AppleScript keystrokes", async () => {
    mockedExecFile.mockImplementation((_, __, ___, callback) => {
      const error = Object.assign(new Error("Command failed: osascript -e ..."), {
        stderr:
          "55:90: execution error: System Events got an error: osascript is not allowed to send keystrokes. (1002)",
      });
      callback?.(error, "", "");
      return {} as never;
    });

    const tool = createMacOSTools().find(
      (candidate) => candidate.name === "system.applescript",
    );

    expect(tool).toBeDefined();

    const result = await tool!.execute({
      script:
        'tell application "System Events" to keystroke "k" using command down',
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      error:
        "55:90: execution error: System Events got an error: osascript is not allowed to send keystrokes. (1002) Grant Accessibility permission to the app running AgenC and allow it to control System Events/Telegram, then retry.",
    });
  });
});
