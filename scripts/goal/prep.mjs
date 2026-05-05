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
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { findItem, checkDependencies, statusName, STATUS, setItemStatus, repoRoot, mainCheckoutRoot, worktreePath, worktreeBase, findGitWorktreeEntry } from "./checklist-utils.mjs";

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

// branding-scan: allow comment names the goal-runner CLI for context
// Create a per-item worktree so multiple codex sessions can work in parallel
// from the same main checkout. Each worktree gets its own working directory
// and its own port/<id> branch. Shared state (PORT_CHECKLIST.md, .goal-completed,
// lock file) lives in the main checkout and is reachable from any worktree
// via mainCheckoutRoot().
const wtPath = worktreePath(id);
const branch = `port/${id}`;
const mainRoot = mainCheckoutRoot();
let createdWorktree = false;
let createdBranch = false;

if (!dryRun) {
  // Idempotency: if the worktree already exists for this item (resume after
  // a crash or partial prior run), reuse it. Otherwise create fresh.
  const wtList = spawnSync("git", ["-C", mainRoot, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  if (wtList.status !== 0) {
    process.stderr.write(`[prep] FAILED to list git worktrees:\n${wtList.stderr || wtList.stdout}\n`);
    process.exit(1);
  }
  const wtEntry = findGitWorktreeEntry(wtList.stdout, wtPath);

  if (wtEntry) {
    const expectedRef = `refs/heads/${branch}`;
    if (wtEntry.branch !== expectedRef) {
      process.stderr.write(
        `[prep] existing worktree ${wtPath} is on ${wtEntry.branch ?? "(detached/no branch)"}, expected ${expectedRef}.\n`,
      );
      process.exit(1);
    }
    const wtStatus = spawnSync("git", ["-C", wtPath, "status", "--short"], { encoding: "utf8" });
    if (wtStatus.status !== 0) {
      process.stderr.write(`[prep] FAILED to inspect existing worktree ${wtPath}:\n${wtStatus.stderr || wtStatus.stdout}\n`);
      process.exit(1);
    }
    if (wtStatus.stdout.trim()) {
      process.stderr.write(`[prep] existing worktree ${wtPath} is dirty:\n${wtStatus.stdout}\n`);
      process.exit(1);
    }
    process.stderr.write(`[prep] worktree already exists at ${wtPath} — reusing\n`);
  } else {
    // Check if branch already exists (e.g., from a prior aborted run)
    const branchCheck = spawnSync("git", ["-C", mainRoot, "rev-parse", "--verify", "--quiet", branch], { encoding: "utf8" });
    const branchExists = branchCheck.status === 0;

    try { mkdirSync(worktreeBase(), { recursive: true }); } catch {}

    const addArgs = branchExists
      ? ["-C", mainRoot, "worktree", "add", wtPath, branch]
      : ["-C", mainRoot, "worktree", "add", wtPath, "-b", branch, "main"];

    const addRes = spawnSync("git", addArgs, { encoding: "utf8" });
    if (addRes.status !== 0) {
      process.stderr.write(`[prep] FAILED to create worktree at ${wtPath}:\n${addRes.stderr || addRes.stdout}\n`);
      process.exit(1);
    }
    createdWorktree = true;
    createdBranch = !branchExists;
    process.stderr.write(`[prep] worktree created: ${wtPath} (branch ${branch})\n`);
  }
}

if (!dryRun) {
  try {
    await setItemStatus(id, STATUS.IN_PROGRESS);
    process.stderr.write(`[prep] flipped ${id} to [~] in-progress (in main checkout: ${mainRoot})\n`);
  } catch (error) {
    if (createdWorktree) {
      spawnSync("git", ["-C", mainRoot, "worktree", "remove", "--force", wtPath], { encoding: "utf8" });
    }
    if (createdBranch) {
      spawnSync("git", ["-C", mainRoot, "branch", "-D", branch], { encoding: "utf8" });
    }
    process.stderr.write(`[prep] FAILED to flip ${id} to [~] in-progress: ${error?.message || error}\n`);
    process.exit(1);
  }
}

const phaseLabel = item.phase ? `Phase ${item.phase}${item.phaseTitle ? ` — ${item.phaseTitle}` : ""}` : "";
const depsLabel = item.dependsOn.length > 0 ? item.dependsOn.join(", ") : "none";
const doneLabel = item.doneCriteria ? item.doneCriteria : "(see item body)";

process.stdout.write(`AgenC port-checklist work item ${id}.

═══════════════════════════════════════════════════════════════════════
WORKTREE (mandatory — do this BEFORE any other action):
  cd ${wtPath}

Branch ${branch} is already created and checked out at that path. ALL
work for this item happens in that directory. Do NOT edit files in
${mainRoot} — that is the main checkout, shared across parallel sessions.

When you are done, run from inside the worktree:
  node ${wtPath}/scripts/goal/complete.mjs ${id}

complete.mjs handles: gates → reviewer → merge into main (in the main
checkout) → branch delete → worktree cleanup → checklist flip.
═══════════════════════════════════════════════════════════════════════

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
- NEVER create a directory whose name is openclaude, codex, claude, OpenClaude, Codex, or Claude in any AgenC-owned tree. ${'' /* branding-scan: allow rule-explainer enumerates the banned donor dir names */} Also banned: donor-evasion aliases donor, mirror, vendored, external, _oc, _cx, _donor, _mirror, _vendored, _external. The branding-scan flags any file inside such a directory. The only allowed donor-named location is runtime/src/agenc/upstream/ while it exists before Z-02 cleanup.
- NEVER add re-export-only modules. The behavior gate flags any new module under runtime/src/ that is <40 significant lines AND >80% imports + re-exports + single-line forwarders. Patterns covered: \`export * from\`, \`export { foo } from\`, \`export type * from\`, \`export default X\`, \`export * as M from\`. Barrel files and trivial index.ts re-exporters are forbidden by behavior, not just by name. They exist solely to keep old import paths alive — that's a shim by another name.
- When porting a function from agenc/upstream/X to runtime/src/Y, migrate ALL CALLERS in the same item. Do NOT introduce a wrapper at the old location, at a third location, or as a deferred dynamic-import shim. If migration breaks too many callers to fit in one item, the item's scope was wrong — split it, but do NOT bridge.

Mandatory workflow:
1. Read GOAL_DISCIPLINE.md before doing anything else.
2. Use the named skills only. For absorb work (item IDs starting with L- or T-), use the agenc-absorb-upstream skill. For net-new ports from the donor checkouts at /home/tetsuo/git/openclaude or /home/tetsuo/git/codex, use the agenc-upstream-port skill. For TUI rebuild validation, the agenc-tui-validate skill is the gate. Read the donor as REFERENCE only — implement clean AgenC code. Do not mirror the donor file structure into AgenC-owned paths. ${'' /* branding-scan: allow goal prompt names donor checkouts */}
2a. **DONOR INSPECTION REQUIREMENT**: if this item's row body contains a "Donor:" clause naming files in the donor checkouts ${'' /* branding-scan: allow rule-explainer names donor checkouts */}(/home/tetsuo/git/openclaude or /home/tetsuo/git/codex, incl. the "OC" / "CX" / "codex" shorthand prefixes), you MUST read every cited donor file end-to-end BEFORE writing any AgenC code. Cite the specific donor files in your commit message body (one line per donor file). Items that have a Donor: clause but skip this step ship shallow re-implementations that the reviewer rejects, costing money and wall time. The donor citation in the commit message is your contract that the inspection happened.
3. Every line of code must use AgenC branding. The branding scan rejects upstream-donor identifier roots in AgenC-owned files except real provider/model IDs and env vars (allowed via the curated allow-list). Override any unavoidable real-identifier match with a same-line "// branding-scan: allow <reason>" comment.
4. Work in the dedicated worktree at ${wtPath} on the pre-created branch port/${id}. Do NOT create new branches; the worktree IS the branch. Do NOT cd back to ${mainRoot} for any reason — that's reserved for the merge step which complete.mjs handles automatically.
5. When you believe the item is done, you MUST run from inside the worktree:
     cd ${wtPath} && node scripts/goal/complete.mjs ${id}
   This runs all gates (branding scan, no-shim/no-upstream gate, typecheck, agenc-tui-validate, item-specific checks), performs the local merge into main (in the main checkout, not this worktree), removes the worktree, deletes the branch, creates the .goal-completed/${id}.json marker (in the main checkout), and flips the checklist row to [x]. If it exits non-zero, the goal is not done. Fix the gate failures and re-run; do not bypass.
6. Do NOT call update_goal complete unless scripts/goal/complete.mjs exited 0.
7. Do NOT use --no-verify on any git command. Do NOT push to any remote. Do NOT touch any "origin/*" ref. Local merges only.
8. Do NOT edit PORT_CHECKLIST.md by hand. Only complete.mjs flips the status row.

Done is defined by scripts/goal/complete.mjs exiting 0. Nothing else counts as done.
`);
