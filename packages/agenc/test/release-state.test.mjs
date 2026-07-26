import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import {
  acquireReleaseLock,
  checkpointSequence,
  compactCompletedLogs,
  passedGateCanResume,
  releasePlanDigest,
  verificationPlan,
} from "../../../scripts/release-state.mjs";

test("an exact release state rejects concurrent expensive operations", () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-release-lock-test-"));
  const directory = join(root, "exact-sha");
  const paths = {
    directory,
    lock: join(directory, "operation.lock"),
  };
  const release = acquireReleaseLock(paths, "verify");
  try {
    assert.throws(
      () => acquireReleaseLock(paths, "verify"),
      /release state is already locked for verify by pid/u,
    );
  } finally {
    release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("full release verification runs each expensive gate once for an exact SHA", () => {
  const plan = verificationPlan("full");
  const ids = plan.map(({ id }) => id);
  assert.deepEqual(ids, [
    "release-preflight",
    "installer-lock-sync",
    "typecheck",
    "full-tests",
    "runtime-build",
    "runtime-startup",
    "clean-build",
  ]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.filter((id) => id === "clean-build").length, 1);
  assert.match(
    plan.find(({ id }) => id === "clean-build").argv.join(" "),
    /--buildkit-network=host/u,
  );
  assert.match(releasePlanDigest(plan), /^[0-9a-f]{64}$/u);
});

test("completed release logs compact without losing their original digests", async () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-release-compact-test-"));
  const logs = join(root, "logs");
  const statePath = join(root, "state.json");
  const logPath = join(logs, "full-tests.log");
  try {
    const bytes = Buffer.from("a long but verified gate log\n", "utf8");
    mkdirSync(logs, { mode: 0o700 });
    writeFileSync(logPath, bytes, { mode: 0o600 });
    const logSha256 = createHash("sha256").update(bytes).digest("hex");
    const state = {
      verification: {
        gates: [
          {
            id: "full-tests",
            result: "pass",
            logPath,
            logSha256,
          },
        ],
      },
      checkpoints: { converged: { receipt: { version: "1.2.3" } } },
    };
    await compactCompletedLogs(state, { state: statePath });
    assert.equal(existsSync(logPath), false);
    assert.equal(existsSync(`${logPath}.gz`), true);
    assert.deepEqual(gunzipSync(readFileSync(`${logPath}.gz`)), bytes);
    assert.equal(state.retention.logs[0].originalSha256, logSha256);
    assert.match(state.retention.logs[0].archiveSha256, /^[0-9a-f]{64}$/u);
    assert.match(state.retention.plaintextRemovedAt, /^\d{4}-\d{2}-\d{2}T/u);

    // Model interruption after the archive receipt was committed but before
    // plaintext cleanup completed. A retry verifies both copies, removes the
    // plaintext, and completes the same retention record.
    writeFileSync(logPath, bytes, { mode: 0o600 });
    state.retention.plaintextRemovedAt = null;
    await compactCompletedLogs(state, { state: statePath });
    assert.equal(existsSync(logPath), false);
    assert.match(state.retention.plaintextRemovedAt, /^\d{4}-\d{2}-\d{2}T/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installer hotfix verification is targeted and excludes runtime release gates", () => {
  const plan = verificationPlan("installer-hotfix");
  const ids = plan.map(({ id }) => id);
  assert.deepEqual(ids, [
    "installer-lock-sync",
    "installer-shell-syntax",
    "installer-runtime-tests",
    "installer-launcher-tests",
  ]);
  assert.doesNotMatch(ids.join(" "), /clean-build|release-preflight|full-tests/u);
  assert.match(
    plan.find(({ id }) => id === "installer-runtime-tests").argv.join(" "),
    /tests\/packaging\/install-sh\.test\.ts/u,
  );
  assert.deepEqual(checkpointSequence("installer-hotfix"), [
    "installer-promoted",
    "converged",
  ]);
});

test("a passing gate resumes only while its retained log matches the recorded digest", async () => {
  const root = mkdtempSync(join(tmpdir(), "agenc-release-state-test-"));
  const logPath = join(root, "gate.log");
  try {
    writeFileSync(logPath, "verified\n", { mode: 0o600 });
    chmodSync(logPath, 0o600);
    const logSha256 = createHash("sha256").update("verified\n").digest("hex");
    const record = { result: "pass", logPath, logSha256 };
    assert.equal(await passedGateCanResume(record), true);
    writeFileSync(logPath, "tampered\n", { mode: 0o600 });
    assert.equal(await passedGateCanResume(record), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
