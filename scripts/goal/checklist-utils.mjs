// Shared utilities for parsing PORT_CHECKLIST.md and looking up item state.
//
// An "item" is a checklist row of the form:
//   - [<status>] **<ID> <title>** — <body>
//
// We capture everything until the next item or section heading. Items can
// span multiple lines. Status is one of "[ ]" "[~]" "[x]" "[?]" "[-]".
//
// IDs follow the conventions in PORT_CHECKLIST.md (e.g. F-01, A-00b,
// LP-10, T-08, F-03e). We accept any [A-Z]+(-[A-Za-z0-9]+)+ shape.

import { spawnSync } from "node:child_process";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const STATUS_OPEN = "[ ]";
const STATUS_IN_PROGRESS = "[~]";
const STATUS_DONE = "[x]";
const STATUS_DECISION = "[?]";
const STATUS_SKIPPED = "[-]";

const ITEM_RE = /^- \[(.)\] \*\*([A-Z]+-[A-Za-z0-9]+)\b\s*([^*]+?)\*\*(.*)$/;
const HEADING_RE = /^#{1,6}\s/;
const PHASE_HEADING_RE = /^##\s/;
const DEPENDS_RE = /\*\*Depends:\*\*\s*([^.]+)\./i;
const DONE_RE = /\*\*Done(?:\s*criteria)?:\*\*\s*(.+?)(?:\.\s*\*\*Depends|\.\s*$|$)/is;

// Resolve the MAIN checkout root (the worktree that owns the .git directory).
// All shared state — PORT_CHECKLIST.md, .goal-completed/ markers, the
// checklist lock file — must live here so multiple worktrees stay coherent.
// Cached on first call.
let _mainRoot;
export function mainCheckoutRoot() {
  if (_mainRoot) return _mainRoot;
  const here = path.dirname(new URL(import.meta.url).pathname);
  // git rev-parse --git-common-dir returns the SHARED .git directory
  // regardless of which worktree we're called from (in main: ./.git;
  // in a worktree: /path/to/main/.git).
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: here, encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`Cannot resolve main checkout: git rev-parse --git-common-dir failed: ${r.stderr || r.stdout}`);
  }
  const gitDir = r.stdout.trim();
  _mainRoot = path.dirname(gitDir);
  return _mainRoot;
}

export function checklistPath() {
  return path.join(mainCheckoutRoot(), "PORT_CHECKLIST.md");
}

export async function readChecklist() {
  const file = checklistPath();
  const content = await readFile(file, "utf8");
  return { file, content, lines: content.split("\n") };
}

export function parseItems(content) {
  const lines = content.split("\n");
  const items = [];
  let current = null;
  let phase = null;
  let phaseTitle = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (HEADING_RE.test(line)) {
      // Section boundary; close any in-flight item.
      if (current) {
        items.push(current);
        current = null;
      }
      // Only top-level (h2) headings change the phase label so that
      // sub-headings like `### Stub fixes` don't clobber the parent
      // `## Phase 1 — Foundational` context.
      if (PHASE_HEADING_RE.test(line)) {
        const m = /^##\s+(?:Phase\s+)?([^\s—-]+)\b\s*[—-]?\s*(.*)$/.exec(line);
        if (m) {
          phase = m[1];
          phaseTitle = m[2] || "";
        }
      }
      continue;
    }
    const m = ITEM_RE.exec(line);
    if (m) {
      if (current) items.push(current);
      const [, status, id, title, rest] = m;
      current = {
        id,
        status,
        statusToken: `[${status}]`,
        title: title.trim(),
        bodyLines: [rest.trim()],
        startLine: i,
        phase,
        phaseTitle,
      };
      continue;
    }
    // Continuation of the current item: indented or empty inside its row.
    if (current && (line.startsWith("  ") || line.startsWith("\t") || line === "")) {
      current.bodyLines.push(line);
      continue;
    }
    // Anything else closes the current item.
    if (current) {
      items.push(current);
      current = null;
    }
  }
  if (current) items.push(current);
  for (const item of items) {
    item.body = item.bodyLines.join("\n").trim();
    item.dependsOn = parseDepends(item.body);
    item.doneCriteria = parseDoneCriteria(item.body);
  }
  return items;
}

function parseDepends(body) {
  const m = DEPENDS_RE.exec(body);
  if (!m) return [];
  return m[1]
    .split(/[,\s]+/)
    .map((s) => s.trim().replace(/\.+$/, ""))
    .filter((s) => /^[A-Z]+-[A-Za-z0-9]+$/.test(s));
}

function parseDoneCriteria(body) {
  const m = DONE_RE.exec(body);
  if (!m) return null;
  return m[1].trim();
}

export async function findItem(id) {
  const { content } = await readChecklist();
  const items = parseItems(content);
  const item = items.find((it) => it.id === id);
  if (!item) {
    throw new Error(`Item ${id} not found in PORT_CHECKLIST.md`);
  }
  return { item, allItems: items };
}

export function statusName(token) {
  switch (token) {
    case STATUS_OPEN:
      return "open";
    case STATUS_IN_PROGRESS:
      return "in-progress";
    case STATUS_DONE:
      return "done";
    case STATUS_DECISION:
      return "needs-decision";
    case STATUS_SKIPPED:
      return "skipped";
    default:
      return "unknown";
  }
}

export function checkDependencies(item, allItems) {
  const blockers = [];
  for (const depId of item.dependsOn) {
    const dep = allItems.find((it) => it.id === depId);
    if (!dep) {
      blockers.push({ id: depId, reason: "not found in checklist" });
      continue;
    }
    if (dep.statusToken !== STATUS_DONE) {
      blockers.push({ id: depId, reason: `status is ${statusName(dep.statusToken)}` });
    }
  }
  return blockers;
}

// Cooperative file-lock for setItemStatus. Two concurrent prep.mjs (or
// complete.mjs) runs would otherwise both read PORT_CHECKLIST.md, both
// modify their target line, and both write back — last writer silently
// wins, dropping the other's status flip. We acquire an exclusive lock
// file (atomic O_EXCL create) before the read-modify-write, retry up to
// 30 seconds, and always release on completion or error.
async function withChecklistLock(fn) {
  const lockPath = checklistPath() + ".lock";
  const startMs = Date.now();
  const TIMEOUT_MS = 30_000;
  const POLL_MS = 100;
  let handle;
  for (;;) {
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      break;
    } catch (err) {
      if (err && err.code === "EEXIST") {
        if (Date.now() - startMs > TIMEOUT_MS) {
          throw new Error(
            `Timed out (${TIMEOUT_MS}ms) waiting for checklist lock at ${lockPath}. ` +
            `Another prep/complete may be running. If you're sure no other process is active, remove the lock manually.`,
          );
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
        continue;
      }
      throw err;
    }
  }
  try {
    return await fn();
  } finally {
    try { await handle.close(); } catch {}
    try { await unlink(lockPath); } catch {}
  }
}

export async function setItemStatus(id, newStatus) {
  if (![STATUS_OPEN, STATUS_IN_PROGRESS, STATUS_DONE, STATUS_DECISION, STATUS_SKIPPED].includes(newStatus)) {
    throw new Error(`Invalid status token: ${newStatus}`);
  }
  return withChecklistLock(async () => {
    const { file, content, lines } = await readChecklist();
    let replaced = false;
    for (let i = 0; i < lines.length; i += 1) {
      const m = ITEM_RE.exec(lines[i]);
      if (m && m[2] === id) {
        lines[i] = lines[i].replace(/^- \[.\]/, `- ${newStatus}`);
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      throw new Error(`Item ${id} not found when updating status`);
    }
    const next = lines.join("\n");
    if (next !== content) {
      await writeFile(file, next, "utf8");
    }
    return { file, changed: next !== content };
  });
}

export const STATUS = {
  OPEN: STATUS_OPEN,
  IN_PROGRESS: STATUS_IN_PROGRESS,
  DONE: STATUS_DONE,
  DECISION: STATUS_DECISION,
  SKIPPED: STATUS_SKIPPED,
};

// repoRoot() returns the script's own checkout root — i.e., the worktree
// where the script is currently executing. For shared state (markers,
// checklist, lock), use mainCheckoutRoot() instead.
export function repoRoot() {
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, "../..");
}

export function markerDir() {
  return path.join(mainCheckoutRoot(), ".goal-completed");
}

// Where per-item worktrees live. One subdir per item ID.
export function worktreeBase() {
  return "/tmp/agenc-core-wt";
}

export function worktreePath(id) {
  return path.join(worktreeBase(), id);
}

export function markerPath(id) {
  return path.join(markerDir(), `${id}.json`);
}

export function fail(msg, code = 1) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}
