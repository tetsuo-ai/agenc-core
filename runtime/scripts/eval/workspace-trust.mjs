import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const TRUSTED_PROJECTS_FILENAME = "trusted-projects.json";

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
  const record = readRecord(file);
  const others = record.trustedProjects.filter((entry) => entry?.path !== canonical);
  const next = {
    ...record,
    version: 1,
    trustedProjects: [...others, { path: canonical, trustedAt: now().toISOString() }],
  };
  mkdirSync(agencHome, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return { path: canonical, file };
}
