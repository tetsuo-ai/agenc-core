#!/usr/bin/env node
// List eligible work items in PORT_CHECKLIST.md ordered by phase + ID.
//
// Usage:
//   node scripts/goal/next.mjs                  # show 10 eligible items
//   node scripts/goal/next.mjs --all            # show every eligible item
//   node scripts/goal/next.mjs --phase 1        # filter by phase
//   node scripts/goal/next.mjs --prefix LP      # filter by ID prefix
//   node scripts/goal/next.mjs --json           # machine-readable output
//
// Eligible = status [ ] open AND every dependency is [x] done.
// In-progress [~] items are listed separately at the top.

import process from "node:process";
import { readChecklist, parseItems, checkDependencies, STATUS, statusName } from "./checklist-utils.mjs";

const args = process.argv.slice(2);
const all = args.includes("--all");
const json = args.includes("--json");
const phaseIdx = args.indexOf("--phase");
const phaseFilter = phaseIdx >= 0 ? args[phaseIdx + 1] : null;
const prefixIdx = args.indexOf("--prefix");
const prefixFilter = prefixIdx >= 0 ? args[prefixIdx + 1] : null;
const limit = all ? Infinity : 10;

const { content } = await readChecklist();
const items = parseItems(content);

const inProgress = items.filter((i) => i.statusToken === STATUS.IN_PROGRESS);
const eligible = items.filter((i) => {
  if (i.statusToken !== STATUS.OPEN) return false;
  if (phaseFilter && i.phase !== phaseFilter) return false;
  if (prefixFilter && !i.id.startsWith(prefixFilter + "-")) return false;
  if (/^D-/.test(i.id)) return false; // decisions, not work
  const blockers = checkDependencies(i, items);
  return blockers.length === 0;
});

if (json) {
  process.stdout.write(
    JSON.stringify(
      {
        inProgress: inProgress.map(toJson),
        eligible: eligible.slice(0, limit).map(toJson),
        eligibleCount: eligible.length,
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(0);
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";

if (inProgress.length > 0) {
  process.stdout.write(`${BOLD}${YELLOW}In-progress (${inProgress.length}):${RESET}\n`);
  for (const i of inProgress) {
    process.stdout.write(`  [~] ${BOLD}${i.id}${RESET} ${i.title}\n`);
  }
  process.stdout.write("\n");
}

if (eligible.length === 0) {
  process.stdout.write(`No eligible items. ${blockedSummary()}\n`);
  process.exit(0);
}

const shown = eligible.slice(0, limit);
process.stdout.write(`${BOLD}Eligible (${shown.length}/${eligible.length}):${RESET}\n`);
for (const i of shown) {
  process.stdout.write(
    `  ${CYAN}${i.id}${RESET} ${DIM}[${i.phase || "?"}]${RESET} ${i.title}\n`,
  );
  if (i.dependsOn.length > 0) {
    process.stdout.write(`    ${DIM}deps satisfied: ${i.dependsOn.join(", ")}${RESET}\n`);
  }
}
if (eligible.length > shown.length) {
  process.stdout.write(`\n${DIM}(+${eligible.length - shown.length} more — pass --all to see all)${RESET}\n`);
}
process.stdout.write(`\n${DIM}Run: node scripts/goal/prep.mjs <id> to start work.${RESET}\n`);

function toJson(i) {
  return {
    id: i.id,
    title: i.title,
    phase: i.phase,
    status: statusName(i.statusToken),
    dependsOn: i.dependsOn,
  };
}

function blockedSummary() {
  const blocked = items.filter(
    (i) => i.statusToken === STATUS.OPEN && checkDependencies(i, items).length > 0,
  );
  const decisions = items.filter((i) => i.statusToken === STATUS.DECISION).length;
  const parts = [];
  if (blocked.length > 0) parts.push(`${blocked.length} item(s) blocked by unsatisfied deps`);
  if (decisions > 0) parts.push(`${decisions} decision(s) pending`);
  return parts.length > 0 ? `(${parts.join("; ")})` : "";
}
