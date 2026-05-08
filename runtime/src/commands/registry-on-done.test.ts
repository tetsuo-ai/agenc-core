import { describe, expect, it, vi } from "vitest";

import {
  buildLegacyOnDone,
  type LegacyOnDoneTuiHandlers,
} from "./legacy-on-done.js";

function createHandlers(
  overrides: Partial<LegacyOnDoneTuiHandlers> = {},
): LegacyOnDoneTuiHandlers {
  return {
    unmountJsx: vi.fn(),
    notifyResult: vi.fn(),
    ...overrides,
  };
}

describe("buildLegacyOnDone — notifyResult-vs-unmount routing", () => {
  it("calls notifyResult with the result text and does NOT call unmountJsx (React-batching guard)", () => {
    const handlers = createHandlers();
    const onDone = buildLegacyOnDone(handlers);

    onDone("Session color set to: blue", { display: "system" });

    expect(handlers.notifyResult).toHaveBeenCalledTimes(1);
    expect(handlers.notifyResult).toHaveBeenCalledWith(
      "Session color set to: blue",
      { display: "system" },
    );
    // Critical: unmountJsx must not fire in the same tick or React 18
    // automatic batching collapses the setToolJSX(<Box>) +
    // setToolJSX(null) pair to a final null and the result row never
    // paints.
    expect(handlers.unmountJsx).not.toHaveBeenCalled();
  });

  it("falls back to unmountJsx when no result text is passed", () => {
    const handlers = createHandlers();
    const onDone = buildLegacyOnDone(handlers);

    onDone();

    expect(handlers.notifyResult).not.toHaveBeenCalled();
    expect(handlers.unmountJsx).toHaveBeenCalledTimes(1);
  });

  it("falls back to unmountJsx when result is an empty string", () => {
    const handlers = createHandlers();
    const onDone = buildLegacyOnDone(handlers);

    onDone("");

    expect(handlers.notifyResult).not.toHaveBeenCalled();
    expect(handlers.unmountJsx).toHaveBeenCalledTimes(1);
  });

  it("falls back to unmountJsx when notifyResult is not provided by the TUI", () => {
    const handlers = createHandlers({ notifyResult: undefined });
    const onDone = buildLegacyOnDone(handlers);

    onDone("Something happened");

    expect(handlers.unmountJsx).toHaveBeenCalledTimes(1);
  });

  it("falls back to unmountJsx when notifyResult throws", () => {
    const failing = vi.fn(() => {
      throw new Error("simulated TUI error");
    });
    const handlers = createHandlers({ notifyResult: failing });
    const onDone = buildLegacyOnDone(handlers);

    onDone("Result text");

    expect(failing).toHaveBeenCalledTimes(1);
    expect(handlers.unmountJsx).toHaveBeenCalledTimes(1);
  });

  it("omits the display option when opts is missing", () => {
    const handlers = createHandlers();
    const onDone = buildLegacyOnDone(handlers);

    onDone("Done");

    expect(handlers.notifyResult).toHaveBeenCalledWith("Done", undefined);
    expect(handlers.unmountJsx).not.toHaveBeenCalled();
  });

  it("ignores non-string display values", () => {
    const handlers = createHandlers();
    const onDone = buildLegacyOnDone(handlers);

    onDone("Done", { display: 42 });

    expect(handlers.notifyResult).toHaveBeenCalledWith("Done", undefined);
  });

  it("survives a misbehaving unmountJsx in the fallback path", () => {
    const failingUnmount = vi.fn(() => {
      throw new Error("ink already torn down");
    });
    const handlers = createHandlers({ unmountJsx: failingUnmount });
    const onDone = buildLegacyOnDone(handlers);

    expect(() => onDone()).not.toThrow();
    expect(failingUnmount).toHaveBeenCalledTimes(1);
  });
});
