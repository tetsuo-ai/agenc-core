import test from "node:test";
import assert from "node:assert/strict";

import { runAgencWatchCli } from "../../../scripts/agenc-watch.mjs";

function createProcessHarness() {
  const exits = [];
  const writes = [];
  const env = {};
  return {
    exits,
    writes,
    env,
    processLike: {
      env,
      stderr: {
        write: (value) => {
          writes.push(String(value ?? ""));
        },
      },
      exit: (code) => {
        exits.push(code);
      },
    },
  };
}

test("runAgencWatchCli exits with the app exit code on success", async () => {
  const harness = createProcessHarness();

  await runAgencWatchCli({
    runWatchApp: async () => 7,
    processLike: harness.processLike,
  });

  assert.deepEqual(harness.exits, [7]);
  assert.deepEqual(harness.writes, []);
  assert.equal(harness.env.AGENC_WATCH_ENABLE_ATTACHMENTS, "true");
  assert.equal(harness.env.AGENC_WATCH_ENABLE_REMOTE_TOOLS, "true");
});

test("runAgencWatchCli writes errors and exits non-zero on failure", async () => {
  const harness = createProcessHarness();

  await runAgencWatchCli({
    runWatchApp: async () => {
      throw new Error("boom");
    },
    processLike: harness.processLike,
  });

  assert.deepEqual(harness.exits, [1]);
  assert.equal(harness.writes.length, 1);
  assert.match(harness.writes[0], /boom/);
  assert.equal(harness.env.AGENC_WATCH_ENABLE_ATTACHMENTS, "true");
  assert.equal(harness.env.AGENC_WATCH_ENABLE_REMOTE_TOOLS, "true");
});

test("runAgencWatchCli preserves explicit attachment and remote-tool overrides", async () => {
  const harness = createProcessHarness();
  harness.env.AGENC_WATCH_ENABLE_ATTACHMENTS = "false";
  harness.env.AGENC_WATCH_ENABLE_REMOTE_TOOLS = "false";

  await runAgencWatchCli({
    runWatchApp: async () => 0,
    processLike: harness.processLike,
  });

  assert.deepEqual(harness.exits, [0]);
  assert.equal(harness.env.AGENC_WATCH_ENABLE_ATTACHMENTS, "false");
  assert.equal(harness.env.AGENC_WATCH_ENABLE_REMOTE_TOOLS, "false");
});
