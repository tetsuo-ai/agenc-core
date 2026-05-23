import { beforeEach, describe, expect, it, vi } from "vitest";

const logHarness = vi.hoisted(() => ({
  logError: vi.fn(),
}));

vi.mock("../../../src/utils/log.js", () => logHarness);

type HighlightModule = typeof import("../../../src/tui/workbench/buffer/highlight.js");

async function loadHighlightWithShiki(factory: () => unknown): Promise<HighlightModule> {
  vi.resetModules();
  vi.doMock("@shikijs/cli", factory);
  return import("../../../src/tui/workbench/buffer/highlight.js");
}

beforeEach(() => {
  logHarness.logError.mockReset();
  vi.doUnmock("@shikijs/cli");
});

describe("buffer syntax highlighting", () => {
  it("maps highlighted output back to visible line numbers", async () => {
    const codeToANSI = vi.fn(async () => "\u001b[32mconst value = 1;\u001b[39m\n");
    const { highlightBufferVisibleLines } = await loadHighlightWithShiki(() => ({
      codeToANSI,
    }));

    const result = await highlightBufferVisibleLines("index.ts", [
      { number: 7, text: "const value = 1;" },
    ]);

    expect(codeToANSI).toHaveBeenCalledWith("const value = 1;", "ts", "dark-plus");
    expect(result.get(7)).toBe("\u001b[32mconst value = 1;\u001b[39m");
  });

  it("logs highlighter render failures while falling back to plain text", async () => {
    const error = new Error("shiki render failed");
    const { highlightBufferVisibleLines } = await loadHighlightWithShiki(() => ({
      codeToANSI: vi.fn().mockRejectedValue(error),
    }));

    await expect(highlightBufferVisibleLines("index.ts", [
      { number: 1, text: "const value = 1;" },
    ])).resolves.toEqual(new Map());

    expect(logHarness.logError).toHaveBeenCalledWith(error);
  });

  it("logs highlighter module load failures while disabling highlighting", async () => {
    const error = new Error("shiki module missing");
    const { highlightBufferVisibleLines } = await loadHighlightWithShiki(() => {
      throw error;
    });

    await expect(highlightBufferVisibleLines("index.ts", [
      { number: 1, text: "const value = 1;" },
    ])).resolves.toEqual(new Map());

    expect(logHarness.logError).toHaveBeenCalledTimes(1);
    const loggedError = logHarness.logError.mock.calls[0]?.[0] as { cause?: unknown } | undefined;
    expect(loggedError === error || loggedError?.cause === error).toBe(true);
  });
});
