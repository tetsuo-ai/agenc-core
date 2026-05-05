import { describe, expect, test } from "vitest";
import {
  commandMightBeDangerous,
  isDangerousPowerShellWords,
  isDangerousWindowsCommand,
  isKnownSafeCommand,
  isSafePowerShellWords,
  isSafeWindowsCommand,
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
    expect(isKnownSafeCommand(["git", "grep", "needle"])).toBe(false);
    expect(isKnownSafeCommand(["git", "ls-files"])).toBe(false);
    expect(isKnownSafeCommand(["git", "branch", "new-branch"])).toBe(false);
    expect(isKnownSafeCommand(["find", ".", "-delete"])).toBe(false);
    expect(isKnownSafeCommand(["find", ".", "-exec", "rm", "{}", ";"])).toBe(false);
    expect(isKnownSafeCommand(["find", ".", "-ok", "rm", "{}", ";"])).toBe(false);
    expect(isKnownSafeCommand(["find", ".", "-okdir", "rm", "{}", ";"])).toBe(false);
    expect(isKnownSafeCommand(["find", ".", "-fls", "out"])).toBe(false);
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
    expect(isKnownSafeCommand(["bash", "-lc", "git grep needle"])).toBe(false);
    expect(isKnownSafeCommand(["bash", "-lc", "git ls-files"])).toBe(false);
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
        "-Sta",
        "-Command",
        "Remove-Item file.txt -Force",
      ]),
    ).toBe(true);
    expect(
      isDangerousWindowsCommand([
        "powershell",
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
        "powershell",
        "-Command",
        "del,-Force,C:\\foo",
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
    expect(isDangerousPowerShellWords(["Start-Process('https://agenc.tech')"]))
      .toBe(true);
    expect(isDangerousPowerShellWords(['Invoke-Item("https://agenc.tech")']))
      .toBe(true);
    expect(isDangerousPowerShellWords(["ShellExecute", "https://agenc.tech"]))
      .toBe(true);
    expect(
      isDangerousPowerShellWords([
        "Write-Host",
        "(Remove-Item",
        "file.txt",
        "-Force)",
      ]),
    ).toBe(true);
    expect(isDangerousPowerShellWords(["Write-Host", "(ri", "file.txt", "-Force)"]))
      .toBe(true);
    expect(isDangerousPowerShellWords(["Write-Host", "(del", "file.txt", "-Force)"]))
      .toBe(true);
    expect(isDangerousPowerShellWords(["Write-Host", "(rmdir", "dir", "-Force)"]))
      .toBe(true);
    expect(isDangerousPowerShellWords(["del,-Force,C:\\foo"])).toBe(true);
    expect(isDangerousPowerShellWords(["Remove-Item", "file.txt", "-Force"]))
      .toBe(true);
    expect(isSafePowerShellWords(["Get-ChildItem", "."])).toBe(true);
    expect(isSafePowerShellWords(["gci", "."])).toBe(true);
    expect(isSafePowerShellWords(["gc", "file.txt"])).toBe(true);
    expect(isSafePowerShellWords(["sls", "needle", "file.txt"])).toBe(true);
    expect(isSafePowerShellWords(["measure"])).toBe(true);
    expect(isSafePowerShellWords(["gl"])).toBe(true);
    expect(isSafePowerShellWords(["tp", "file.txt"])).toBe(true);
    expect(isSafePowerShellWords(["rvpa", "."])).toBe(true);
    expect(isSafePowerShellWords(["select", "Name"])).toBe(true);
    expect(isSafePowerShellWords(["git", "status"])).toBe(true);
    expect(isSafePowerShellWords(["git", "cat-file", "-p", "HEAD"])).toBe(true);
    expect(isSafePowerShellWords(["git", "ls-files"])).toBe(false);
    expect(isSafePowerShellWords(["rg", "--search-zip", "needle"])).toBe(false);
    expect(isSafePowerShellWords(["Remove-Item", "file.txt"])).toBe(false);
    expect(isSafePowerShellWords(["Write-Host", "Set-Content", "file.txt"])).toBe(false);
    expect(isSafePowerShellWords(["Write-Host", "Add-Content", "file.txt"])).toBe(false);
    expect(isSafePowerShellWords(["Write-Host", "Out-File", "file.txt"])).toBe(false);
    expect(isSafePowerShellWords(["Write-Host", "New-Item", "file.txt"])).toBe(false);
    expect(isSafePowerShellWords(["Write-Host", "Move-Item", "a", "b"])).toBe(false);
    expect(isSafePowerShellWords(["Write-Host", "Copy-Item", "a", "b"])).toBe(false);
    expect(isSafePowerShellWords(["Write-Host", "Rename-Item", "a", "b"])).toBe(false);
    expect(isSafePowerShellWords(["Write-Host", "Start-Process", "tool"])).toBe(false);
    expect(isSafePowerShellWords(["Write-Host", "Stop-Process", "123"])).toBe(false);
  });

  test("does not run user-supplied PowerShell executable paths for safe checks", () => {
    expect(
      isSafeWindowsCommand([
        "C:\\Users\\attacker\\pwsh.exe",
        "-Command",
        "Get-ChildItem",
      ]),
    ).toBe(false);
    expect(
      isSafeWindowsCommand([
        "/tmp/pwsh",
        "-Command",
        "Get-ChildItem",
      ]),
    ).toBe(false);
  });
});
