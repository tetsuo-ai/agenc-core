import { afterEach, describe, expect, test, vi } from "vitest";

import {
  executableLookupKey,
  executablePathLookupKey,
} from "../../../src/sandbox/execpolicy/executable-name.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("executableLookupKey", () => {
  test("leaves the raw name unchanged off Windows", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(executableLookupKey("CMD.EXE")).toBe("CMD.EXE");
    expect(executableLookupKey("Git")).toBe("Git");
  });

  test("strips Windows executable suffixes and lowercases", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(executableLookupKey("CMD.EXE")).toBe("cmd");
    expect(executableLookupKey("script.BAT")).toBe("script");
    expect(executableLookupKey("tool.Com")).toBe("tool");
    expect(executableLookupKey("build.cmd")).toBe("build");
    expect(executableLookupKey("git")).toBe("git");
  });
});

describe("executablePathLookupKey", () => {
  test("uses the basename and rejects empty path forms", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(executablePathLookupKey("/usr/bin/git")).toBe("git");
    expect(executablePathLookupKey("git")).toBe("git");
    expect(executablePathLookupKey("")).toBeNull();
    expect(executablePathLookupKey(".")).toBeNull();
    expect(executablePathLookupKey("/")).toBeNull();
  });

  test("Windows path lookup strips the basename suffix", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(executablePathLookupKey("/windows/system32/cmd.EXE")).toBe("cmd");
  });
});
