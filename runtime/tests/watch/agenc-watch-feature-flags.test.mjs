import test from "node:test";
import assert from "node:assert/strict";

import { resolveWatchFeatureFlags } from "../../src/watch/agenc-watch-feature-flags.mjs";

test("resolveWatchFeatureFlags enables the statusline from the long token", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "watch.statusline",
    },
  });

  assert.equal(flags.statusline, true);
});

test("resolveWatchFeatureFlags enables the statusline from the short token", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "statusline",
    },
  });

  assert.equal(flags.statusline, true);
});

test("resolveWatchFeatureFlags honors the explicit statusline override", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "watch.statusline",
      AGENC_WATCH_ENABLE_STATUSLINE: "false",
    },
  });

  assert.equal(flags.statusline, false);
});

test("resolveWatchFeatureFlags enables review modes from feature lists", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "review-modes",
    },
  });

  assert.equal(flags.reviewModes, true);
});

test("resolveWatchFeatureFlags honors the explicit review mode override", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "watch.review_modes",
      AGENC_WATCH_ENABLE_REVIEW_MODES: "false",
    },
  });

  assert.equal(flags.reviewModes, false);
});

test("resolveWatchFeatureFlags enables checkpoints from feature lists", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "watch.checkpoints",
    },
  });

  assert.equal(flags.checkpoints, true);
});

test("resolveWatchFeatureFlags honors the explicit checkpoints override", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "checkpoints",
      AGENC_WATCH_ENABLE_CHECKPOINTS: "off",
    },
  });

  assert.equal(flags.checkpoints, false);
});

test("resolveWatchFeatureFlags enables diff review from feature lists", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "diff-review",
    },
  });

  assert.equal(flags.diffReview, true);
});

test("resolveWatchFeatureFlags honors the explicit diff review override", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "watch.diff_review",
      AGENC_WATCH_ENABLE_DIFF_REVIEW: "no",
    },
  });

  assert.equal(flags.diffReview, false);
});

test("resolveWatchFeatureFlags enables compaction controls from feature lists", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "compaction-controls",
    },
  });

  assert.equal(flags.compactionControls, true);
});

test("resolveWatchFeatureFlags honors the explicit compaction controls override", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "watch.compaction_controls",
      AGENC_WATCH_ENABLE_COMPACTION_CONTROLS: "false",
    },
  });

  assert.equal(flags.compactionControls, false);
});

test("resolveWatchFeatureFlags enables permissions controls from feature lists", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "permissions-controls",
    },
  });

  assert.equal(flags.permissionsControls, true);
});

test("resolveWatchFeatureFlags honors the explicit permissions controls override", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "watch.permissions_controls",
      AGENC_WATCH_ENABLE_PERMISSIONS_CONTROLS: "false",
    },
  });

  assert.equal(flags.permissionsControls, false);
});

test("resolveWatchFeatureFlags enables attachments from feature lists", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "attachments",
    },
  });

  assert.equal(flags.attachments, true);
});

test("resolveWatchFeatureFlags honors the explicit attachments override", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "watch.attachments",
      AGENC_WATCH_ENABLE_ATTACHMENTS: "false",
    },
  });

  assert.equal(flags.attachments, false);
});

test("resolveWatchFeatureFlags enables export bundles from feature lists", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "export-bundles",
    },
  });

  assert.equal(flags.exportBundles, true);
});

test("resolveWatchFeatureFlags honors the explicit export bundles override", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "watch.export_bundles",
      AGENC_WATCH_ENABLE_EXPORT_BUNDLES: "false",
    },
  });

  assert.equal(flags.exportBundles, false);
});

test("resolveWatchFeatureFlags enables insights from feature lists", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "insights",
    },
  });

  assert.equal(flags.insights, true);
});

test("resolveWatchFeatureFlags honors the explicit insights override", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "watch.insights",
      AGENC_WATCH_ENABLE_INSIGHTS: "false",
    },
  });

  assert.equal(flags.insights, false);
});

test("resolveWatchFeatureFlags enables thread switcher from feature lists", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "thread-switcher",
    },
  });

  assert.equal(flags.threadSwitcher, true);
});

test("resolveWatchFeatureFlags honors the explicit thread switcher override", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "watch.thread_switcher",
      AGENC_WATCH_ENABLE_THREAD_SWITCHER: "false",
    },
  });

  assert.equal(flags.threadSwitcher, false);
});

test("resolveWatchFeatureFlags enables extensibility hub from feature lists", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "watch.extensibility_hub",
    },
  });

  assert.equal(flags.extensibilityHub, true);
});

test("resolveWatchFeatureFlags honors the explicit extensibility hub override", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "extensibility-hub",
      AGENC_WATCH_ENABLE_EXTENSIBILITY_HUB: "false",
    },
  });

  assert.equal(flags.extensibilityHub, false);
});

test("resolveWatchFeatureFlags enables input modes by default", () => {
  const flags = resolveWatchFeatureFlags({
    env: {},
  });

  assert.equal(flags.inputModes, true);
});

test("resolveWatchFeatureFlags honors disabled input modes feature tokens", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_DISABLE_FEATURES: "watch.input_modes",
    },
  });

  assert.equal(flags.inputModes, false);
});

test("resolveWatchFeatureFlags honors the explicit input modes override", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_ENABLE_INPUT_MODES: "off",
    },
  });

  assert.equal(flags.inputModes, false);
});

test("resolveWatchFeatureFlags enables session indexing from feature lists", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "session-indexing",
    },
  });

  assert.equal(flags.sessionIndexing, true);
});

test("resolveWatchFeatureFlags honors the explicit session indexing override", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "watch.session_indexing",
      AGENC_WATCH_ENABLE_SESSION_INDEXING: "false",
    },
  });

  assert.equal(flags.sessionIndexing, false);
});

test("resolveWatchFeatureFlags enables rerun-from-trace controls from feature lists", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "rerun-from-trace",
    },
  });

  assert.equal(flags.rerunFromTrace, true);
});

test("resolveWatchFeatureFlags honors the explicit rerun-from-trace override", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "watch.rerun_from_trace",
      AGENC_WATCH_ENABLE_RERUN_FROM_TRACE: "false",
    },
  });

  assert.equal(flags.rerunFromTrace, false);
});

test("resolveWatchFeatureFlags enables remote tools from feature lists", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "remote-tools",
    },
  });

  assert.equal(flags.remoteTools, true);
});

test("resolveWatchFeatureFlags honors the explicit remote tools override", () => {
  const flags = resolveWatchFeatureFlags({
    env: {
      AGENC_WATCH_FEATURES: "watch.remote_tools",
      AGENC_WATCH_ENABLE_REMOTE_TOOLS: "false",
    },
  });

  assert.equal(flags.remoteTools, false);
});
