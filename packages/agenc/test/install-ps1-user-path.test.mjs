import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

// install.ps1 puts the agenc.cmd shim folder on the user PATH. These tests
// pin the matching rules, the opt-out and the removed setx advice. The
// behavior tests run the marked PowerShell block when PowerShell is present;
// the registry tests run only on Windows and use a scratch HKCU key.
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const installPs1 = readFileSync(
  join(repoRoot, "scripts", "install", "install.ps1"),
  "utf8",
);
const readme = readFileSync(join(repoRoot, "scripts", "install", "README.md"), "utf8");

/** install.ps1 without here-strings, so the embedded JavaScript is ignored. */
const powershellSource = installPs1.replace(/@'\n[\s\S]*?\n'@/g, "@''@");

function userPathBlock() {
  const blocks = [
    ...installPs1.matchAll(/# BEGIN AGENC USER PATH\n([\s\S]*?)\n\s*# END AGENC USER PATH/g),
  ];
  assert.equal(blocks.length, 1, "install.ps1 has one marked user PATH block");
  return blocks[0][1];
}

function findPowerShell() {
  const candidates = process.platform === "win32" ? ["powershell.exe", "pwsh.exe"] : ["pwsh"];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-NoProfile", "-NonInteractive", "-Command", "1"], {
      encoding: "utf8",
    });
    if (probe.status === 0) return candidate;
  }
  return undefined;
}

const powershell = findPowerShell();
const noPowerShell = powershell === undefined ? "PowerShell is not installed" : false;
const notWindows = process.platform !== "win32" ? "needs the Windows registry" : noPowerShell;

function runUserPathBlock(script) {
  const dir = mkdtempSync(join(tmpdir(), "agenc-user-path-"));
  try {
    const file = join(dir, "case.ps1");
    writeFileSync(file, `$ErrorActionPreference = "Stop"\n${userPathBlock()}\n${script}\n`, "utf8");
    const result = spawnSync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result.stdout.replace(/\r\n/g, "\n").trim().split("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** PowerShell single-quoted literal. */
const ps = (value) => `'${value.replaceAll("'", "''")}'`;
const show = (expression) => `$r = ${expression}; if ($null -eq $r) { '<null>' } else { [string]$r }`;
const binDir = "C:\\Users\\sa\\AppData\\Local\\agenc\\bin";

test("install.ps1 never advises setx", () => {
  assert.doesNotMatch(installPs1, /\bsetx\b/i);
});

test("install.ps1 does not test PATH membership with a wildcard", () => {
  assert.doesNotMatch(powershellSource, /-(?:not)?like\s+"\*\$binDir\*"/i);
  assert.doesNotMatch(powershellSource, /-(?:not)?like\s+["']\*[^"']*binDir/i);
});

test("install.ps1 writes only the user PATH and never the machine PATH", () => {
  const block = userPathBlock();
  assert.match(block, /\[Microsoft\.Win32\.Registry\]::CurrentUser\.CreateSubKey\(\$KeyPath\)/);
  assert.match(block, /DoNotExpandEnvironmentNames/);
  assert.match(block, /\$key\.SetValue\("Path", \$updated, \$kind\)/);
  assert.doesNotMatch(powershellSource, /LocalMachine|HKLM:|["']Machine["']/);
  assert.doesNotMatch(powershellSource, /SetEnvironmentVariable\(\s*["']Path["']/i);
});

test("install.ps1 adds the shim folder unless AGENC_NO_MODIFY_PATH opts out", () => {
  const branch = powershellSource.match(
    /\n {2}if \(\$actualWindows -and \(Test-AgencModifyPathAllowed \$env:AGENC_NO_MODIFY_PATH\)\) \{\n([\s\S]*?)\n {2}\} elseif /,
  );
  assert.ok(branch, "the PATH update is gated on Windows and the opt-out");
  assert.match(branch[1], /\$pathAdded = Add-AgencUserPathEntry \$binDir\n/);
  assert.equal(
    [...powershellSource.matchAll(/Add-AgencUserPathEntry \$binDir/g)].length,
    1,
    "the user PATH is written from the gated branch only",
  );
  assert.match(
    installPs1,
    /Write-Log "added \$binDir to your user PATH; open a new terminal to use agenc"/,
  );
  assert.match(powershellSource, /\$priorNodeEnvironment\["PATH"\] = \$sessionPath/);
  assert.match(installPs1, /^# {3}AGENC_NO_MODIFY_PATH=1 /m);
  assert.match(readme, /AGENC_NO_MODIFY_PATH=1/);
});

test("the user PATH block is ASCII for Windows PowerShell 5.1", () => {
  assert.match(userPathBlock(), /^[\x09\x0a\x0d\x20-\x7e]*$/);
});

test("PATH entries match exactly, ignoring case, spaces and trailing slashes", { skip: noPowerShell }, () => {
  const cases = [
    [`C:\\Windows;${binDir}`, "True"],
    [` c:\\users\\SA\\appdata\\local\\AGENC\\BIN\\ ;C:\\Windows`, "True"],
    [`${binDir}/`, "True"],
    [`${binDir}-old;${binDir}\\sub;D:\\x${binDir}`, "False"],
    [`C:\\Windows;;`, "False"],
    ["", "False"],
    [`%AGENC_TEST_ROOT%\\AppData\\Local\\agenc\\bin`, "True"],
  ];
  const script = [
    "$env:AGENC_TEST_ROOT = 'C:\\Users\\sa'",
    ...cases.map(([pathValue]) => `[string](Test-AgencPathEntry ${ps(pathValue)} ${ps(binDir)})`),
    `[string](Test-AgencPathEntry $null ${ps(binDir)})`,
  ].join("\n");
  assert.deepEqual(runUserPathBlock(script), [...cases.map(([, expected]) => expected), "False"]);
});

test("appending keeps the existing value and adds no duplicate", { skip: noPowerShell }, () => {
  const script = [
    show(`Get-AgencPathWithEntry 'C:\\a;;C:\\b' ${ps(binDir)}`),
    show(`Get-AgencPathWithEntry 'C:\\a;' ${ps(binDir)}`),
    show(`Get-AgencPathWithEntry '' ${ps(binDir)}`),
    show(`Get-AgencPathWithEntry $null ${ps(binDir)}`),
    show(`Get-AgencPathWithEntry ${ps(`C:\\a;${binDir}\\;C:\\b`)} ${ps(binDir)}`),
    `$once = Get-AgencPathWithEntry ${ps(`C:\\a;${binDir}-old`)} ${ps(binDir)}`,
    "$once",
    show(`Get-AgencPathWithEntry $once ${ps(binDir)}`),
  ].join("\n");
  assert.deepEqual(runUserPathBlock(script), [
    `C:\\a;;C:\\b;${binDir}`,
    `C:\\a;${binDir}`,
    binDir,
    binDir,
    "<null>",
    `C:\\a;${binDir}-old;${binDir}`,
    "<null>",
  ]);
});

test("AGENC_NO_MODIFY_PATH=1 opts out", { skip: noPowerShell }, () => {
  const values = ["1", "true", "YES", " 1 "];
  const allowed = ["", "0", "false"];
  const script = [
    ...values.map((value) => `[string](Test-AgencModifyPathAllowed ${ps(value)})`),
    ...allowed.map((value) => `[string](Test-AgencModifyPathAllowed ${ps(value)})`),
    "[string](Test-AgencModifyPathAllowed $null)",
  ].join("\n");
  assert.deepEqual(runUserPathBlock(script), [
    ...values.map(() => "False"),
    ...allowed.map(() => "True"),
    "True",
  ]);
});

test("registry write keeps REG_EXPAND_SZ text and type and adds the entry once", { skip: notWindows }, () => {
  const scratch = `Software\\AgencInstallPathTest-${process.pid}-${Date.now()}`;
  const script = [
    `$scratch = ${ps(scratch)}`,
    "try {",
    "  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($scratch)",
    "  $key.SetValue('Path', '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;', [Microsoft.Win32.RegistryValueKind]::ExpandString)",
    "  $key.Close()",
    `  [string](Add-AgencUserPathEntry ${ps(binDir)} $scratch)`,
    `  [string](Add-AgencUserPathEntry ${ps(binDir.toUpperCase() + "\\")} $scratch)`,
    "  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($scratch)",
    "  [string]$key.GetValueKind('Path')",
    "  $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    "  $key.Close()",
    "  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($scratch)",
    "  $key.SetValue('Path', 'C:\\Tools', [Microsoft.Win32.RegistryValueKind]::String)",
    "  $key.Close()",
    `  [string](Add-AgencUserPathEntry ${ps(binDir)} $scratch)`,
    "  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($scratch)",
    "  [string]$key.GetValueKind('Path')",
    "  $key.GetValue('Path')",
    "  $key.Close()",
    "  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($scratch)",
    "  $key.DeleteValue('Path')",
    "  $key.Close()",
    `  [string](Add-AgencUserPathEntry ${ps(binDir)} $scratch)`,
    "  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($scratch)",
    "  [string]$key.GetValueKind('Path')",
    "  $key.GetValue('Path')",
    "  $key.Close()",
    "} finally {",
    "  [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($scratch, $false)",
    "}",
  ].join("\n");
  assert.deepEqual(runUserPathBlock(script), [
    "True",
    "False",
    "ExpandString",
    `%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;${binDir}`,
    "True",
    "String",
    `C:\\Tools;${binDir}`,
    "True",
    "ExpandString",
    binDir,
  ]);
});

test("the environment change notice runs on Windows PowerShell", { skip: notWindows }, () => {
  assert.deepEqual(runUserPathBlock("Send-AgencEnvironmentChange\n'sent'"), ["sent"]);
});
