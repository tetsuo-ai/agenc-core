#!/usr/bin/env node
/**
 * Executor refactor baseline gate.
 *
 * Runs on every PR in the `refactor/exec-*` series to prove no PR
 * silently erodes the test baseline or leaks AI attribution into
 * commit messages. Must finish in under 5 seconds.
 *
 * Checks:
 *   1. Test file count under `runtime/src/**\/*.test.ts` +
 *      `runtime/tests/**\/*.test.ts` is >= MIN_TEST_FILES.
 *   2. Total `it(` / `test(` block count across those files is
 *      >= MIN_IT_BLOCKS.
 *   3. The last commit message does NOT contain any of the AI-
 *      attribution banned substrings. The rule is strict: zero
 *      attribution tokens in any commit landed on any branch in
 *      this refactor.
 *
 * The two numeric floors are locked to the state at the start of
 * the refactor. They can only be raised, never lowered. If a PR
 * needs to legitimately reduce the count (e.g. Phase F replaces
 * chat-executor.test.ts with execute-chat.test.ts), the two PRs
 * must net-zero and the new file must contain enough tests to
 * hold the floor.
 */

import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const runtimeRoot = resolve(__dirname, "..");
const repoRoot = resolve(runtimeRoot, "..");

// Floors for the executor test coverage. Adjust ONLY when a PR
// legitimately deletes test files for deleted dead code.
//
// 2026-04-07 U0:   357 test files / 5976 it() blocks (initial baseline)
// 2026-04-07 U9-L: 358 test files / 5949 it() blocks
//                  (deleted runtime/src/bridges/ + runtime/src/proof/
//                  as dead code with zero external consumers; this
//                  removed 5 test files — 2 net add because U1-U7
//                  added 8 new test files — and 27 it() blocks that
//                  tested code no longer in the tree)
// 2026-04-08 PR10: 372 test files / 5983 it() blocks
//                  (Phase F PR-10 split chat-executor.test.ts into 10
//                  module-aligned sibling files plus a thinned
//                  integration suite; added 7 fresh unit tests in
//                  chat-executor-usage.test.ts covering the pure
//                  accumulateUsage/createCallUsageRecord helpers)
const MIN_TEST_FILES = 372;
const MIN_IT_BLOCKS = 5983;

// Ban phrases that are *unambiguously* AI-attribution markers.
//
// There are two kinds of markers:
//   - **Trailer-shaped**: only meaningful when they appear at the
//     start of a line (e.g. `Co-Authored-By: ...`, `Generated with
//     <tool>`). Prose describing the policy can mention them inline
//     without tripping the check.
//   - **Anywhere**: the robot emoji and AI-vendor email addresses,
//     which never appear legitimately in any commit on this repo.
//
// Ordering-independent; checked in a single scan.
const BANNED_TRAILER_PATTERNS = [
  /^co-authored-by\s*:/im,
  /^generated\s+(with|by)\s+claude/im,
  /^generated\s+(with|by)\s+anthropic/im,
];
const BANNED_ANYWHERE_PATTERNS = [
  /noreply@anthropic/i,
  /\u{1F916}/u, // robot emoji
];

function die(msg) {
  process.stderr.write(`[check:executor-baseline] FAIL: ${msg}\n`);
  process.exit(1);
}

function ok(msg) {
  process.stdout.write(`[check:executor-baseline] ${msg}\n`);
}

function listTestFiles() {
  // Use git ls-files so we only count tracked files. Much faster than
  // a recursive fs walk and deterministic across working trees. Note:
  // git ls-files treats `**` as a single-segment wildcard, not a
  // recursive match, so we enumerate the full tracked set and filter
  // with a plain regex. Still ~fast (ls-files is seed-of-O(millisec)).
  const out = execSync("git ls-files runtime/", {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const testPathRe = /^runtime\/(src|tests)\/.*\.test\.ts$/;
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => testPathRe.test(line));
}

function countItBlocks(files) {
  // Match `it(`, `it.only(`, `it.skip(`, `test(`, `test.only(`, `test.skip(`
  // at the start of a line (optional whitespace). This matches how vitest
  // authors write tests and avoids counting identifiers like `await it(`.
  const re = /^\s*(?:it|test)(?:\.(?:only|skip|skipIf|each|todo))?\(/gm;
  let total = 0;
  for (const rel of files) {
    const abs = resolve(repoRoot, rel);
    let contents;
    try {
      contents = readFileSync(abs, "utf8");
    } catch (err) {
      die(`could not read ${rel}: ${err.message}`);
    }
    const matches = contents.match(re);
    if (matches) total += matches.length;
  }
  return total;
}

function checkLastCommitMessage() {
  let msg;
  try {
    msg = execSync("git log -1 --pretty=%B", {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } catch (err) {
    die(`could not read last commit message: ${err.message}`);
  }
  for (const pattern of BANNED_TRAILER_PATTERNS) {
    const match = msg.match(pattern);
    if (match) {
      die(
        `last commit message contains banned attribution trailer /${pattern.source}/:\n${msg
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n")}`,
      );
    }
  }
  for (const pattern of BANNED_ANYWHERE_PATTERNS) {
    const match = msg.match(pattern);
    if (match) {
      die(
        `last commit message contains banned attribution marker /${pattern.source}/:\n${msg
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n")}`,
      );
    }
  }
  return msg.split("\n")[0] ?? "(empty)";
}

const start = Date.now();

// 1. repo sanity
try {
  statSync(resolve(repoRoot, ".git"));
} catch {
  die(
    `expected to run from inside the agenc-core repo (no .git at ${repoRoot})`,
  );
}

// 2. test file count
const files = listTestFiles();
if (files.length < MIN_TEST_FILES) {
  die(
    `test file count ${files.length} is below floor ${MIN_TEST_FILES}. ` +
      `If you legitimately reduced the count (e.g. Phase F test swap), raise or hold the floor in the same PR.`,
  );
}
ok(`test file count ${files.length} >= ${MIN_TEST_FILES}`);

// 3. it() block count
const itCount = countItBlocks(files);
if (itCount < MIN_IT_BLOCKS) {
  die(
    `it()/test() block count ${itCount} is below floor ${MIN_IT_BLOCKS}. ` +
      `Do not drop tests to fit refactor work — hold or raise the floor.`,
  );
}
ok(`it()/test() block count ${itCount} >= ${MIN_IT_BLOCKS}`);

// 4. commit message attribution scan
const subject = checkLastCommitMessage();
ok(`last commit subject clean: "${subject}"`);

const elapsed = Date.now() - start;
ok(`baseline OK (${elapsed}ms)`);
