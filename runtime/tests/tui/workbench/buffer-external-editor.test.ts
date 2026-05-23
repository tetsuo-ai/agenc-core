import { describe, expect, it } from "vitest";

import { resolveBufferExternalEditor } from "../../../src/tui/workbench/buffer/externalEditor.js";

describe("buffer external editor", () => {
  it("prefers VISUAL and EDITOR before fallback terminal editors", () => {
    expect(resolveBufferExternalEditor(
      { VISUAL: "nvim --clean", EDITOR: "vim" },
      { isCommandAvailable: () => true },
    )).toBe("nvim --clean");

    expect(resolveBufferExternalEditor(
      { EDITOR: "vim" },
      { isCommandAvailable: () => true },
    )).toBe("vim");
  });

  it("defaults to terminal editors instead of GUI editors", () => {
    const available = new Set(["code", "vim"]);

    expect(resolveBufferExternalEditor(
      {},
      { isCommandAvailable: (command) => available.has(command) },
    )).toBe("vim");
  });

  it("returns undefined when no terminal editor is available", () => {
    expect(resolveBufferExternalEditor(
      {},
      {
        platform: "linux",
        isCommandAvailable: () => false,
      },
    )).toBeUndefined();
  });
});
