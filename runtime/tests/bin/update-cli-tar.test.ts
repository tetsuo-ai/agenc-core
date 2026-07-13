import { describe, expect, it } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";
import { assertTarExtractionSucceeded } from "../../src/bin/update-cli.js";

// update-cli.ts:410 (core-todo.md): when `tar` is not on PATH, spawnSync never
// runs the process — it sets res.error (ENOENT) and leaves res.status null. The
// old `status !== 0` check reported the opaque "tar extraction failed (status
// null)". A clear missing-binary message is now surfaced.

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
  it("reports a clear message when tar is missing (ENOENT)", () => {
    const enoent = Object.assign(new Error("spawnSync tar ENOENT"), {
      code: "ENOENT",
    });
    expect(() => assertTarExtractionSucceeded(res({ error: enoent, status: null }))).toThrow(
      /tar not found on PATH/,
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
