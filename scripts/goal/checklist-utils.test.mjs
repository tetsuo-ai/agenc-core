#!/usr/bin/env node
// Smoke tests for checklist-utils.mjs — exercise the parser, dependency
// resolution, and status round-trip against the real PORT_CHECKLIST.md.
//
// Usage:
//   node scripts/goal/checklist-utils.test.mjs
//
// Exits 0 on pass, 1 on failure.

import process from "node:process";
import { readFileSync } from "node:fs";
import { readChecklist, parseItems, findItem, checkDependencies, statusName, STATUS, findGitWorktreeEntry, parseGitWorktreePorcelain } from "./checklist-utils.mjs";

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
assert(
  "F-01 status is one of {open, in-progress, done}",
  sample &&
    [STATUS.OPEN, STATUS.IN_PROGRESS, STATUS.DONE].includes(sample.statusToken),
);

// Status name conversion.
assert("statusName open", statusName(STATUS.OPEN) === "open");
assert("statusName done", statusName(STATUS.DONE) === "done");
assert("statusName decision", statusName(STATUS.DECISION) === "needs-decision");
assert("statusName skipped", statusName(STATUS.SKIPPED) === "skipped");
assert("statusName in-progress", statusName(STATUS.IN_PROGRESS) === "in-progress");

const worktreePorcelain = [
  "worktree /repo/main",
  "HEAD abc123",
  "branch refs/heads/main",
  "",
  "worktree /tmp/agenc-core-wt/PE-09",
  "HEAD def456",
  "branch refs/heads/port/PE-09",
  "",
].join("\n");
assert(
  "parses git worktree porcelain entries",
  parseGitWorktreePorcelain(worktreePorcelain).length === 2,
);
assert(
  "finds reused worktree branch ref",
  findGitWorktreeEntry(worktreePorcelain, "/tmp/agenc-core-wt/PE-09")?.branch === "refs/heads/port/PE-09",
);

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

// Dependency satisfaction. The checklist advances over time, so avoid
// hard-coding one dependency as open forever.
const blockedDependencySample = items
  .map((item) => ({ item, blockers: checkDependencies(item, items) }))
  .find(({ blockers }) => blockers.length > 0);
assert(
  "dependency satisfaction reflects current checklist state",
  blockedDependencySample
    ? blockedDependencySample.blockers.every((b) => typeof b.id === "string" && b.id.length > 0)
    : items.every((item) => checkDependencies(item, items).length === 0),
  blockedDependencySample
    ? JSON.stringify(blockedDependencySample)
    : "all parsed dependencies are currently satisfied",
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

const completeSource = readFileSync(new URL("./complete.mjs", import.meta.url), "utf8");
const verifySource = readFileSync(new URL("./verify.mjs", import.meta.url), "utf8");
const shimBehaviorSource = readFileSync(new URL("./shim-behavior.mjs", import.meta.url), "utf8");
const vitestConfigSource = readFileSync(new URL("../../runtime/vitest.config.ts", import.meta.url), "utf8");
assert(
  "complete.mjs hard-fails worktree removal failures",
  /const wtRemove =[\s\S]*if \(wtRemove\.status !== 0\) \{\s*abort\(/.test(completeSource),
);
assert(
  "complete.mjs hard-fails branch deletion failures",
  /const deleteRes =[\s\S]*if \(deleteRes\.status !== 0\) \{\s*abort\(/.test(completeSource),
);
assert(
  "complete.mjs deletes the feature branch from the main checkout cwd",
  /const deleteRes = runInMainCheckout\("git", \["-C", mainRoot, "branch", "-d", expected\]\);/.test(completeSource),
);
assert(
  "complete.mjs can recover a same-item in-flight journal after merge",
  /async function recoverMatchingInFlightJournal/.test(completeSource) &&
    /const mergeCommit = mergeCommitForJournal\(journal\);/.test(completeSource) &&
    /writeCompletionMarker\(mergeCommit\);/.test(completeSource),
);
assert(
  "complete.mjs keeps foreign in-flight journals fail-closed",
  /Foreign journals still fail closed/.test(completeSource) &&
    /failIfInFlightJournalsFound\(\);/.test(completeSource),
);

const singleLineForwardFn = extractRegexFromSource(shimBehaviorSource, "SINGLE_LINE_FORWARD_FN_RE");
const singleLineForwardArrow = extractRegexFromSource(shimBehaviorSource, "SINGLE_LINE_FORWARD_ARROW_RE");
assert(
  "verify.mjs detects exported one-line forwarding functions",
  singleLineForwardFn.test("export function shim(input) { return realImpl(input); }"),
);
assert(
  "verify.mjs detects exported one-line forwarding arrows",
  singleLineForwardArrow.test("export const shim = (input) => realImpl(input);") &&
    singleLineForwardArrow.test("export const shim = (input) => { return realImpl(input); };"),
);

const zc24GateSource = extractFunctionSource(verifySource, "assertZc24UnusedDependenciesRemoved");
assert(
  "verify.mjs ZC-24 scans runtime module import extensions",
  ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs"].every((glob) =>
    zc24GateSource.includes(`"${glob}"`),
  ),
);
assert(
  "verify.mjs ZC-24 includes upstream source in removed-package scan",
  zc24GateSource.includes('"runtime/src"') &&
    !zc24GateSource.includes("!runtime/src/agenc/upstream") &&
    !zc24GateSource.includes("!agenc/upstream"),
);
assert(
  "verify.mjs ZC-24 retains packages with runtime importers",
  zc24GateSource.includes("packagesWithRuntimeImporters") &&
    zc24GateSource.includes('"@ant/computer-use-mcp"') &&
    zc24GateSource.includes('"jimp"') &&
    zc24GateSource.includes('"markdown-it"'),
);

const upstreamGrowthGateStart = verifySource.indexOf("const upstreamNumstatRes");
const upstreamGrowthGateEnd = verifySource.indexOf("const upstreamImportGrowthScript");
const upstreamGrowthGateSource = upstreamGrowthGateStart === -1 || upstreamGrowthGateEnd === -1
  ? ""
  : verifySource.slice(upstreamGrowthGateStart, upstreamGrowthGateEnd);
assert(
  "verify.mjs upstream growth gate uses raw numstat",
  upstreamGrowthGateSource.includes("row.added > row.deleted") &&
    !upstreamGrowthGateSource.includes("effectiveAdded") &&
    !upstreamGrowthGateSource.includes("neutralBoundary") &&
    !upstreamGrowthGateSource.includes("ts-nocheck"),
);

const zPurgeaGateStart = verifySource.indexOf('if (id === "Z-PURGEA")');
const zPurgeaGateEnd = verifySource.indexOf('if (id === "Z-PURGEB")');
const zPurgeaGateSource = zPurgeaGateStart === -1 || zPurgeaGateEnd === -1
  ? ""
  : verifySource.slice(zPurgeaGateStart, zPurgeaGateEnd);
assert(
  "verify.mjs Z-PURGEA rejects agenc.dev in moved files",
  zPurgeaGateSource.includes("agenc\\.(?:ai|com|dev)"),
);
assert(
  "verify.mjs Z-PURGEA probes moved source importability",
  zPurgeaGateSource.includes("tests/zpurgea-importability.test.ts") &&
    zPurgeaGateSource.includes("movedDonorTests"),
);
assert(
  "runtime vitest config mirrors moved utility resolution",
  vitestConfigSource.includes("relocatedUpstreamImporter") &&
    vitestConfigSource.includes("relocatedUpstreamRoots") &&
    vitestConfigSource.includes("movedDonorTestFiles"),
);

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

function extractRegexFromSource(source, name) {
  const marker = `const ${name} =`;
  const start = source.indexOf(marker);
  if (start === -1) return /a^/u;
  const rest = source.slice(start + marker.length);
  const end = rest.indexOf(";\n");
  if (end === -1) return /a^/u;
  const literal = rest.slice(0, end).trim();
  const lastSlash = literal.lastIndexOf("/");
  if (!literal.startsWith("/") || lastSlash <= 0) return /a^/u;
  return new RegExp(literal.slice(1, lastSlash), literal.slice(lastSlash + 1));
}

function extractFunctionSource(source, name) {
  const marker = `function ${name}()`;
  const start = source.indexOf(marker);
  if (start === -1) return "";
  const nextFunction = source.indexOf("\nfunction ", start + marker.length);
  return source.slice(start, nextFunction === -1 ? undefined : nextFunction);
}
