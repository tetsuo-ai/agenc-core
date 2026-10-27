import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

// The documented Windows one-liner runs in Windows PowerShell 5.1, the shell
// Windows 11 ships with. CI exercises install.ps1 under PowerShell 7 only, so
// these checks keep the 5.1 hazards found on a stock Windows 11 VM out of it.
const REPO_ROOT = resolve(process.cwd(), "..");
const INSTALL_PS1 = readFileSync(join(REPO_ROOT, "scripts", "install", "install.ps1"), "utf8");

/** PowerShell source with here-strings, quoted strings and comments blanked, so embedded JS is ignored. */
function powershellCode(source: string): string {
  return source
    .replace(/@'\n[\s\S]*?\n'@/g, "@''@")
    .replace(/'(?:[^'\n]|'')*'/g, "''")
    .replace(/^\s*#.*$/gm, "");
}

describe("install.ps1 under Windows PowerShell 5.1", () => {
  test("loads .NET assemblies with Add-Type, which resolves them in 5.1", () => {
    // [Reflection.Assembly]::Load("System.Net.Http") fails in 5.1 with
    // "Could not load file or assembly", before anything is installed.
    expect(INSTALL_PS1).not.toMatch(/\[System\.Reflection\.Assembly\]::Load\(/);
    expect(INSTALL_PS1).toContain("Add-Type -AssemblyName System.Net.Http");
    expect(INSTALL_PS1).toContain("Add-Type -AssemblyName System.IO.Compression.FileSystem");
  });

  test("hands every inline Node script through ConvertTo-NativeArgument", () => {
    // 5.1 does not escape double quotes inside native arguments, so a raw
    // `node -e <script>` arrives with its string literals stripped.
    const inline = [...INSTALL_PS1.matchAll(/ -e (\S+)/g)].map((match) => match[1]);
    expect(inline.length).toBeGreaterThan(5);
    for (const argument of inline) {
      expect(argument).toBe("(ConvertTo-NativeArgument");
    }
  });

  test("keeps empty positional arguments for the runtime installer and fetcher", () => {
    // 5.1 drops "" native arguments, which shifts every positional argument after it.
    const code = powershellCode(INSTALL_PS1);
    expect(code).toMatch(/\$fetchArgs = ConvertTo-NativeArguments @\(/);
    expect(code).toMatch(/& node - @fetchArgs/);
    expect(code).toMatch(/\$recoverArgs = ConvertTo-NativeArguments @\(/);
    expect(code).toMatch(/\$installArgs = ConvertTo-NativeArguments @\(/);
    expect(code).not.toMatch(/& node \$runtimeInstallerPath (recover|install) /);
  });

  test("writes the private directory ACL without the audit section in 5.1", () => {
    // 5.1's Set-Acl also writes the SACL, which needs SeSecurityPrivilege.
    const setAcl = [...powershellCode(INSTALL_PS1).matchAll(/Set-Acl /g)];
    expect(setAcl).toHaveLength(1);
    expect(INSTALL_PS1).toContain("(Get-Item -LiteralPath $Path -Force).SetAccessControl($Acl)");
  });

  test("finds gh.exe at the root of the Windows GitHub CLI zip", () => {
    // The Windows zip holds LICENSE and bin/gh.exe with no versioned folder.
    expect(INSTALL_PS1).toContain('$ghBinary = Join-Path $ghRoot "bin/gh.exe"');
  });

  test("flushes runtime files through a handle Windows can flush", () => {
    // FlushFileBuffers needs write access; a read-only handle fails with EPERM.
    expect(INSTALL_PS1).toContain(
      "openSync(path, windows ? fsConstants.O_RDWR : fsConstants.O_RDONLY)",
    );
  });
});
