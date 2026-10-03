import { describe, expect, it, vi } from "vitest";

const failure = vi.hoisted(() => new Error("renderer import failed"));
vi.mock("../../src/tui/ink/root.js", () => { throw failure; });

describe("Ink facade loading failure", () => {
  it("rejects both async rendering entrypoints if the renderer cannot load", async () => {
    const ink = await import("../../src/tui/ink.js");
    // Vitest wraps a throwing mock factory on each import attempt.
    await expect(ink.render(null)).rejects.toMatchObject({ cause: failure });
    await expect(ink.createRoot()).rejects.toMatchObject({ cause: failure });
  });
});
