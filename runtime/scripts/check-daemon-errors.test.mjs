import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runDaemonErrorGate } from "./check-daemon-errors/runner.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FAKE_DAEMON = path.join(
  SCRIPT_DIR,
  "check-daemon-errors",
  "fake-daemon.mjs",
);

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

test("daemon error gate isolates and cleans successful and failed runs", {
  skip: process.platform === "win32" ? "Unix socket gate" : false,
}, async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "agenc-daemon-gate-test-"));
  const operatorHome = path.join(fixtureRoot, "operator-home");
  const operatorAgencHome = path.join(fixtureRoot, "operator-state");
  const homeMarker = path.join(operatorHome, "marker");
  const stateMarker = path.join(operatorAgencHome, "marker");
  mkdirSync(operatorHome, { recursive: true, mode: 0o700 });
  mkdirSync(operatorAgencHome, { recursive: true, mode: 0o700 });
  writeFileSync(homeMarker, "home-before\n", { mode: 0o600 });
  writeFileSync(stateMarker, "state-before\n", { mode: 0o600 });

  const baseEnv = {
    ...process.env,
    HOME: operatorHome,
    AGENC_HOME: operatorAgencHome,
  };
  const recordPaths = [
    path.join(fixtureRoot, "successful-run.json"),
    path.join(fixtureRoot, "failed-run.json"),
  ];
  const recordedPids = new Set();

  try {
    for (const [index, forceFailure] of [false, true].entries()) {
      const recordPath = recordPaths[index];
      const run = runDaemonErrorGate({
        binAgenc: FAKE_DAEMON,
        baseEnv,
        injectedEnv: {
          AGENC_DAEMON_ERROR_GATE_RECORD: recordPath,
          ...(forceFailure
            ? { AGENC_DAEMON_ERROR_GATE_FORCE_FAILURE: "1" }
            : {}),
        },
      });

      if (!forceFailure) {
        await assert.rejects(
          runDaemonErrorGate({
            binAgenc: FAKE_DAEMON,
            baseEnv,
            injectedEnv: {
              AGENC_DAEMON_ERROR_GATE_RECORD: path.join(
                fixtureRoot,
                "racing-run.json",
              ),
            },
          }),
          /already running/u,
        );
      }

      if (forceFailure) {
        await assert.rejects(run, /daemon protocol-error scenarios failed/u);
      } else {
        await run;
      }

      const record = JSON.parse(readFileSync(recordPath, "utf8"));
      recordedPids.add(record.pid);
      assert.notEqual(record.home, operatorHome);
      assert.notEqual(record.agencHome, operatorAgencHome);
      assert.equal(record.agencHome, path.join(record.home, ".agenc"));
      assert.equal(existsSync(record.home), false);
      assert.equal(pidIsAlive(record.pid), false);
      assert.equal(readFileSync(homeMarker, "utf8"), "home-before\n");
      assert.equal(readFileSync(stateMarker, "utf8"), "state-before\n");
      assert.deepEqual(readdirSync(operatorHome), ["marker"]);
      assert.deepEqual(readdirSync(operatorAgencHome), ["marker"]);
    }
  } finally {
    for (const recordPath of recordPaths) {
      if (!existsSync(recordPath)) continue;
      const record = JSON.parse(readFileSync(recordPath, "utf8"));
      recordedPids.add(record.pid);
    }
    for (const pid of recordedPids) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || !pidIsAlive(pid)) continue;
      process.kill(pid, "SIGKILL");
    }
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
