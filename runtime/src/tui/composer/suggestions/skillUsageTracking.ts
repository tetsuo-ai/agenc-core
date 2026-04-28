/**
 * Per-skill usage tracking — used to rank recently-invoked skills
 * higher in the slash-command suggestion list.
 *
 * Ported from upstream. Upstream persists skill usage in its global
 * config; AgenC keeps a small dedicated file at
 * `~/.agenc/skill-usage.json` so the runtime config schema doesn't
 * have to grow a presentation-only field. The score uses an
 * exponential decay with a 7-day half-life so a single hot skill
 * doesn't dominate the list forever.
 *
 * Reads are synchronous in upstream and the upstream ranker calls
 * `getSkillUsageScore` inside a Fuse comparator on every keystroke.
 * To preserve that ergonomic, this module loads the file once on
 * first read and keeps an in-memory copy. Writes are debounced per
 * skill to avoid hammering the disk on quick repeated invocations.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { resolveAgencHome } from "../../../config/env.js";

const SKILL_USAGE_DEBOUNCE_MS = 60_000;
const HALF_LIFE_DAYS = 7;
const MIN_RECENCY_FACTOR = 0.1;

interface SkillUsageEntry {
  readonly usageCount: number;
  readonly lastUsedAt: number;
}

interface SkillUsageStore {
  readonly skillUsage: Record<string, SkillUsageEntry>;
}

const lastWriteBySkill = new Map<string, number>();

let cachedStore: SkillUsageStore | null = null;
let cachedHome: string | null = null;

function storePath(home: string): string {
  return join(home, ".agenc", "skill-usage.json");
}

function loadStore(): SkillUsageStore {
  let home: string;
  try {
    home = resolveAgencHome();
  } catch {
    return { skillUsage: {} };
  }
  if (cachedStore && cachedHome === home) return cachedStore;

  const path = storePath(home);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    cachedStore = { skillUsage: {} };
    cachedHome = home;
    return cachedStore;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as SkillUsageStore).skillUsage === "object" &&
      (parsed as SkillUsageStore).skillUsage !== null
    ) {
      cachedStore = parsed as SkillUsageStore;
    } else {
      cachedStore = { skillUsage: {} };
    }
  } catch {
    cachedStore = { skillUsage: {} };
  }
  cachedHome = home;
  return cachedStore;
}

function saveStore(next: SkillUsageStore): void {
  let home: string;
  try {
    home = resolveAgencHome();
  } catch {
    return;
  }
  const path = storePath(home);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
    cachedStore = next;
    cachedHome = home;
  } catch {
    // Disk failure is not user-facing here — ranking is best-effort.
  }
}

/**
 * Record one invocation of `skillName`. Calls within
 * `SKILL_USAGE_DEBOUNCE_MS` of the last recorded write for the same
 * skill are skipped — the ranker only resolves the score to a 7-day
 * half-life so sub-minute granularity is irrelevant and the debounce
 * avoids hot-loop disk writes when a script repeatedly invokes the
 * same skill.
 */
export function recordSkillUsage(skillName: string): void {
  const now = Date.now();
  const lastWrite = lastWriteBySkill.get(skillName);
  if (lastWrite !== undefined && now - lastWrite < SKILL_USAGE_DEBOUNCE_MS) {
    return;
  }
  lastWriteBySkill.set(skillName, now);

  const store = loadStore();
  const existing = store.skillUsage[skillName];
  const next: SkillUsageStore = {
    ...store,
    skillUsage: {
      ...store.skillUsage,
      [skillName]: {
        usageCount: (existing?.usageCount ?? 0) + 1,
        lastUsedAt: now,
      },
    },
  };
  saveStore(next);
}

/**
 * Compute a composite frequency-and-recency score for `skillName`.
 * Higher scores indicate skills that should rank earlier in
 * suggestion lists. Returns `0` when the skill has never been used.
 */
export function getSkillUsageScore(skillName: string): number {
  const store = loadStore();
  const usage = store.skillUsage[skillName];
  if (!usage) return 0;

  const daysSinceUse = (Date.now() - usage.lastUsedAt) / (1000 * 60 * 60 * 24);
  const recencyFactor = Math.pow(0.5, daysSinceUse / HALF_LIFE_DAYS);
  return usage.usageCount * Math.max(recencyFactor, MIN_RECENCY_FACTOR);
}

/** Test hook — reset module-level caches. */
export function __resetSkillUsageForTesting(): void {
  cachedStore = null;
  cachedHome = null;
  lastWriteBySkill.clear();
}
