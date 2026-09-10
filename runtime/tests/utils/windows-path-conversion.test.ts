import { expect, it } from "vitest";
import { convertWindowsPathToPosix } from "../../src/utils/windows-path-conversion.js";
import { windowsPathToPosixPath } from "../../src/utils/windowsPaths.js";

it.each([
  [String.raw`C:\Users\temporary files\é`, "/c/Users/temporary files/é"],
  ["D:/temporary/files", "/d/temporary/files"],
  [String.raw`\\server\share\temporary files`, "//server/share/temporary files"],
  [String.raw`\\?\C:\temporary`, "//?/C:/temporary"],
  ["//server/share", "//server/share"],
  [String.raw`relative\folder`, "relative/folder"],
  ["/tmp/é", "/tmp/é"],
  ["C:", "C:"],
  ["", ""],
])("preserves Windows shell path conversion for %s", (input, expected) => {
  expect(convertWindowsPathToPosix(input)).toBe(expected);
  expect(windowsPathToPosixPath(input)).toBe(expected);
});

it("preserves the memoized path API", () => {
  windowsPathToPosixPath.cache.clear();
  expect(windowsPathToPosixPath(String.raw`C:\temp`)).toBe("/c/temp");
  expect(windowsPathToPosixPath(String.raw`C:\temp`)).toBe("/c/temp");
  expect(windowsPathToPosixPath.cache.size()).toBe(1);
  windowsPathToPosixPath.cache.clear();
});
