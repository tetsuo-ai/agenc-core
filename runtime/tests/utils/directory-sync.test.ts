import { closeSync, fsyncSync, openSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { syncDirectorySync } from "../../src/utils/durable-atomic-file.js";

// Reload helpers imported by test setup so filesystem fault injection reaches them.
vi.hoisted(() => vi.resetModules());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(), fsyncSync: vi.fn(), closeSync: vi.fn() };
});

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const unsupportedCodes = ["EBADF", "EISDIR", "EINVAL", "ENOTSUP", "EPERM", "EACCES"];

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.resetAllMocks();
});

describe.each(["win32", "linux", "darwin"] as const)("sync directory on %s", (platform) => {
  test.each(unsupportedCodes)("preserves the platform policy for %s from open and fsync", (code) => {
    Object.defineProperty(process, "platform", { value: platform });
    const error = Object.assign(new Error(code), { code });
    for (const phase of ["open", "sync"]) {
      vi.resetAllMocks();
      vi.mocked(openSync).mockImplementation(() => {
        if (phase === "open") throw error;
        return 42;
      });
      vi.mocked(fsyncSync).mockImplementation(() => { throw error; });
      if (platform === "win32" || code === "EINVAL" || code === "ENOTSUP") expect(() => syncDirectorySync("directory")).not.toThrow();
      else expect(() => syncDirectorySync("directory")).toThrow(error);
      expect(closeSync).toHaveBeenCalledTimes(phase === "open" ? 0 : 1);
      if (phase === "sync") expect(closeSync).toHaveBeenCalledWith(42);
    }
  });

  test.each(["EIO", "ENOSPC", "ENOENT"])("propagates %s from open and fsync", (code) => {
    Object.defineProperty(process, "platform", { value: platform });
    const error = Object.assign(new Error(code), { code });
    for (const phase of ["open", "sync"]) {
      vi.resetAllMocks();
      vi.mocked(openSync).mockImplementation(() => {
        if (phase === "open") throw error;
        return 42;
      });
      vi.mocked(fsyncSync).mockImplementation(() => { throw error; });
      expect(() => syncDirectorySync("directory")).toThrow(error);
      expect(closeSync).toHaveBeenCalledTimes(phase === "open" ? 0 : 1);
    }
  });
});

test("does not suppress close failures on Windows", () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const error = Object.assign(new Error("close: EPERM"), { code: "EPERM" });
  vi.mocked(openSync).mockReturnValue(42);
  vi.mocked(closeSync).mockImplementation(() => { throw error; });
  expect(() => syncDirectorySync("directory")).toThrow(error);
});
