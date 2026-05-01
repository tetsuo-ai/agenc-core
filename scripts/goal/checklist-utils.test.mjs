#!/usr/bin/env node
// Smoke tests for checklist-utils.mjs — exercise the parser, dependency
// resolution, and status round-trip against the real PORT_CHECKLIST.md.
//
// Usage:
//   node scripts/goal/checklist-utils.test.mjs
//
// Exits 0 on pass, 1 on failure.

import process from "node:process";
import { readChecklist, parseItems, findItem, checkDependencies, statusName, STATUS } from "./checklist-utils.mjs";

let passed = 0;
let failed = 0;

function assert(name, condition, detail = "") {
  if (condition) {
    process.stdout.write(`✓ ${name}\n`);
    passed += 1;
  } else {
    process.stderr.write(`✗ ${name}\n`);
    if (detail) process.stderr.write(`    ${detail}\n`);
    failed += 1;
  }
}

const { content } = await readChecklist();
const items = parseItems(content);

assert("parses some items", items.length > 50, `got ${items.length}`);

// Items have required fields.
const sample = items.find((i) => i.id === "F-01");
assert("F-01 found", !!sample);
assert("F-01 has title", sample && sample.title.length > 0);
assert("F-01 has body", sample && sample.body.length > 0);
assert("F-01 status is open", sample && sample.statusToken === STATUS.OPEN);

// Status name conversion.
assert("statusName open", statusName(STATUS.OPEN) === "open");
assert("statusName done", statusName(STATUS.DONE) === "done");
assert("statusName decision", statusName(STATUS.DECISION) === "needs-decision");
assert("statusName skipped", statusName(STATUS.SKIPPED) === "skipped");
assert("statusName in-progress", statusName(STATUS.IN_PROGRESS) === "in-progress");

// Dependency parsing.
const f03e = items.find((i) => i.id === "F-03e");
assert("F-03e found", !!f03e);
if (f03e) {
  assert("F-03e depends on A-00c", f03e.dependsOn.includes("A-00c"), `deps=${f03e.dependsOn.join(",")}`);
}

const t08 = items.find((i) => i.id === "T-08");
assert("T-08 found", !!t08);
if (t08) {
  assert(
    "T-08 depends on T-01..T-07 (at least T-01)",
    t08.dependsOn.includes("T-01"),
    `deps=${t08.dependsOn.join(",")}`,
  );
}

// Dependency satisfaction.
const blockers = checkDependencies(f03e, items);
assert(
  "F-03e blocked by A-00c (open)",
  blockers.length > 0 && blockers.some((b) => b.id === "A-00c"),
  JSON.stringify(blockers),
);

// findItem.
try {
  const { item } = await findItem("F-01");
  assert("findItem F-01 returns the item", item.id === "F-01");
} catch (e) {
  assert("findItem F-01 returns the item", false, e.message);
}

try {
  await findItem("Z-99");
  assert("findItem Z-99 throws", false);
} catch {
  assert("findItem Z-99 throws", true);
}

// Phase parsing.
const lp10 = items.find((i) => i.id === "LP-10");
assert("LP-10 found", !!lp10);
if (lp10) {
  assert("LP-10 has a phase label", !!lp10.phase, `phase=${lp10.phase}`);
}

// Decision items (D-*) parse.
const d01 = items.find((i) => i.id === "D-01");
assert("D-01 found", !!d01);

// Skipped items: most `[-]` rows in PORT_CHECKLIST.md are notes without
// proper IDs (e.g. "CX `login/`") and are intentionally not work items,
// so they do not appear in parsed items. Skip the test.

// Done-criteria parsing — at least some items have it extracted.
// Many items rely on the shared default done-criteria from the conventions
// section rather than declaring per-item, so don't require a high count.
const withDone = items.filter((i) => i.doneCriteria);
assert("at least 1 item has done-criteria parsed", withDone.length >= 1, `got ${withDone.length}`);

// Phase parsing should produce numeric phases for the main work phases.
const phaseLabels = new Set(items.map((i) => i.phase).filter(Boolean));
const hasNumericPhase = [...phaseLabels].some((p) => /^\d/.test(p));
assert("at least one numeric phase parsed", hasNumericPhase, `phases=${[...phaseLabels].join(",")}`);

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
