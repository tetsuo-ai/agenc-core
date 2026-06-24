import { describe, expect, test } from "vitest";

import { pickToolResultDispatch } from "./tool-result-routing.js";

// GAP #3 regression: every live Edit/MultiEdit/Write SUCCESS string must route
// to "suppress" so the raw success sentence does NOT double-render alongside
// the compact diff rendered from the tool-use INPUT. Before the fix the
// suppress predicate was anchored to `...successfully.$`, which missed:
//   - replace_all Edit (ends "...successfully replaced.")
//   - MultiEdit ("successfully." mid-string, trailer follows)
//   - new-file Write ("File created successfully at: <path>")
// causing the diff AND the success sentence to both render.
//
// These strings are copied verbatim from the live daemon:
//   runtime/src/tools/system/file-edit.ts  (successText / multiEditSuccessText)
//   runtime/src/tools/system/file-write.ts (created/updated success lines)
describe("pickToolResultDispatch — edit/write success suppression (GAP #3)", () => {
  test("single Edit success suppresses (baseline that already worked)", () => {
    expect(
      pickToolResultDispatch(
        "Edit",
        "The file /repo/x.ts has been updated successfully.",
      ),
    ).toBe("suppress");
  });

  test("replace_all Edit success ('...occurrences were successfully replaced.') suppresses", () => {
    expect(
      pickToolResultDispatch(
        "Edit",
        "The file /repo/x.ts has been updated. All occurrences were successfully replaced.",
      ),
    ).toBe("suppress");
  });

  test("MultiEdit success with trailing edit/replacement count suppresses (mid-string 'successfully.')", () => {
    expect(
      pickToolResultDispatch(
        "MultiEdit",
        "The file /repo/x.ts has been updated successfully. 3 edits applied with 5 replacements.",
      ),
    ).toBe("suppress");
  });

  test("new-file Write ('File created successfully at: <path>') suppresses", () => {
    expect(
      pickToolResultDispatch(
        "Write",
        "File created successfully at: /repo/new.ts",
      ),
    ).toBe("suppress");
  });

  test("existing-file Write success ('has been updated successfully.') suppresses", () => {
    expect(
      pickToolResultDispatch(
        "Write",
        "The file /repo/x.ts has been updated successfully.",
      ),
    ).toBe("suppress");
  });

  test("a FAILED edit (different wording) does NOT suppress — renders through generic/error", () => {
    expect(
      pickToolResultDispatch(
        "Edit",
        "String to replace not found in file. No edits were applied.",
      ),
    ).toBe("generic");
  });

  test("a FAILED new-file write does NOT suppress", () => {
    expect(
      pickToolResultDispatch(
        "Write",
        "Failed to create file: permission denied",
      ),
    ).toBe("generic");
  });

  test("suppression is tool-name scoped — a Bash result echoing the success phrase is not suppressed", () => {
    expect(
      pickToolResultDispatch(
        "Bash",
        "The file /repo/x.ts has been updated successfully.",
      ),
    ).toBe("generic");
  });
});

// BUG 3: TodoWrite has no structured renderer; its boilerplate success body
// ("Todos have been modified successfully. Ensure that you continue…") used to
// render verbatim. Mirror the Edit/Write success suppression so it does not.
// The live result string is copied from
//   runtime/src/tools/TodoWriteTool/TodoWriteTool.ts (mapToolResultToToolResultBlockParam)
describe("pickToolResultDispatch — TodoWrite success suppression (BUG 3)", () => {
  const TODO_SUCCESS =
    "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable";

  test("TodoWrite success boilerplate suppresses (no verbatim render alongside the call row)", () => {
    expect(pickToolResultDispatch("TodoWrite", TODO_SUCCESS)).toBe("suppress");
  });

  test("TodoWrite success with the trailing verification nudge still suppresses", () => {
    const withNudge = `${TODO_SUCCESS}\n\nNOTE: You just closed out 3+ tasks and none of them was a verification step.`;
    expect(pickToolResultDispatch("TodoWrite", withNudge)).toBe("suppress");
  });

  test("a FAILED TodoWrite (different wording) does NOT suppress — renders through generic", () => {
    expect(
      pickToolResultDispatch("TodoWrite", "Error: invalid todo status 'foo'"),
    ).toBe("generic");
  });

  test("suppression is tool-name scoped — a Bash result echoing the todo phrase is not suppressed", () => {
    expect(pickToolResultDispatch("Bash", TODO_SUCCESS)).toBe("generic");
  });
});
