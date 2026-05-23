import { describe, expect, it } from "vitest";

import { tryParseShellCommand } from "./shell-quote.js";

describe("tryParseShellCommand", () => {
  it("returns parsed shell tokens on success", () => {
    expect(tryParseShellCommand("alpha beta")).toEqual({
      success: true,
      tokens: ["alpha", "beta"],
    });
  });

  it("returns Error messages from parser failures", () => {
    expect(
      tryParseShellCommand("alpha $BROKEN", () => {
        throw new Error("bad environment");
      }),
    ).toEqual({
      success: false,
      error: "bad environment",
    });
  });

  it("returns a generic message for non-Error parser failures", () => {
    expect(
      tryParseShellCommand("alpha $BROKEN", () => {
        throw "bad environment";
      }),
    ).toEqual({
      success: false,
      error: "Unknown parse error",
    });
  });
});
