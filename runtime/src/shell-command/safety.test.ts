import { describe, expect, test } from "vitest";
import {
  commandMightBeDangerous,
  isDangerousPowerShellWords,
  isDangerousWindowsCommand,
  isKnownSafeCommand,
  isSafePowerShellWords,
  shellCommandIsKnownSafe,
} from "./safety.js";

describe("isKnownSafeCommand", () => {
  test("allows read-only Unix commands and tight git branch inspection", () => {
    expect(isKnownSafeCommand(["ls"])).toBe(true);
    expect(isKnownSafeCommand(["cat", "file.txt"])).toBe(true);
    expect(isKnownSafeCommand(["git", "status", "--short"])).toBe(true);
    expect(isKnownSafeCommand(["git", "branch", "--show-current"])).toBe(true);
    expect(isKnownSafeCommand(["sed", "-n", "1,5p", "file.txt"])).toBe(true);
    expect(isKnownSafeCommand(["base64", "file.txt"])).toBe(true);
  });

  test("rejects read-looking commands that can write or execute helpers", () => {
    expect(isKnownSafeCommand(["git", "-C", ".", "status"])).toBe(false);
    expect(isKnownSafeCommand(["git", "-C.", "status"])).toBe(false);
    expect(isKnownSafeCommand(["git", "-ccore.pager=cat", "status"])).toBe(false);
    expect(isKnownSafeCommand(["git", "--git-dir=.evil-git", "diff"])).toBe(false);
    expect(isKnownSafeCommand(["git", "--super-prefix=attacker/", "show", "HEAD"]))
      .toBe(false);
    expect(isKnownSafeCommand(["git", "--super-prefix", "attacker/", "show", "HEAD"]))
      .toBe(false);
    expect(isKnownSafeCommand(["git", "log", "--output=/tmp/out"])).toBe(false);
    expect(isKnownSafeCommand(["git", "log", "--ext-diff"])).toBe(false);
    expect(isKnownSafeCommand(["git", "show", "--textconv", "HEAD"])).toBe(false);
    expect(isKnownSafeCommand(["git", "log", "--exec=touch /tmp/x"])).toBe(false);
    expect(isKnownSafeCommand(["git", "--paginate", "status"])).toBe(false);
    expect(isKnownSafeCommand(["git", "branch", "new-branch"])).toBe(false);
    expect(isKnownSafeCommand(["find", ".", "-delete"])).toBe(false);
    expect(isKnownSafeCommand(["find", ".", "-exec", "rm", "{}", ";"])).toBe(false);
    expect(isKnownSafeCommand(["base64", "--output=out", "file.txt"])).toBe(false);
    expect(isKnownSafeCommand(["rg", "--pre", "cat", "needle"])).toBe(false);
    expect(isKnownSafeCommand(["rg", "--search-zip", "needle"])).toBe(false);
  });

  test("recurses through word-only Bash wrappers without approving unsafe children", () => {
    expect(isKnownSafeCommand(["bash", "-lc", "ls && pwd"])).toBe(true);
    expect(isKnownSafeCommand(["bash", "-lc", "ls && rm -rf /"])).toBe(false);
    expect(isKnownSafeCommand(["bash", "-lc", "git -C. status"])).toBe(false);
    expect(isKnownSafeCommand(["bash", "-lc", "git show --textconv HEAD"]))
      .toBe(false);
    expect(shellCommandIsKnownSafe("bash -lc 'git status && rg TODO runtime'"))
      .toBe(true);
  });
});

describe("commandMightBeDangerous", () => {
  test("flags forced removal directly and through sudo or Bash wrappers", () => {
    expect(commandMightBeDangerous(["rm", "-rf", "/"])).toBe(true);
    expect(commandMightBeDangerous(["sudo", "rm", "-f", "/tmp/file"])).toBe(true);
    expect(commandMightBeDangerous(["bash", "-lc", "echo ok && rm -rf /"]))
      .toBe(true);
    expect(commandMightBeDangerous(["git", "status"])).toBe(false);
  });
});

describe("Windows and PowerShell safety lists", () => {
  test("detects Windows URL launch and forced deletion forms", () => {
    expect(isDangerousWindowsCommand(["cmd", "/c", "start", "https://agenc.tech"]))
      .toBe(true);
    expect(
      isDangerousWindowsCommand([
        "powershell",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Remove-Item file.txt -Force",
      ]),
    ).toBe(true);
    expect(
      isDangerousWindowsCommand([
        "powershell",
        "-Mta",
        "-Command",
        "Remove-Item file.txt -Force",
      ]),
    ).toBe(true);
    expect(
      isDangerousWindowsCommand([
        "powershell",
        "-UnknownSwitch",
        "-Command",
        "Remove-Item file.txt -Force",
      ]),
    ).toBe(true);
    expect(
      isDangerousWindowsCommand([
        "rundll32.exe",
        "url.dll,FileProtocolHandler",
        "https://agenc.tech",
      ]),
    ).toBe(true);
  });

  test("classifies literal PowerShell commands without dynamic constructs", () => {
    expect(isDangerousPowerShellWords(["Start-Process", "https://agenc.tech"]))
      .toBe(true);
    expect(isDangerousPowerShellWords(["Remove-Item", "file.txt", "-Force"]))
      .toBe(true);
    expect(isSafePowerShellWords(["Get-ChildItem", "."])).toBe(true);
    expect(isSafePowerShellWords(["git", "status"])).toBe(true);
    expect(isSafePowerShellWords(["rg", "--search-zip", "needle"])).toBe(false);
    expect(isSafePowerShellWords(["Remove-Item", "file.txt"])).toBe(false);
  });
});
