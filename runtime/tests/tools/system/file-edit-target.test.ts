import { expect, test } from "vitest";
import {
  fileEditTargetKey,
  fileEditTargetPath,
  hookToolInput,
  toolInputFromHook,
} from "../../../src/tools/system/file-edit-target.js";

const batch = { path: "/repo/notes.txt", edits: [{ oldText: "a", newText: "b" }] };
const classic = { file_path: "/repo/notes.txt", old_string: "a", new_string: "b" };

test("file_path wins; batch path is used only with edits and no file_path", () => {
  expect(fileEditTargetPath(classic)).toBe("/repo/notes.txt");
  expect(fileEditTargetPath({ ...classic, path: "/other", edits: [] })).toBe("/repo/notes.txt");
  expect(fileEditTargetPath(batch)).toBe("/repo/notes.txt");
  expect(fileEditTargetPath({ path: "/repo/notes.txt" })).toBeUndefined();
  expect(fileEditTargetPath({ edits: batch.edits })).toBeUndefined();
  expect(fileEditTargetPath({ path: 12, edits: batch.edits })).toBeUndefined();
  expect(fileEditTargetPath({ file_path: "" })).toBe("");
  expect(fileEditTargetKey(batch)).toBe("path");
  expect(fileEditTargetKey(classic)).toBe("file_path");
  expect(fileEditTargetKey({ file_path: "", path: "/repo/notes.txt", edits: batch.edits })).toBe("file_path");
  expect(fileEditTargetKey({ path: "/repo/notes.txt" })).toBe("file_path");
});

test("only batch Edit gets a synthetic file_path for hooks", () => {
  const hooked = hookToolInput("Edit", batch);
  expect(hooked).toEqual({ ...batch, file_path: batch.path });
  expect(hooked).not.toBe(batch);
  expect(hookToolInput("Edit", classic)).toBe(classic);
  expect(hookToolInput("Write", batch)).toBe(batch);
  expect(hookToolInput("MultiEdit", { file_path: "/repo/a.ts", edits: [] })).toEqual({
    file_path: "/repo/a.ts", edits: [],
  });
});

test("hook echo or file_path redirect maps back to batch path without leaking file_path", () => {
  const echoed = { ...batch, file_path: batch.path };
  expect(toolInputFromHook("Edit", batch, echoed)).toEqual(batch);
  expect(toolInputFromHook("Edit", batch, { ...batch, file_path: "/repo/other.txt" }))
    .toEqual({ ...batch, path: "/repo/other.txt" });
  expect(toolInputFromHook("Edit", batch, { edits: batch.edits, file_path: "/repo/other.txt" }))
    .toEqual({ edits: batch.edits, path: "/repo/other.txt" });
});

test("a hook that changes path keeps that change and other tools keep updatedInput", () => {
  const moved = { path: "/repo/moved.txt", edits: batch.edits, file_path: "/repo/hook.txt" };
  expect(toolInputFromHook("Edit", batch, moved)).toEqual({
    path: "/repo/moved.txt", edits: batch.edits,
  });
  expect(toolInputFromHook("Edit", batch, { ...batch, file_path: 12 })).toEqual(batch);
  const updated = { ...classic, extra: true };
  expect(toolInputFromHook("Write", classic, updated)).toBe(updated);
  const classicEcho = { ...classic, file_path: classic.file_path };
  expect(toolInputFromHook("Edit", classic, classicEcho)).toBe(classicEcho);
});
