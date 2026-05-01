#!/usr/bin/env node
// Undo a `complete.mjs` for an item.
//
// Usage:
//   node scripts/goal/uncomplete.mjs <item-id>
//
// Steps:
//   1. Verify the marker `.goal-completed/<id>.json` exists; refuse otherwise.
//   2. Verify the merge commit recorded in the marker is the current HEAD
//      OR the most recent merge of branch port/<id>. Refuse if neither.
//   3. `git revert -m 1 <merge-commit>` (creates a new revert commit; does
//      NOT rewrite history).
//   4. Delete the marker file.
//   5. Flip the checklist row from [x] back to [ ].
//
// Strict invariants:
//   - Working tree must be clean before running.
//   - Must be on main when running.
//   - No remote ops; revert is local-only.
//   - Does not delete the original feature branch (it's already deleted by complete).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import process from "node:process";
import { findItem, repoRoot, markerPath, setItemStatus, STATUS, fail } from "./checklist-utils.mjs";

function usage() {
  process.stderr.write(`Usage: node scripts/goal/uncomplete.mjs <item-id>\n`);
  process.exit(2);
}

const id = process.argv[2];
if (!id) usage();

const root = repoRoot();
const { item } = await findItem(id);

const marker = markerPath(id);
if (!existsSync(marker)) fail(`no marker at ${marker}; nothing to undo`);

const markerData = JSON.parse(readFileSync(marker, "utf8"));
const recordedMerge = markerData.mergedHead;
if (!recordedMerge) fail(`marker missing mergedHead`);

function git(...argv) {
  return spawnSync("git", argv, { cwd: root, encoding: "utf8" });
}

function ok(msg) {
  process.stdout.write(`✓ ${msg}\n`);
}

const branchRes = git("rev-parse", "--abbrev-ref", "HEAD");
if (branchRes.stdout.trim() !== "main") fail(`must be on main; currently on ${branchRes.stdout.trim()}`);

const cleanRes = git("status", "--porcelain");
if (cleanRes.stdout.trim()) fail(`working tree dirty:\n${cleanRes.stdout}`);

const headRes = git("rev-parse", "HEAD");
const head = headRes.stdout.trim();

let revertTarget = recordedMerge;
if (head !== recordedMerge) {
  // Recorded merge is not the current HEAD. Search recent merges for a
  // merge commit whose first-parent message matches port/<id>.
  const logRes = git("log", "--merges", "--pretty=%H %s", "-50");
  const candidates = logRes.stdout
    .trim()
    .split("\n")
    .filter((l) => l.includes(`Merge branch 'port/${id}'`))
    .map((l) => l.split(" ")[0]);
  if (candidates.length === 0) {
    fail(`marker recorded merge ${recordedMerge.slice(0, 12)} but it is not HEAD and no recent merge matches port/${id}.`);
  }
  if (candidates[0] !== recordedMerge) {
    process.stderr.write(
      `! marker said merge was ${recordedMerge.slice(0, 12)} but most recent matching merge is ${candidates[0].slice(0, 12)}; reverting that.\n`,
    );
    revertTarget = candidates[0];
  }
  if (head !== revertTarget) {
    fail(
      `merge ${revertTarget.slice(0, 12)} is not the current HEAD; later commits exist on top of it. ` +
        `Reverting non-HEAD merges via this script can be lossy. Resolve manually.`,
    );
  }
}

process.stdout.write(`reverting merge ${revertTarget.slice(0, 12)} (port/${id})...\n`);
const revertRes = spawnSync("git", ["revert", "-m", "1", "--no-edit", revertTarget], {
  cwd: root,
  stdio: "inherit",
});
if (revertRes.status !== 0) fail(`git revert failed`);
ok("revert commit created");

unlinkSync(marker);
ok(`marker deleted: .goal-completed/${id}.json`);

await setItemStatus(id, STATUS.OPEN);
ok(`PORT_CHECKLIST.md row flipped back to [ ]`);

process.stdout.write(`\n✓ ${id} uncompleted. Item is open again.\n`);
