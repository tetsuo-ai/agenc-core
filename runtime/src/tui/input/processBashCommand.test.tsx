import { beforeEach, describe, expect, it, vi } from "vitest";

import { processBashCommand } from "./processBashCommand.js";

const mocks = vi.hoisted(() => ({
  bashCall: vi.fn(async () => ({
    data: {
      stdout: "ok",
      stderr: "",
    },
  })),
  logEvent: vi.fn(),
  processToolResultBlock: vi.fn(async (_tool: unknown, data: { stdout: string }) => ({
    content: data.stdout,
  })),
}));

vi.mock("../../agenc/upstream/components/BashModeProgress.js", () => ({
  BashModeProgress: vi.fn(() => null),
}));

vi.mock("../../agenc/upstream/services/analytics/index.js", () => ({
  logEvent: mocks.logEvent,
}));

vi.mock("../../agenc/upstream/tools/BashTool/BashTool.js", () => ({
  BashTool: {
    call: mocks.bashCall,
  },
}));

vi.mock("../../agenc/upstream/utils/errors.js", () => ({
  errorMessage: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : String(error),
  ),
  ShellError: class ShellError extends Error {
    interrupted = false;
    stdout = "";
    stderr = "";
  },
}));

vi.mock("../../agenc/upstream/utils/messages.js", () => ({
  createSyntheticUserCaveatMessage: vi.fn(() => ({
    type: "system",
    message: { content: "synthetic caveat" },
  })),
  createUserInterruptionMessage: vi.fn(() => ({
    type: "user",
    message: { content: "interrupted" },
  })),
  createUserMessage: vi.fn((input: { content: unknown }) => ({
    type: "user",
    message: { role: "user", content: input.content },
    ...input,
  })),
  prepareUserContent: vi.fn(
    ({ inputString }: { inputString: string }) => inputString,
  ),
}));

vi.mock("../../agenc/upstream/utils/shell/resolveDefaultShell.js", () => ({
  resolveDefaultShell: vi.fn(() => "bash"),
}));

vi.mock("../../agenc/upstream/utils/shell/shellToolUtils.js", () => ({
  getPowerShellTool: vi.fn(() => null),
  isPowerShellToolEnabled: vi.fn(() => false),
}));

vi.mock("../../agenc/upstream/utils/toolResultStorage.js", () => ({
  processToolResultBlock: mocks.processToolResultBlock,
}));

vi.mock("../../agenc/upstream/utils/xml.js", () => ({
  escapeXml: vi.fn((value: string) => value),
}));

describe("processBashCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes bash input and formats stdout without querying the model", async () => {
    const setToolJSX = vi.fn();

    const result = await processBashCommand(
      "echo ok",
      [],
      [],
      { options: { verbose: false } } as never,
      setToolJSX,
    );

    expect(mocks.bashCall).toHaveBeenCalledWith(
      {
        command: "echo ok",
        dangerouslyDisableSandbox: true,
        _dangerouslyDisableSandboxApproved: true,
      },
      expect.any(Object),
      undefined,
      undefined,
      expect.any(Function),
    );
    expect(result.shouldQuery).toBe(false);
    expect(JSON.stringify(result.messages)).toContain(
      "<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>",
    );
    expect(setToolJSX).toHaveBeenLastCalledWith(null);
    expect(mocks.logEvent).toHaveBeenCalledWith("agenc_input_bash", {
      powershell: false,
    });
  });
});
