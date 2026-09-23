import { describe, expect, it } from "vitest";

import { analyzeSedWrites } from "../../../src/utils/shell/sed-writes.js";

function writes(
  args: readonly string[],
  options: {
    readonly bsd?: "runs" | "disputes" | "absent";
    readonly expands?: readonly boolean[];
  } = {},
) {
  return analyzeSedWrites(args, options.expands, { bsd: options.bsd ?? "runs" });
}

describe("analyzeSedWrites", () => {
  it("names the file a GNU in-place edit rewrites, never the script", () => {
    const result = writes(["-i", "s/a/b/", "tmp/file.txt"], { bsd: "absent" });
    expect(result).toEqual({
      edits: [{ file: "tmp/file.txt", onlyIfExists: false }],
      scriptWrites: [],
      commands: [],
      indeterminate: false,
    });
  });

  it("keeps a BSD backup suffix that GNU would not take from a separate word", () => {
    const result = writes(["-i", ".orig", "-e", "s/a/b/", "tmp/file.txt"]);
    expect(result.edits.map((edit) => ({
      file: edit.file,
      backup: edit.backup,
    }))).toEqual(
      expect.arrayContaining([
        { file: "tmp/file.txt" },
        { file: "tmp/file.txt", backup: "tmp/file.txt.orig" },
      ]),
    );
    expect(result.indeterminate).toBe(false);
  });

  it("reports files a w or s///w command creates while compiling", () => {
    expect(writes(["-n", "w src/out", "tmp/in"], { bsd: "absent" }).scriptWrites).toEqual([
      "src/out",
    ]);
    expect(writes(["s/a/b/w src/out", "tmp/in"], { bsd: "absent" }).scriptWrites).toEqual([
      "src/out",
    ]);
    expect(writes(["-n", "W src/out", "tmp/in"], { bsd: "absent" }).scriptWrites).toEqual([
      "src/out",
    ]);
  });

  it("treats a GNU e command as an unknown shell write", () => {
    const result = writes(["-n", "e rm -rf src", "tmp/in"], { bsd: "absent" });
    expect(result.commands).toEqual(["rm -rf src"]);
    expect(result.indeterminate).toBe(true);
    expect(result.edits).toEqual([]);
  });

  it("cannot know what a script file or an expanding operand writes", () => {
    expect(writes(["-f", "script.sed", "tmp/in"], { bsd: "absent" }).indeterminate).toBe(
      true,
    );
    const expanding = writes(["-i", "s/a/b/", "tmp/*.txt"], {
      bsd: "absent",
      expands: [false, false, true],
    });
    expect(expanding.edits).toEqual([]);
    expect(expanding.indeterminate).toBe(true);
  });

  it("skips stdin and keeps an attached GNU backup suffix", () => {
    expect(writes(["-i", "s/a/b/", "-"], { bsd: "absent" }).edits).toEqual([]);
    expect(writes(["-i.bak", "s/a/b/", "tmp/file.txt"], { bsd: "absent" }).edits).toEqual([
      { file: "tmp/file.txt", backup: "tmp/file.txt.bak", onlyIfExists: false },
    ]);
  });

  it("marks an empty GNU in-place script as an edit only if the file exists", () => {
    const result = writes(["-i", "-e", "", "tmp/file.txt"], { bsd: "absent" });
    expect(result.edits).toEqual([{ file: "tmp/file.txt", onlyIfExists: true }]);
    expect(result.indeterminate).toBe(false);
  });
});
