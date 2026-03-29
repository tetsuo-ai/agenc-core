import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWatchSessionQueryCandidates,
  clearWatchSessionLabel,
  createWatchSessionLabelMap,
  normalizeWatchSessionLabel,
  resolveWatchSessionLabel,
  serializeWatchSessionLabels,
  setWatchSessionLabel,
} from "../../src/watch/agenc-watch-session-indexing.mjs";

test("normalizeWatchSessionLabel collapses whitespace and blanks to null", () => {
  assert.equal(normalizeWatchSessionLabel("  release   branch  "), "release branch");
  assert.equal(normalizeWatchSessionLabel("   "), null);
});

test("session label helpers normalize, persist, and clear labels", () => {
  const labels = createWatchSessionLabelMap({
    "session:abc123": " Alpha Session ",
  });

  assert.equal(resolveWatchSessionLabel("abc123", labels), "Alpha Session");
  assert.deepEqual(serializeWatchSessionLabels(labels), {
    abc123: "Alpha Session",
  });

  const updated = setWatchSessionLabel(labels, "session:def456", " Beta Session ");
  assert.equal(updated.label, "Beta Session");
  assert.equal(resolveWatchSessionLabel("def456", labels), "Beta Session");

  const cleared = clearWatchSessionLabel(labels, "def456");
  assert.equal(cleared, "Beta Session");
  assert.equal(resolveWatchSessionLabel("def456", labels), null);
});

test("buildWatchSessionQueryCandidates includes local labels", () => {
  const labels = createWatchSessionLabelMap({
    "session:ghi789": "Release branch",
  });

  const candidates = buildWatchSessionQueryCandidates(
    {
      sessionId: "session:ghi789",
      label: "Backend fix",
      workspaceRoot: "/tmp/agenc-core",
      model: "grok-4.20",
    },
    {
      sessionLabels: labels,
    },
  );

  assert.equal(candidates.includes("release branch"), true);
  assert.equal(candidates.includes("backend fix"), true);
  assert.equal(candidates.includes("/tmp/agenc-core"), true);
});
