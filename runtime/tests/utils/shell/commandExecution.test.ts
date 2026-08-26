import { describe, expect, test } from "vitest";

import {
  acceptsPosixCommandWrapper,
  commandShellArgs,
  wrapCommandForShell,
} from "../../../src/utils/shell/commandExecution.js";

describe("command shell execution", () => {
  test("selects argv from the configured shell instead of the host OS", () => {
    expect(commandShellArgs("C:\\Program Files\\Git\\bin\\bash.exe", "ok")).toEqual([
      "-c",
      "ok",
    ]);
    expect(commandShellArgs("cmd.exe", "ok")).toEqual([
      "/d",
      "/s",
      "/c",
      "ok",
    ]);
    expect(commandShellArgs("C:\\Windows\\System32\\cmd.exe", "ok")).toEqual([
      "/d",
      "/s",
      "/c",
      "ok",
    ]);
    expect(commandShellArgs("pwsh.exe", "ok")).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "ok",
    ]);
  });

  test("applies wrappers only to POSIX command shells", () => {
    expect(acceptsPosixCommandWrapper("/bin/zsh")).toBe(true);
    expect(acceptsPosixCommandWrapper("bash.exe")).toBe(true);
    expect(acceptsPosixCommandWrapper("cmd.exe")).toBe(false);
    expect(acceptsPosixCommandWrapper("powershell.exe")).toBe(false);
  });

  test("does not inject a POSIX wrapper into cmd or PowerShell", () => {
    const wrapper = ["env", "MODE=safe", "/bin/sh", "-c"];
    expect(wrapCommandForShell("cmd.exe", wrapper, "echo ok")).toBe("echo ok");
    expect(wrapCommandForShell("pwsh.exe", wrapper, "echo ok")).toBe("echo ok");
    expect(wrapCommandForShell("/bin/sh", wrapper, "echo ok")).not.toBe(
      "echo ok",
    );
  });
});
