#!/usr/bin/env node

// Native #2976 crash-message regressions. From runtime/ on a local NTFS volume:
// node --import tsx scripts/check-cron-publication-kill.mjs --pwsh <absolute pwsh.exe> --output <report.json>
// Only the publication child is switched to pwsh for its matrix. All ACL and
// identity checks, the shipped publication body, and confined readback are real.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { isAbsolute, join, resolve } from "node:path";

assert.equal(process.platform, "win32", "This test requires native Windows; a Linux simulation is not sufficient.");
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  assert.ok(["--pwsh", "--output"].includes(key) && !options.has(key) && process.argv[index + 1], "Expected --pwsh and --output once each.");
  options.set(key, process.argv[index + 1]);
}
const pwsh = options.get("--pwsh");
const output = options.get("--output");
assert.ok(pwsh && isAbsolute(pwsh) && existsSync(pwsh), "Supply the absolute path to an installed PowerShell 7 pwsh.exe.");
assert.ok(output && isAbsolute(output), "Supply an absolute output JSON path.");
const root = mkdtempSync(join(os.tmpdir(), "agenc-cron-kill-"));
const fixtureHome = join(root, "os-home");
mkdirSync(fixtureHome);

// Isolate the trusted cron-lock namespace without touching the user's OS home.
const originalUserInfo = os.userInfo;
os.userInfo = (settings) => ({
  ...originalUserInfo(settings),
  homedir: settings?.encoding === "buffer" ? Buffer.from(fixtureHome) : fixtureHome,
});
const cp = createRequire(import.meta.url)("node:child_process");
const originalExec = cp.execFileSync;
let selectedShell;
let launches = [];
cp.execFileSync = function (file, args, settings) {
  const variables = settings?.env;
  if (variables?.AGENC_CRON_PUBLISH_DIRECTORY !== undefined) {
    const body = Buffer.from(variables.AGENC_CRON_PUBLISH_BODY, "base64").toString("utf8");
    const start = body.indexOf("Add-Type -TypeDefinition '") + "Add-Type -TypeDefinition '".length;
    const helper = body.slice(start, body.indexOf("'", start));
    launches.push({ executable: selectedShell ?? file, helperSha256: createHash("sha256").update(helper).digest("hex") });
    return originalExec.call(this, selectedShell ?? file, args, settings);
  }
  return originalExec.call(this, file, args, settings);
};
syncBuiltinESMExports();

const faultKeys = ["AGENC_CRON_PUBLISH_FAULT", "AGENC_CRON_PUBLISH_HOOK", "AGENC_CRON_PUBLISH_ROLLBACK"];
const originalFaults = faultKeys.map((key) => process.env[key]);
const clearFaults = () => { for (const key of faultKeys) delete process.env[key]; };
const psLiteral = (text) => `'${text.replaceAll("'", "''")}'`;
const record = (id) => `${JSON.stringify({ tasks: [{ id, cron: "* * * * *", prompt: id, createdAt: 1 }] })}\n`;
const previous = record("previous");
const intended = record("newrec");
const cases = [];
const shellVersions = {};
try {
  clearFaults();
  const { resolveTrustedWindowsSystemPaths, resolveTrustedWindowsSystemExecutable } = await import("../src/utils/windows-system-path.ts");
  const ps51 = resolveTrustedWindowsSystemExecutable(resolveTrustedWindowsSystemPaths(), [
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
  ]);
  const versionCommand = Buffer.from("[Console]::Out.Write($PSVersionTable.PSVersion.ToString())", "utf16le").toString("base64");
  for (const [shell, executable] of [["ps51", ps51], ["pwsh7", pwsh]]) {
    shellVersions[shell] = originalExec(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", versionCommand], {
      encoding: "utf8", timeout: 30_000, windowsHide: true,
    }).trim();
    assert.match(shellVersions[shell], shell === "ps51" ? /^5\.1\./ : /^7\./, `Unexpected ${shell} version.`);
  }
  const { withCronStorage } = await import("../src/utils/cron-storage.ts");
  const { readCronTasks } = await import("../src/utils/cronTasks.ts");
  const { readStartupCronTasks } = await import("../src/utils/cron-startup.ts");
  const write = (workspace, bytes) => withCronStorage(workspace, true, (storage) => storage.write(bytes));
  for (const shell of ["ps51", "pwsh7"]) {
    selectedShell = shell === "pwsh7" ? pwsh : ps51;
    for (const [stage, seedPrevious] of [
      ["after-rename", true], ["before-published-check", true],
      ["after-rename", false], ["before-published-check", false], ["before-rename", true],
    ]) {
      const fixture = join(root, `${shell}-${stage}-${seedPrevious ? "replace" : "first"}`);
      const workspace = join(fixture, "workspace");
      const canonical = join(workspace, ".agenc", "scheduled_tasks.json");
      const reached = join(fixture, "kill-reached.txt");
      const hook = join(fixture, "kill-publication.ps1");
      mkdirSync(workspace, { recursive: true });
      launches = [];
      const result = { shell, stage, seedPrevious, fixture, ok: false };
      try {
        clearFaults();
        if (seedPrevious) await write(workspace, previous);
        // The BOM lets Windows PowerShell 5.1 read Unicode fixture paths.
        writeFileSync(hook, "\uFEFF" + [
          "param($stage, $dir, $temp, $name)",
          "$ErrorActionPreference = 'Stop'",
          `[IO.File]::WriteAllText(${psLiteral(reached)}, ([string]$PID + ':' + $stage))`,
          "[Diagnostics.Process]::GetCurrentProcess().Kill()",
        ].join("\r\n"));
        process.env.AGENC_CRON_PUBLISH_FAULT = stage;
        process.env.AGENC_CRON_PUBLISH_HOOK = hook;
        let failure;
        try { await write(workspace, intended); } catch (error) { failure = error; }
        finally { clearFaults(); }
        assert.ok(failure instanceof Error, "A killed publication must reject acknowledgement.");
        result.message = failure.message;
        result.kill = readFileSync(reached, "utf8");
        assert.ok(result.kill.endsWith(`:${stage}`), "The actual child must reach the requested kill hook.");
        const bytes = readFileSync(canonical, "utf8");
        result.canonical = bytes;
        const postRename = stage !== "before-rename";
        assert.equal(bytes, postRename ? intended : previous);
        if (postRename) {
          assert.match(failure.message, /The new task file is in place, but the write was not acknowledged\./);
          assert.match(failure.message, /retrying an append can add the task twice/);
        } else {
          assert.match(failure.message, /The task file on disk does not match the requested new record\./);
        }
        assert.doesNotMatch(failure.message, /left unchanged|previous task file was left|could not be verified as private|Command:/);
        const expected = [postRename ? "newrec" : "previous"];
        result.readIds = (await readCronTasks(workspace)).map((task) => task.id);
        result.startupIds = (await readStartupCronTasks(workspace, () => {})).map((task) => task.id);
        assert.deepEqual(result.readIds, expected);
        assert.deepEqual(result.startupIds, expected);
        assert.equal(launches.length, seedPrevious ? 2 : 1, "Readback must not retry publication.");
        await write(workspace, record("next"));
        assert.equal(readFileSync(canonical, "utf8"), record("next"));
        result.ok = true;
      } catch (error) {
        result.error = error instanceof Error ? error.stack : String(error);
      } finally {
        clearFaults();
        result.launches = launches;
        cases.push(result);
        console.log(`${result.ok ? "PASS" : "FAIL"} ${shell} ${stage} previous=${seedPrevious}`);
      }
    }
  }
} finally {
  os.userInfo = originalUserInfo;
  cp.execFileSync = originalExec;
  syncBuiltinESMExports();
  faultKeys.forEach((key, index) => {
    if (originalFaults[index] === undefined) delete process.env[key];
    else process.env[key] = originalFaults[index];
  });
  const report = { node: process.version, platform: process.platform, shellVersions, root, passed: cases.filter((result) => result.ok).length, total: cases.length, cases };
  writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Evidence retained at ${root}; report: ${output}`);
}
assert.equal(cases.length, 10);
assert.ok(cases.every((result) => result.ok), "Native kill regressions failed; inspect the JSON report.");
