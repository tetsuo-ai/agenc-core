import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

test("standalone installers embed the exact canonical async lock modules", () => {
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

  for (const relativePath of [
    "scripts/install/install.sh",
    "scripts/install/install.ps1",
  ]) {
    const installer = readFileSync(join(repoRoot, relativePath), "utf8");
    const sqlitePayload = installer.match(
      /const AGENC_SQLITE_LOCK_SOURCE_BASE64 = ("[A-Za-z0-9+/=]+");/u,
    );
    const identityPayload = installer.match(
      /const AGENC_ACTIVATION_LOCK_IDENTITY_SOURCE_BASE64 = ("[A-Za-z0-9+/=]+");/u,
    );
    const wrapperPayload = installer.match(
      /const AGENC_GENERATED_WRAPPER_SOURCE_BASE64 = ("[A-Za-z0-9+/=]+");/u,
    );
    assert.ok(sqlitePayload, `${relativePath} has a generated SQLite payload`);
    assert.ok(identityPayload, `${relativePath} has a generated identity payload`);
    assert.ok(wrapperPayload, `${relativePath} has a generated wrapper payload`);
    assert.equal(JSON.parse(sqlitePayload[1]), expectedSqlitePayload, relativePath);
    assert.equal(JSON.parse(identityPayload[1]), expectedIdentityPayload, relativePath);
    assert.equal(JSON.parse(wrapperPayload[1]), expectedWrapperPayload, relativePath);
    assert.equal(
      installer.match(/BEGIN GENERATED AGENC SQLITE LOCK MODULE/gu)?.length,
      1,
      relativePath,
    );
    assert.equal(
      installer.match(/END GENERATED AGENC SQLITE LOCK MODULE/gu)?.length,
      1,
      relativePath,
    );
    assert.equal(
      installer.match(/BEGIN GENERATED AGENC ACTIVATION LOCK IDENTITY MODULE/gu)?.length,
      1,
      relativePath,
    );
    assert.equal(
      installer.match(/END GENERATED AGENC ACTIVATION LOCK IDENTITY MODULE/gu)?.length,
      1,
      relativePath,
    );
    assert.equal(
      installer.match(/BEGIN GENERATED AGENC WRAPPER CONTRACT MODULE/gu)?.length,
      1,
      relativePath,
    );
    assert.equal(
      installer.match(/END GENERATED AGENC WRAPPER CONTRACT MODULE/gu)?.length,
      1,
      relativePath,
    );
    assert.equal(installer.includes("function acquireLocks(requestedPaths"), false);
    assert.equal(installer.includes("PRAGMA busy_timeout = ${Math.min"), false);
    assert.equal(installer.includes("function windowsAccountLockRegistry"), false);
    assert.equal(installer.includes("function activationLockRegistry"), false);
    assert.equal(installer.includes('toLocaleLowerCase("en-US")'), false);
    assert.equal(installer.includes("spawnSync(\n    powershell"), false);
    assert.match(installer, /await Promise\.all\(\[\s*loadSqliteLockModule\(\),\s*loadActivationLockIdentityModule\(\),\s*loadGeneratedWrapperModule\(\),/u);
    assert.match(installer, /parseGeneratedWrapperContent/u);
    assert.match(installer, /renderGeneratedWrapperContent/u);
    assert.match(installer, /resolveActivationLockRegistry\(\)/u);
    assert.match(installer, /await acquireLocalSqliteLock\(/u);
    assert.match(installer, /await acquireLocalSqliteLocks\(/u);
  }
});
