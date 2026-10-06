import { describe, expect, test } from "vitest";

import {
  MAX_ADDITIONAL_WORKING_DIRECTORIES,
  validateAndDedupeAdditionalWorkingDirectoryInputs,
} from "../../src/contracts/additional-working-directories.js";

describe("additional working directory admission", () => {
  test("rejects an empty path and keeps first-seen exact duplicates", () => {
    expect(() =>
      validateAndDedupeAdditionalWorkingDirectoryInputs(["/a", ""], "addDirs"),
    ).toThrow(TypeError);
    expect(
      validateAndDedupeAdditionalWorkingDirectoryInputs(
        ["/a", "/b", "/a", "/c"],
        "addDirs",
      ),
    ).toEqual(["/a", "/b", "/c"]);
  });

  test("counts duplicates toward the raw bound so wire and runtime match", () => {
    const oneShort = Array.from(
      { length: MAX_ADDITIONAL_WORKING_DIRECTORIES },
      () => "/same",
    );
    expect(
      validateAndDedupeAdditionalWorkingDirectoryInputs(oneShort, "addDirs"),
    ).toEqual(["/same"]);

    expect(() =>
      validateAndDedupeAdditionalWorkingDirectoryInputs(
        [...oneShort, "/same"],
        "addDirs",
      ),
    ).toThrow(
      new RangeError(
        `addDirs accepts at most ${MAX_ADDITIONAL_WORKING_DIRECTORIES} paths`,
      ),
    );
  });

  test("returns a frozen list that later mutation cannot enlarge", () => {
    const accepted = validateAndDedupeAdditionalWorkingDirectoryInputs(
      ["/a", "/a"],
      "session bootstrap addDirs",
    );
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(() => {
      (accepted as string[]).push("/forged");
    }).toThrow();
    expect(accepted).toEqual(["/a"]);
  });
});
