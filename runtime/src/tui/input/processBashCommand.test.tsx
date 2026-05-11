import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  recordInputBurst,
  resetBurstDetector,
} from "./burst-detector.js";
import { processBashCommand } from "./processBashCommand.js";

const mocks = vi.hoisted(() => ({
  bashCall: vi.fn(async () => ({
    data: {
      content: "ok",
      metadata: {
        stdout: "ok",
        stderr: "",
      },
    },
  })),
  logEvent: vi.fn(),
  processToolResultBlock: vi.fn(async (_tool: unknown, data: { content?: string }) => ({
    content: data.content,
  })),
}));

vi.mock("../components/BashModeProgress.js", () => ({
  BashModeProgress: vi.fn(() => null),
}));

vi.mock("../components/PasteConfirmDialog.js", () => ({
  PasteConfirmDialog: vi.fn(() => null),
}));

vi.mock("../../services/analytics/index.js", () => ({
  logEvent: mocks.logEvent,
}));

vi.mock("../../tools/canonicalToolSurface.js", () => ({
  CanonicalBashTool: {
    call: mocks.bashCall,
  },
}));

vi.mock("../../tools/PowerShellTool/PowerShellTool.js", () => ({
  PowerShellTool: {
    call: vi.fn(),
  },
}));

vi.mock("../../utils/errors.js", () => ({
  errorMessage: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : String(error),
  ),
  ShellError: class ShellError extends Error {
    interrupted = false;
    stdout = "";
    stderr = "";
  },
}));

vi.mock("../../utils/messages.js", () => ({
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

vi.mock("../../utils/shell/resolveDefaultShell.js", () => ({
  resolveDefaultShell: vi.fn(() => "bash"),
}));

vi.mock("../../utils/shell/shellToolUtils.js", () => ({
  getPowerShellTool: vi.fn(() => null),
  isPowerShellToolEnabled: vi.fn(() => false),
  SHELL_TOOL_NAMES: ["system.bash"],
}));

vi.mock("../../utils/toolResultStorage.js", () => ({
  processToolResultBlock: mocks.processToolResultBlock,
}));

vi.mock("../../utils/xml.js", () => ({
  escapeXml: vi.fn((value: string) => value),
}));

describe("processBashCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBurstDetector();
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

  it("passes failed canonical Bash results through the tool-result mapper", async () => {
    mocks.bashCall.mockResolvedValueOnce({
      data: {
        content: "failed",
        isError: true,
        metadata: {
          stdout: "",
          stderr: "bad",
        },
      },
    });
    const setToolJSX = vi.fn();

    const result = await processBashCommand(
      "false",
      [],
      [],
      { options: { verbose: false } } as never,
      setToolJSX,
    );

    expect(mocks.processToolResultBlock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        content: "failed",
        isError: true,
      }),
      expect.any(String),
    );
    expect(result.shouldQuery).toBe(false);
    expect(JSON.stringify(result.messages)).toContain(
      "<bash-stdout>failed</bash-stdout><bash-stderr>bad</bash-stderr>",
    );
  });

  it("passes canonical Bash progress updates to the bash-mode progress UI", async () => {
    mocks.bashCall.mockImplementationOnce(
      async (_input, _context, _canUseTool, _parentMessage, onProgress) => {
        expect(typeof onProgress).toBe("function");
        onProgress?.({
          toolUseID: "progress-1",
          data: {
            type: "bash_progress",
            output: "tick",
            fullOutput: "tick",
            elapsedTimeSeconds: 0.1,
            totalLines: 1,
            totalBytes: 4,
          },
        });
        return {
          data: {
            content: "ok",
            metadata: {
              stdout: "ok",
              stderr: "",
            },
          },
        };
      },
    );
    const setToolJSX = vi.fn();

    await processBashCommand(
      "printf tick",
      [],
      [],
      { options: { verbose: false } } as never,
      setToolJSX,
    );

    expect(setToolJSX).toHaveBeenCalledWith(
      expect.objectContaining({
        shouldHidePromptInput: false,
        showSpinner: false,
      }),
    );
  });

  it("aborts bash exec when suspectedPaste is set and the user denies", async () => {
    // Arm the burst detector with an unbracketed batch over threshold.
    recordInputBurst(120, false);

    const setToolJSX = vi.fn((node: unknown) => {
      // First call should render the confirm dialog. Simulate a "no" press
      // by invoking the onDecide(false) prop on the rendered element.
      if (
        node &&
        typeof node === "object" &&
        "jsx" in node &&
        (node as { jsx?: { props?: { onDecide?: (allow: boolean) => void } } }).jsx?.props?.onDecide
      ) {
        (node as { jsx: { props: { onDecide: (allow: boolean) => void } } }).jsx.props.onDecide(false);
      }
    });

    const result = await processBashCommand(
      "rm -rf /",
      [],
      [],
      { options: { verbose: false } } as never,
      setToolJSX,
    );

    expect(mocks.bashCall).not.toHaveBeenCalled();
    expect(result.shouldQuery).toBe(false);
    expect(JSON.stringify(result.messages)).toContain(
      "Bash submission aborted",
    );
  });

  it("runs bash exec when suspectedPaste is set and the user confirms", async () => {
    recordInputBurst(120, false);

    let calls = 0;
    const setToolJSX = vi.fn((node: unknown) => {
      calls += 1;
      // Only the FIRST call is the confirm dialog. Subsequent calls are
      // BashModeProgress and the final null.
      if (calls === 1 && node && typeof node === "object" && "jsx" in node) {
        const jsx = (node as { jsx?: { props?: { onDecide?: (allow: boolean) => void } } }).jsx;
        if (jsx?.props?.onDecide) {
          jsx.props.onDecide(true);
        }
      }
    });

    const result = await processBashCommand(
      "echo ok",
      [],
      [],
      { options: { verbose: false } } as never,
      setToolJSX,
    );

    expect(mocks.bashCall).toHaveBeenCalled();
    expect(result.shouldQuery).toBe(false);
    expect(JSON.stringify(result.messages)).toContain(
      "<bash-stdout>ok</bash-stdout>",
    );
  });

  it("does not gate execution when no burst was recorded", async () => {
    // No recordInputBurst → flag clean.
    const setToolJSX = vi.fn();

    await processBashCommand(
      "echo direct",
      [],
      [],
      { options: { verbose: false } } as never,
      setToolJSX,
    );

    expect(mocks.bashCall).toHaveBeenCalled();
  });
});
