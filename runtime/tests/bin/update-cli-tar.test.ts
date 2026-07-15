import { describe, expect, it } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";
import { assertTarExtractionSucceeded } from "../../src/bin/update-cli.js";

// The extractor is resolved to an absolute, trusted operating-system path
// before use. ENOENT therefore means that trusted component disappeared
// between resolution and execution rather than that PATH was incomplete.

function res(
  partial: Partial<SpawnSyncReturns<Buffer>>,
): Pick<SpawnSyncReturns<Buffer>, "error" | "status" | "signal" | "stderr"> {
  return {
    error: undefined,
    status: 0,
    signal: null,
    stderr: Buffer.from(""),
    ...partial,
  };
}

describe("assertTarExtractionSucceeded", () => {
  it("reports a clear message when trusted tar disappears (ENOENT)", () => {
    const enoent = Object.assign(new Error("spawnSync tar ENOENT"), {
      code: "ENOENT",
    });
    expect(() => assertTarExtractionSucceeded(res({ error: enoent, status: null }))).toThrow(
      /trusted operating-system tar disappeared/,
    );
  });

  it("reports a generic spawn failure for a non-ENOENT error", () => {
    const eacces = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    expect(() => assertTarExtractionSucceeded(res({ error: eacces, status: null }))).toThrow(
      /failed to run tar: permission denied/,
    );
  });

  it("reports an extraction failure when tar ran and exited non-zero", () => {
    expect(() =>
      assertTarExtractionSucceeded(
        res({ status: 1, stderr: Buffer.from("bad archive") }),
      ),
    ).toThrow(/tar extraction failed \(status 1\): bad archive/);
  });

  it("does not throw when tar exits cleanly", () => {
    expect(() => assertTarExtractionSucceeded(res({ status: 0 }))).not.toThrow();
  });
});
