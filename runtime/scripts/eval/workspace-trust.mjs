import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const TRUSTED_PROJECTS_FILENAME = "trusted-projects.json";
const LOCK_SUFFIX = ".lock";
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Exclusive lock around the record's read-modify-write. Two runners sharing
 * one isolated home (a command-task run next to a session run) each rewrote
 * the file from their own read and dropped the other's entry, which the CLI
 * then refused as an untrusted project one second into the task. The lock is
 * a directory-free O_EXCL file; a holder older than LOCK_STALE_MS is treated
 * as crashed and replaced.
 */
function withTrustLock(file, fn) {
  const lock = `${file}${LOCK_SUFFIX}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try {
        return fn();
      } finally {
        closeSync(fd);
        rmSync(lock, { force: true });
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
      } catch {
        // The holder released it between our checks; retry immediately.
      }
      if (Date.now() > deadline) {
        throw new Error(`trusted-projects lock held too long: ${lock}`);
      }
      sleepSync(50);
    }
  }
}

function readRecord(file) {
  if (!existsSync(file)) return { version: 1, trustedProjects: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.version === 1 && Array.isArray(parsed.trustedProjects)) {
      return parsed;
    }
  } catch {
    // An unreadable record is replaced; the home is isolated to this eval run.
  }
  return { version: 1, trustedProjects: [] };
}

/**
 * Trust an eval workspace inside the isolated AGENC_HOME so print mode, which
 * has no TTY and therefore no trust prompt, accepts it. Writes the same
 * version-1 record as runtime/src/permissions/trust/project-trust.ts and keeps
 * every other entry. Never call this with the user's real home.
 */
export function trustWorkspace({ agencHome, workspace, now = () => new Date() }) {
  const canonical = realpathSync(workspace);
  const file = path.join(agencHome, TRUSTED_PROJECTS_FILENAME);
  mkdirSync(agencHome, { recursive: true });
  return withTrustLock(file, () => {
    const record = readRecord(file);
    const others = record.trustedProjects.filter((entry) => entry?.path !== canonical);
    const next = {
      ...record,
      version: 1,
      trustedProjects: [...others, { path: canonical, trustedAt: now().toISOString() }],
    };
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    return { path: canonical, file };
  });
}
