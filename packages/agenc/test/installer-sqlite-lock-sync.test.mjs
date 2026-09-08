import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const canonicalInstallerRelativePath = "scripts/install/runtime-installer.cjs";
const syncScriptRelativePath = "scripts/sync-installer-sqlite-lock.mjs";
const installerRelativePaths = [
  "scripts/install/install.sh",
  "scripts/install/install.ps1",
];
const fixtureRelativePaths = [
  syncScriptRelativePath,
  canonicalInstallerRelativePath,
  ...installerRelativePaths,
  "packages/agenc/lib/sqlite-lock.mjs",
  "packages/agenc/lib/activation-lock-identity.mjs",
  "packages/agenc/lib/generated-wrapper.mjs",
];
const installerStartMarker =
  "// BEGIN GENERATED AGENC RUNTIME INSTALLER PROGRAM";
const installerEndMarker = "// END GENERATED AGENC RUNTIME INSTALLER PROGRAM";

function generatedInstallerProgram(installer, relativePath) {
  assert.equal(
    installer.match(/BEGIN GENERATED AGENC RUNTIME INSTALLER PROGRAM/gu)?.length,
    1,
    `${relativePath} has one generated program start marker`,
  );
  assert.equal(
    installer.match(/END GENERATED AGENC RUNTIME INSTALLER PROGRAM/gu)?.length,
    1,
    `${relativePath} has one generated program end marker`,
  );
  const start = installer.indexOf(installerStartMarker) + installerStartMarker.length + 1;
  const end = installer.indexOf(installerEndMarker);
  assert.ok(start > installerStartMarker.length, `${relativePath} has a program body`);
  assert.ok(end > start, `${relativePath} has a complete program body`);
  return installer.slice(start, end);
}

function replaceExactlyOnce(input, search, replacement) {
  assert.equal(input.split(search).length, 2, `expected one occurrence of ${search}`);
  return input.replace(search, replacement);
}

function copySyncFixture(targetRoot) {
  for (const relativePath of fixtureRelativePaths) {
    const target = join(targetRoot, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repoRoot, relativePath), target);
  }
}

function runSync(targetRoot, args) {
  return spawnSync(
    process.execPath,
    [join(targetRoot, syncScriptRelativePath), ...args],
    { cwd: targetRoot, encoding: "utf8" },
  );
}

test("canonical installer uses explicit ASCII ordering for exact keys", () => {
  const canonicalInstaller = readFileSync(
    join(repoRoot, canonicalInstallerRelativePath),
    "utf8",
  );
  assert.match(
    canonicalInstaller,
    /function compareAsciiKeys\(left, right\) \{\n  if \(left < right\) return -1;\n  if \(left > right\) return 1;\n  return 0;\n\}/u,
  );
  assert.equal(
    canonicalInstaller.match(/\.sort\(compareAsciiKeys\)/gu)?.length,
    2,
  );
  assert.equal(canonicalInstaller.match(/\.sort\(\)/gu), null);
  assert.deepEqual(
    ["z", "a", "Z", "A", "9", "0"].sort((left, right) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    }),
    ["0", "9", "A", "Z", "a", "z"],
  );
});

test("Sonar excludes only canonical installer and generated contract copies", () => {
  assert.equal(
    readFileSync(join(repoRoot, ".sonarcloud.properties"), "utf8"),
    "# The generated public contracts are checked against their canonical sources.\n" +
      "sonar.cpd.exclusions=scripts/install/runtime-installer.cjs,packages/agenc-sdk/src/protocol-wire.generated.ts,packages/agenc-sdk/src/turn-terminal.generated.ts\n",
  );
  assert.equal(
    readFileSync(join(repoRoot, "packages/agenc-sdk/src/turn-terminal.generated.ts"), "utf8"),
    readFileSync(join(repoRoot, "runtime/src/contracts/turn-terminal.ts"), "utf8"),
  );
});

test("standalone installers embed the exact canonical runtime program", () => {
  const canonicalInstaller = readFileSync(
    join(repoRoot, canonicalInstallerRelativePath),
    "utf8",
  );
  assert.equal(canonicalInstaller.includes("\r"), false);
  assert.equal(canonicalInstaller.endsWith("\n"), true);

  const canonicalSqlite = readFileSync(
    join(repoRoot, "packages/agenc/lib/sqlite-lock.mjs"),
    "utf8",
  );
  const canonicalIdentity = readFileSync(
    join(repoRoot, "packages/agenc/lib/activation-lock-identity.mjs"),
    "utf8",
  );
  const canonicalWrapper = readFileSync(
    join(repoRoot, "packages/agenc/lib/generated-wrapper.mjs"),
    "utf8",
  );
  const expectedSqlitePayload = Buffer.from(canonicalSqlite, "utf8").toString("base64");
  const expectedIdentityPayload = Buffer.from(canonicalIdentity, "utf8").toString("base64");
  const expectedWrapperPayload = Buffer.from(canonicalWrapper, "utf8").toString("base64");
  assert.equal(canonicalIdentity.includes(".toUpperCase()"), false);
  assert.match(canonicalIdentity, /return `\$\{stat\.dev\}:\$\{stat\.ino\}`/u);

  for (const relativePath of installerRelativePaths) {
    const installer = readFileSync(join(repoRoot, relativePath), "utf8");
    assert.equal(installer.includes("\r"), false, relativePath);
    const program = generatedInstallerProgram(installer, relativePath);
    assert.equal(program, canonicalInstaller, relativePath);
    const sqlitePayload = program.match(
      /const AGENC_SQLITE_LOCK_SOURCE_BASE64 = ("[A-Za-z0-9+/=]+");/u,
    );
    const identityPayload = program.match(
      /const AGENC_ACTIVATION_LOCK_IDENTITY_SOURCE_BASE64 = ("[A-Za-z0-9+/=]+");/u,
    );
    const wrapperPayload = program.match(
      /const AGENC_GENERATED_WRAPPER_SOURCE_BASE64 = ("[A-Za-z0-9+/=]+");/u,
    );
    assert.ok(sqlitePayload, `${relativePath} has a generated SQLite payload`);
    assert.ok(identityPayload, `${relativePath} has a generated identity payload`);
    assert.ok(wrapperPayload, `${relativePath} has a generated wrapper payload`);
    assert.equal(JSON.parse(sqlitePayload[1]), expectedSqlitePayload, relativePath);
    assert.equal(JSON.parse(identityPayload[1]), expectedIdentityPayload, relativePath);
    assert.equal(JSON.parse(wrapperPayload[1]), expectedWrapperPayload, relativePath);
    assert.equal(
      program.match(/BEGIN GENERATED AGENC SQLITE LOCK MODULE/gu)?.length,
      1,
      relativePath,
    );
    assert.equal(
      program.match(/END GENERATED AGENC SQLITE LOCK MODULE/gu)?.length,
      1,
      relativePath,
    );
    assert.equal(
      program.match(/BEGIN GENERATED AGENC ACTIVATION LOCK IDENTITY MODULE/gu)?.length,
      1,
      relativePath,
    );
    assert.equal(
      program.match(/END GENERATED AGENC ACTIVATION LOCK IDENTITY MODULE/gu)?.length,
      1,
      relativePath,
    );
    assert.equal(
      program.match(/BEGIN GENERATED AGENC WRAPPER CONTRACT MODULE/gu)?.length,
      1,
      relativePath,
    );
    assert.equal(
      program.match(/END GENERATED AGENC WRAPPER CONTRACT MODULE/gu)?.length,
      1,
      relativePath,
    );
    assert.equal(program.includes("function acquireLocks(requestedPaths"), false);
    assert.equal(program.includes("PRAGMA busy_timeout = ${Math.min"), false);
    assert.equal(program.includes("function windowsAccountLockRegistry"), false);
    assert.equal(program.includes("function activationLockRegistry"), false);
    assert.equal(program.includes('toLocaleLowerCase("en-US")'), false);
    assert.equal(program.includes("spawnSync(\n    powershell"), false);
    assert.match(program, /await Promise\.all\(\[\s*loadSqliteLockModule\(\),\s*loadActivationLockIdentityModule\(\),\s*loadGeneratedWrapperModule\(\),/u);
    assert.match(program, /parseGeneratedWrapperContent/u);
    assert.match(program, /renderGeneratedWrapperContent/u);
    assert.match(program, /resolveActivationLockRegistry\(\)/u);
    assert.match(program, /await acquireLocalSqliteLock\(/u);
    assert.match(program, /await acquireLocalSqliteLocks\(/u);
  }
});

test("check modes are read-only and write mode repairs complete wrapper drift", (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "agenc-installer-sync-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  copySyncFixture(fixtureRoot);

  const installerPaths = installerRelativePaths.map((relativePath) =>
    join(fixtureRoot, relativePath),
  );
  const originals = installerPaths.map((path) => readFileSync(path, "utf8"));
  const drifted = [
    `\uFEFF${replaceExactlyOnce(
      originals[0],
      "const BLOCK_SIZE = 512;",
      "const BLOCK_SIZE = 513;",
    ).replaceAll("\n", "\r\n")}`,
    replaceExactlyOnce(
      originals[1],
      "const MAX_ENTRIES = 200_000;",
      "const MAX_ENTRIES = 200_001;",
    ),
  ];
  for (let index = 0; index < installerPaths.length; index += 1) {
    writeFileSync(installerPaths[index], drifted[index], "utf8");
  }

  for (const args of [[], ["--check"]]) {
    const result = runSync(fixtureRoot, args);
    assert.equal(result.status, 1, `${args.join(" ") || "default"} detects drift`);
    assert.match(result.stderr, /install\.sh/u);
    assert.match(result.stderr, /install\.ps1/u);
    for (let index = 0; index < installerPaths.length; index += 1) {
      assert.equal(readFileSync(installerPaths[index], "utf8"), drifted[index]);
    }
  }

  const writeResult = runSync(fixtureRoot, ["--write"]);
  assert.equal(writeResult.status, 0, writeResult.stderr);
  for (let index = 0; index < installerPaths.length; index += 1) {
    assert.equal(readFileSync(installerPaths[index], "utf8"), originals[index]);
  }

  const idempotentResult = runSync(fixtureRoot, ["--write"]);
  assert.equal(idempotentResult.status, 0, idempotentResult.stderr);
  for (let index = 0; index < installerPaths.length; index += 1) {
    assert.equal(readFileSync(installerPaths[index], "utf8"), originals[index]);
  }
});

test("write mode propagates canonical program edits without changing them", (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "agenc-installer-source-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  copySyncFixture(fixtureRoot);

  const canonicalPath = join(fixtureRoot, canonicalInstallerRelativePath);
  const changedCanonical = replaceExactlyOnce(
    readFileSync(canonicalPath, "utf8"),
    "const BLOCK_SIZE = 512;",
    "const BLOCK_SIZE = 1024;",
  );
  writeFileSync(canonicalPath, changedCanonical, "utf8");
  const originalWrappers = installerRelativePaths.map((relativePath) =>
    readFileSync(join(fixtureRoot, relativePath), "utf8"),
  );

  const checkResult = runSync(fixtureRoot, []);
  assert.equal(checkResult.status, 1);
  assert.match(checkResult.stderr, /install\.sh/u);
  assert.match(checkResult.stderr, /install\.ps1/u);
  assert.equal(readFileSync(canonicalPath, "utf8"), changedCanonical);
  for (let index = 0; index < installerRelativePaths.length; index += 1) {
    assert.equal(
      readFileSync(join(fixtureRoot, installerRelativePaths[index]), "utf8"),
      originalWrappers[index],
    );
  }

  const writeResult = runSync(fixtureRoot, ["--write"]);
  assert.equal(writeResult.status, 0, writeResult.stderr);
  assert.equal(readFileSync(canonicalPath, "utf8"), changedCanonical);
  for (const relativePath of installerRelativePaths) {
    const installer = readFileSync(join(fixtureRoot, relativePath), "utf8");
    assert.equal(generatedInstallerProgram(installer, relativePath), changedCanonical);
    assert.equal(installer.includes("\r"), false);
  }
  const finalCheck = runSync(fixtureRoot, ["--check"]);
  assert.equal(finalCheck.status, 0, finalCheck.stderr);
});

test("generated programs from both wrappers parse and execute their mode guard", (t) => {
  const work = mkdtempSync(join(tmpdir(), "agenc-installer-program-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));

  for (const relativePath of installerRelativePaths) {
    const program = generatedInstallerProgram(
      readFileSync(join(repoRoot, relativePath), "utf8"),
      relativePath,
    );
    const programPath = join(work, `${basename(relativePath)}.cjs`);
    writeFileSync(programPath, program, "utf8");
    const syntax = spawnSync(process.execPath, ["--check", programPath], {
      encoding: "utf8",
    });
    assert.equal(syntax.status, 0, syntax.stderr);
    const execution = spawnSync(process.execPath, [programPath, "invalid-mode"], {
      encoding: "utf8",
    });
    assert.equal(execution.status, 1);
    assert.match(execution.stderr, /invalid runtime installer mode: invalid-mode/u);
  }
});

test("install.sh passes the platform shell syntax check when sh is available", (t) => {
  const result = spawnSync("sh", ["-n", join(repoRoot, "scripts/install/install.sh")], {
    encoding: "utf8",
  });
  if (result.error?.code === "ENOENT") {
    t.skip("sh is unavailable on this host");
    return;
  }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test("install.ps1 passes the PowerShell parser when pwsh is available", (t) => {
  const installerPath = join(repoRoot, "scripts/install/install.ps1");
  const escapedPath = installerPath.replaceAll("'", "''");
  const result = spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `$null = [scriptblock]::Create((Get-Content -Raw -LiteralPath '${escapedPath}')); 'parsed'`,
    ],
    { encoding: "utf8" },
  );
  if (result.error?.code === "ENOENT") {
    t.skip("pwsh is unavailable on this host");
    return;
  }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /parsed/u);
});
