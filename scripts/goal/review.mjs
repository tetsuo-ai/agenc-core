#!/usr/bin/env node
// Senior-engineer reviewer gate for a PORT_CHECKLIST.md item.
//
// Usage:
//   node scripts/goal/review.mjs <item-id>
//
// branding-scan: allow names the reviewer CLI binary that this script invokes
// Spawns a fresh reviewer subagent (via the codex exec review CLI) against
// the changes on the current port/<item-id> branch, with structured prompt
// including the item spec and the operating discipline. Reads the final
// reviewer message and parses a VERDICT line.
//
// Exit 0 only when the reviewer returns VERDICT: APPROVED.
// On NEEDS_REVISION / BLOCKED / parse failure, exit 1 with the issue list.
//
// Skip with env AGENC_SKIP_REVIEW=1 (escape hatch for emergencies).
// Override the reviewer model with env AGENC_REVIEW_MODEL=<model>.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { findItem, repoRoot } from "./checklist-utils.mjs";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";

function usage() {
  process.stderr.write(`Usage: node scripts/goal/review.mjs <item-id>\n`);
  process.exit(2);
}

const id = process.argv[2];
if (!id) usage();

if (process.env.AGENC_SKIP_REVIEW === "1") {
  process.stdout.write(`${YELLOW}!${RESET} reviewer skipped via AGENC_SKIP_REVIEW=1\n`);
  process.exit(0);
}

const root = repoRoot();
const { item } = await findItem(id);

const disciplinePath = path.join(root, "GOAL_DISCIPLINE.md");
const discipline = existsSync(disciplinePath) ? readFileSync(disciplinePath, "utf8") : "";
const crossRepoEvidence = collectCrossRepoEvidence(item.body);

const reviewerInstructions = `You are a senior software engineer reviewing one work item from an AgenC port checklist.

ITEM ID: ${id}
ITEM TITLE: ${item.title}
ITEM PHASE: ${item.phase}
ITEM SPEC (verbatim from PORT_CHECKLIST.md):
${item.body}

Your job: read the diff against main on the current port/${id} branch and judge whether the implementation is correct, complete, and well-tested for what the item asks for. Look for:

1. Behavioral correctness — does the code actually do what the item says, not just have the right shape?
2. Edge cases — what's missing? What inputs would break this?
3. Test quality — do the tests exercise real behavior, or only assert structure / file existence? Are there fuzz / property-style checks where appropriate?
4. Naming and branding — any leaks of forbidden upstream-donor identifier roots in AgenC-owned files? Real provider/model identifiers are allowed.
5. Domain hygiene — no invented domains in code (URN form or omit). The only AgenC-owned domain is agenc.tech.
6. Scope discipline — did the agent expand beyond the item, or shrink it too aggressively? If the agent narrowed scope due to a missing dependency, did it document the gap clearly?
7. Architecture — anything in this change that will bite a downstream item?

Operating discipline that the implementing agent was bound by:
${discipline}

Cross-repo review evidence:
${crossRepoEvidence}

Some checklist items explicitly name sibling repositories such as
\`agenc-sdk/\`, \`agenc-protocol/\`, or \`agenc-plugin-kit/\`. For those
items, evaluate the named sibling repository state and evidence above as part
of the item. The agenc-core diff may carry only the local contract gate for
that sibling deliverable. Still reject the item if the sibling evidence is
missing, unmerged locally, untested, or does not satisfy the item.
Ignore unrelated dirty sibling files that do not touch the named item paths.

You are NOT permitted to edit code in this run. Read-only review.

Required output format. Your FINAL line must be exactly one of:

  VERDICT: APPROVED
  VERDICT: NEEDS_REVISION
  VERDICT: BLOCKED

Before that line, write a short structured report:
- 1-3 sentence summary of the diff
- numbered list of issues (severity CRITICAL / HIGH / MEDIUM / LOW), each with file path and what to change
- if APPROVED, you may still list issues but they must all be LOW priority follow-ups
- if NEEDS_REVISION, list exactly what the agent must fix to pass
- if BLOCKED, explain why the work cannot proceed without user input

Do not chat. Do not propose unrelated changes. Stick to this item.`;

const tmp = mkdtempSync(path.join(tmpdir(), `agenc-review-${id}-`));
const outFile = path.join(tmp, "verdict.txt");
const promptFile = path.join(tmp, "prompt.md");
writeFileSync(promptFile, reviewerInstructions, "utf8");

process.stdout.write(`\n${BOLD}━━ reviewer subagent: ${id}${RESET}\n`);
// branding-scan: allow names the reviewer CLI binary that this script invokes
process.stdout.write(`${DIM}spawning codex exec reviewer against main (this takes 30–90 seconds)...${RESET}\n`);

const reviewArgs = [
  "exec",
  "--ephemeral",
  "--ignore-user-config",
  "--skip-git-repo-check",
  "--dangerously-bypass-approvals-and-sandbox",
  "-o",
  outFile,
];
if (process.env.AGENC_REVIEW_MODEL) {
  reviewArgs.push("-m", process.env.AGENC_REVIEW_MODEL);
}
reviewArgs.push("-");

// branding-scan: allow real binary name of the reviewer CLI
const result = spawnSync("codex", reviewArgs, {
  cwd: root,
  encoding: "utf8",
  input: reviewerInstructions,
  stdio: ["pipe", "pipe", "pipe"],
});

if (result.status !== 0) {
  process.stderr.write(`${BOLD}${RED}✗${RESET} reviewer subprocess failed (exit ${result.status})\n`);
  if (result.stderr) process.stderr.write(`stderr: ${result.stderr.slice(0, 2000)}\n`);
  if (result.stdout) process.stderr.write(`stdout: ${result.stdout.slice(0, 2000)}\n`);
  process.exit(1);
}

const finalMsg = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
if (!finalMsg.trim()) {
  process.stderr.write(`${BOLD}${RED}✗${RESET} reviewer produced no output\n`);
  process.exit(1);
}

const verdictMatch = /^VERDICT:\s*(APPROVED|NEEDS_REVISION|BLOCKED)\s*$/m.exec(finalMsg);
if (!verdictMatch) {
  process.stderr.write(`${BOLD}${RED}✗${RESET} reviewer output missing VERDICT line\n`);
  process.stderr.write(`--- reviewer output ---\n${finalMsg}\n--- end ---\n`);
  process.exit(1);
}

const verdict = verdictMatch[1];

process.stdout.write(`\n${DIM}--- reviewer report ---${RESET}\n`);
process.stdout.write(finalMsg.trim() + "\n");
process.stdout.write(`${DIM}--- end ---${RESET}\n`);

if (verdict === "APPROVED") {
  process.stdout.write(`\n${GREEN}✓${RESET} reviewer APPROVED ${id}\n`);
  process.exit(0);
}

process.stderr.write(`\n${BOLD}${RED}✗${RESET} reviewer ${verdict} ${id}\n`);
process.stderr.write(`Address the issues above and re-run scripts/goal/complete.mjs ${id}.\n`);
process.exit(1);

function collectCrossRepoEvidence(body) {
  const repos = [];
  if (body.includes("agenc-sdk")) repos.push("agenc-sdk");
  if (body.includes("agenc-protocol")) repos.push("agenc-protocol");
  if (body.includes("agenc-plugin-kit")) repos.push("agenc-plugin-kit");
  if (repos.length === 0) return "(none)";

  return repos.map((repo) => summarizeSiblingRepo(repo)).join("\n\n");
}

function summarizeSiblingRepo(repo) {
  const siblingRoot = path.resolve(root, "..", repo);
  if (!existsSync(siblingRoot)) {
    return `- ${repo}: missing at ${siblingRoot}`;
  }

  const status = runQuiet("git", ["status", "--short", "--branch"], siblingRoot);
  const log = runQuiet(
    "git",
    ["log", "--oneline", "--decorate", "--max-count=8"],
    siblingRoot,
  );
  const examplesDir = path.join(siblingRoot, "examples");
  const exampleFiles = existsSync(examplesDir)
    ? walkFiles(examplesDir).map((file) => path.relative(siblingRoot, file))
    : [];

  return [
    `- ${repo}: ${siblingRoot}`,
    "  status:",
    indent(status || "(no status output)", "    "),
    "  recent commits:",
    indent(log || "(no git log output)", "    "),
    "  examples:",
    indent(exampleFiles.slice(0, 80).join("\n") || "(no examples found)", "    "),
  ].join("\n");
}

function runQuiet(cmd, argv, cwd) {
  const result = spawnSync(cmd, argv, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    return (result.stderr || result.stdout || "").trim();
  }
  return result.stdout.trim();
}

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...walkFiles(full));
      continue;
    }
    out.push(full);
  }
  return out;
}

function indent(text, prefix) {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
