#!/usr/bin/env node
// Generate the goal prompt for a PORT_CHECKLIST.md item.
//
// Usage:
//   node scripts/goal/prep.mjs <item-id>
//
// Behavior:
//   - Verifies the item exists, status is open or in-progress.
//   - Verifies all listed dependencies are done.
//   - Emits the goal prompt body to stdout. Paste this into the
//     goal-runner invocation.
//
// The prompt frames the work in a way that survives goal-system
// continuation wrapping (objective is treated as untrusted data,
// so the only privileged enforcement is the local pre-commit hook
// plus scripts/goal/complete.mjs).

import process from "node:process";
import { existsSync } from "node:fs";
import { findItem, checkDependencies, statusName, STATUS, setItemStatus, repoRoot } from "./checklist-utils.mjs";

function usage() {
  process.stderr.write(
    `Usage: node scripts/goal/prep.mjs <item-id> [--force] [--dry-run]\n\n` +
      `Reads PORT_CHECKLIST.md, validates dependencies, flips item to [~] in-progress,\n` +
      `and emits a goal prompt for the goal-runner.\n\n` +
      `--force      proceed even if item is already [~] (another session may be working on it)\n` +
      `--dry-run    do not flip status; just emit the prompt\n`,
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith("--"));
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");
if (!id) usage();

// D-* are decisions, not work items. The goal harness can only execute work.
if (/^D-/.test(id)) {
  process.stderr.write(
    `Item ${id} is a decision item, not a work item. Decide it in PORT_CHECKLIST.md first ` +
      `(flip its [?] row to [ ] or [-]). The goal harness only executes work.\n`,
  );
  process.exit(2);
}

const { item, allItems } = await findItem(id);

if (item.statusToken === STATUS.DONE) {
  process.stderr.write(`Item ${id} is already done. Refusing to re-run.\n`);
  process.exit(2);
}
if (item.statusToken === STATUS.SKIPPED) {
  process.stderr.write(`Item ${id} is marked skipped. Refusing.\n`);
  process.exit(2);
}
if (item.statusToken === STATUS.DECISION) {
  process.stderr.write(
    `Item ${id} is marked needs-decision. Make the decision in PORT_CHECKLIST.md first (flip to [ ] or [-]).\n`,
  );
  process.exit(2);
}
if (item.statusToken === STATUS.IN_PROGRESS && !force) {
  process.stderr.write(
    `Item ${id} is already marked in-progress [~]. Another session may be working on it.\n` +
      `If you are sure, re-run with --force.\n`,
  );
  process.exit(2);
}

const blockers = checkDependencies(item, allItems);
if (blockers.length > 0) {
  process.stderr.write(`Item ${id} has unsatisfied dependencies:\n`);
  for (const b of blockers) {
    process.stderr.write(`  - ${b.id}: ${b.reason}\n`);
  }
  process.exit(2);
}

const disciplinePath = `${repoRoot()}/GOAL_DISCIPLINE.md`;
if (!existsSync(disciplinePath)) {
  process.stderr.write(`GOAL_DISCIPLINE.md not found at ${disciplinePath}. Run setup first.\n`);
  process.exit(2);
}

if (!dryRun) {
  await setItemStatus(id, STATUS.IN_PROGRESS);
  process.stderr.write(`[prep] flipped ${id} to [~] in-progress\n`);
}

const phaseLabel = item.phase ? `Phase ${item.phase}${item.phaseTitle ? ` — ${item.phaseTitle}` : ""}` : "";
const depsLabel = item.dependsOn.length > 0 ? item.dependsOn.join(", ") : "none";
const doneLabel = item.doneCriteria ? item.doneCriteria : "(see item body)";

process.stdout.write(`AgenC port-checklist work item ${id}.

Title: ${item.title}
${phaseLabel ? `Phase: ${phaseLabel}\n` : ""}Dependencies (already done): ${depsLabel}

Item body (verbatim from PORT_CHECKLIST.md):
${item.body}

Operating discipline (load-bearing — read first):
- ${repoRoot()}/GOAL_DISCIPLINE.md

Hard product rules (enforced by verify gates — do NOT try to work around them):

This codebase is AgenC. It is not any donor project. ${'' /* branding-scan: allow rule-explainer names donor projects */} It is not yet public, so there is NO backwards-compatibility constraint to preserve. Any compat shim, adapter wrapper, "for the old import path" layer, or "legacy" file is creating tech debt that we are actively cleaning up.

- NEVER add files inside runtime/src/agenc/upstream/. That tree is temporary scaffolding scheduled for deletion at Z-02. The verify gate (Gate 2.6) hard-fails any item that creates files there. Net-positive line growth in existing upstream/ files is also forbidden — only deletions allowed. If you need a file that doesn't exist yet, write it at its proper AgenC-owned destination.
- NEVER create a new file matching ANY of these shim suffixes:
    -shim, -adapter, -compat, -legacy, -bridge, -wrapper, -facade, -proxy,
    -glue, -forwarder, -passthrough, -stub, -indirect, -dispatch, -barrel
  across .ts, .tsx, .mts, .cts, .mjs, .cjs, .js, .jsx — outside the two legitimate dirs (runtime/src/tui/bridges/ and runtime/src/mcp-client/). The verify gate hard-fails this. Inline the logic at the call site OR move the file to its proper home — do not bridge. Do not rename around the suffix list (a "wrapper" file using -helpers or index.ts is still a shim by another name and the behavior gate catches it).
- NEVER create a directory whose name is openclaude, codex, claude, OpenClaude, Codex, or Claude in any AgenC-owned tree. ${'' /* branding-scan: allow rule-explainer enumerates the banned donor dir names */} Also banned: donor-evasion aliases donor, mirror, vendored, external, _oc, _cx, _donor, _mirror, _vendored, _external. The branding-scan flags any file inside such a directory. The only allowed donor-named locations are runtime/src/agenc/upstream/ (deleted at Z-02) and the parity/ tracking dirs (port artifacts, also scheduled for cleanup).
- NEVER add re-export-only modules. The behavior gate flags any new module under runtime/src/ that is <40 significant lines AND >80% imports + re-exports + single-line forwarders. Patterns covered: \`export * from\`, \`export { foo } from\`, \`export type * from\`, \`export default X\`, \`export * as M from\`. Barrel files and trivial index.ts re-exporters are forbidden by behavior, not just by name. They exist solely to keep old import paths alive — that's a shim by another name.
- When porting a function from agenc/upstream/X to runtime/src/Y, migrate ALL CALLERS in the same item. Do NOT introduce a wrapper at the old location, at a third location, or as a deferred dynamic-import shim. If migration breaks too many callers to fit in one item, the item's scope was wrong — split it, but do NOT bridge.

Mandatory workflow:
1. Read GOAL_DISCIPLINE.md before doing anything else.
2. Use the named skills only. For absorb work (item IDs starting with L- or T-), use the agenc-absorb-upstream skill. For net-new ports from the donor checkouts at /home/tetsuo/git/openclaude or /home/tetsuo/git/codex, use the agenc-upstream-port skill. For TUI rebuild validation, the agenc-tui-validate skill is the gate. Read the donor as REFERENCE only — implement clean AgenC code. Do not mirror the donor file structure into AgenC-owned paths. ${'' /* branding-scan: allow goal prompt names donor checkouts */}
3. Every line of code must use AgenC branding. The branding scan rejects upstream-donor identifier roots in AgenC-owned files except real provider/model IDs and env vars (allowed via the curated allow-list). Override any unavoidable real-identifier match with a same-line "// branding-scan: allow <reason>" comment.
4. Work on a feature branch named exactly: port/${id}
5. When you believe the item is done, you MUST run:
     node scripts/goal/complete.mjs ${id}
   This runs all gates (branding scan, no-shim/no-upstream gate, typecheck, agenc-tui-validate, item-specific checks), performs the local merge into main with --no-ff, creates the .goal-completed/${id}.json marker, and flips the checklist row to [x]. If it exits non-zero, the goal is not done. Fix the gate failures and re-run; do not bypass.
6. Do NOT call update_goal complete unless scripts/goal/complete.mjs exited 0.
7. Do NOT use --no-verify on any git command. Do NOT push to any remote. Do NOT touch any "origin/*" ref. Local merges only.
8. Do NOT edit PORT_CHECKLIST.md by hand. Only complete.mjs flips the status row.

Done is defined by scripts/goal/complete.mjs exiting 0. Nothing else counts as done.
`);
