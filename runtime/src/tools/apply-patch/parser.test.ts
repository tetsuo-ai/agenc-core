import { describe, expect, test } from "vitest";

import {
  ApplyPatchParseError,
  parsePatch,
} from "./index.js";

function wrapPatch(body: string): string {
  return `*** Begin Patch\n${body}\n*** End Patch`;
}

describe("apply-patch parser", () => {
  test("parses add, delete, update, move, and context chunks", () => {
    const parsed = parsePatch(wrapPatch(`*** Add File: path/add.py
+abc
+def
*** Delete File: path/delete.py
*** Update File: path/update.py
*** Move to: path/update2.py
@@ def f():
-    pass
+    return 123`), "strict");

    expect(parsed.hunks).toEqual([
      {
        kind: "add",
        path: "path/add.py",
        contents: "abc\ndef\n",
      },
      {
        kind: "delete",
        path: "path/delete.py",
      },
      {
        kind: "update",
        path: "path/update.py",
        movePath: "path/update2.py",
        chunks: [
          {
            changeContext: "def f():",
            oldLines: ["    pass"],
            newLines: ["    return 123"],
            isEndOfFile: false,
          },
        ],
      },
    ]);
  });

  test("accepts lenient heredoc wrappers", () => {
    const patch = wrapPatch(`*** Update File: file.py
 import foo
+bar`);

    expect(parsePatch(`<<'EOF'\n${patch}\nEOF\n`).hunks).toEqual([
      {
        kind: "update",
        path: "file.py",
        movePath: null,
        chunks: [
          {
            changeContext: null,
            oldLines: ["import foo"],
            newLines: ["import foo", "bar"],
            isEndOfFile: false,
          },
        ],
      },
    ]);
  });

  test("reports invalid update chunks with donor-shaped messages", () => {
    expect(() =>
      parsePatch(wrapPatch(`*** Update File: test.py`), "strict"),
    ).toThrow(
      new ApplyPatchParseError(
        "invalid_hunk",
        "Update file hunk for path 'test.py' is empty",
        2,
      ),
    );
  });
});
