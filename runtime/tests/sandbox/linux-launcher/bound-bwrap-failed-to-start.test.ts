import { describe, expect, test } from "vitest";

import { boundReadOnlyBwrapFailedToStart } from "../../../src/sandbox/linux-launcher/bound-bwrap.js";

function result(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): { exitCode: number | null; stdout: Buffer; stderr: Buffer } {
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

describe("boundReadOnlyBwrapFailedToStart", () => {
  test("only a bwrap-prefixed start failure with empty stdout retries the launcher", () => {
    expect(boundReadOnlyBwrapFailedToStart(result(1, "", "bwrap: Can't mount proc"))).toBe(true);
    expect(boundReadOnlyBwrapFailedToStart(result(1, "", "notice\nbwrap: Can't mount proc"))).toBe(true);
    expect(boundReadOnlyBwrapFailedToStart(result(0, "", "bwrap: Can't mount proc"))).toBe(false);
    expect(boundReadOnlyBwrapFailedToStart(result(null, "", "bwrap: Can't mount proc"))).toBe(false);
    expect(boundReadOnlyBwrapFailedToStart(result(1, "matches", "bwrap: Can't mount proc"))).toBe(false);
    expect(boundReadOnlyBwrapFailedToStart(result(1, "", "ripgrep: I/O error"))).toBe(false);
  });
});
