import { expect, test } from "vitest";
import { buildEditDiffPreview, editPairsFromInput } from "../../src/tui/edit-diff-preview.js";

test("the batch Edit call and approval preview show every exact old/new pair", () => {
  const input = { path: "src/sample.ts", edits: [{ oldText: "first = old", newText: "first = new" }, { oldText: "second = old", newText: "second = new" }] };
  expect(editPairsFromInput("Edit", input)).toEqual({ file: "src/sample.ts", pairs: [{ oldString: "first = old", newString: "first = new" }, { oldString: "second = old", newString: "second = new" }] });
  const preview = buildEditDiffPreview("Edit", input);
  expect(preview).toMatchObject({ file: "src/sample.ts", additions: 2, removals: 2, stats: "+2 -2" });
  expect(preview!.lines.filter(line => line.kind === "add").map(line => line.code)).toEqual(["first = new", "second = new"]);
});
