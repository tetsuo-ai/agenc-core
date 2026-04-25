import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type EnvLike = Pick<NodeJS.ProcessEnv, "AGENC_HOME" | "HOME" | "USERPROFILE">;

export interface PlanFileContext {
  readonly agencHome?: string;
  readonly home?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly env?: EnvLike;
}

type PlanKey = {
  readonly agencHome: string;
  readonly sessionId: string;
};

const adjectives = [
  "amber",
  "brisk",
  "clear",
  "daring",
  "ember",
  "frost",
  "green",
  "harbor",
  "ivory",
  "juniper",
] as const;

const nouns = [
  "anchor",
  "bridge",
  "cipher",
  "drift",
  "engine",
  "forge",
  "grove",
  "harvest",
  "island",
  "kernel",
] as const;

const planSlugs = new Map<string, string>();

export function resolveAgencHome(ctx: PlanFileContext = {}): string {
  if (ctx.agencHome && ctx.agencHome.trim().length > 0) {
    return ctx.agencHome;
  }
  const env = ctx.env ?? process.env;
  if (env.AGENC_HOME && env.AGENC_HOME.trim().length > 0) {
    return env.AGENC_HOME;
  }
  const home = ctx.home ?? env.HOME ?? env.USERPROFILE ?? ".";
  return join(home, ".agenc");
}

export function getPlansDirectory(ctx: PlanFileContext = {}): string {
  const dir = join(resolveAgencHome(ctx), "plans");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Let the eventual read/write operation surface the filesystem error.
  }
  return dir;
}

function baseKey(ctx: PlanFileContext = {}): PlanKey {
  return {
    agencHome: resolveAgencHome(ctx),
    sessionId: ctx.sessionId?.trim() || "default",
  };
}

function cacheKey(key: PlanKey): string {
  return `${key.agencHome}\0${key.sessionId}`;
}

function slugIndexPath(ctx: PlanFileContext): string {
  return join(getPlansDirectory(ctx), ".slugs.json");
}

function readSlugIndex(ctx: PlanFileContext): Record<string, string> {
  try {
    const raw = readFileSync(slugIndexPath(ctx), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        const slug = sanitizePlanSlug(value);
        if (slug) out[key] = slug;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeSlugIndex(ctx: PlanFileContext, index: Record<string, string>): void {
  try {
    const path = slugIndexPath(ctx);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  } catch {
    // The plan file itself remains authoritative; slug persistence is best-effort.
  }
}

function randomWord<T extends readonly string[]>(words: T): T[number] {
  return words[Math.floor(Math.random() * words.length)]!;
}

function generatePlanSlug(): string {
  const suffix = randomUUID().slice(0, 8);
  return `${randomWord(adjectives)}-${randomWord(nouns)}-${suffix}`;
}

function sanitizePlanSlug(slug: string): string {
  return slug
    .trim()
    .replace(/\.md$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sanitizeAgentId(agentId: string): string {
  return sanitizePlanSlug(agentId) || "unknown";
}

function pathForSlug(ctx: PlanFileContext, slug: string): string {
  const agentSuffix =
    ctx.agentId && ctx.agentId.trim().length > 0
      ? `-agent-${sanitizeAgentId(ctx.agentId)}`
      : "";
  return join(getPlansDirectory(ctx), `${slug}${agentSuffix}.md`);
}

export function getPlanSlug(ctx: PlanFileContext = {}): string {
  const key = baseKey(ctx);
  const keyString = cacheKey(key);
  const cached = planSlugs.get(keyString);
  if (cached) return cached;

  const persisted = readSlugIndex(ctx)[key.sessionId];
  if (persisted) {
    planSlugs.set(keyString, persisted);
    return persisted;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const slug = generatePlanSlug();
    if (!existsSync(pathForSlug({ ...ctx, agentId: undefined }, slug))) {
      setPlanSlug(ctx, slug);
      return slug;
    }
  }

  const fallback = randomUUID();
  setPlanSlug(ctx, fallback);
  return fallback;
}

export function setPlanSlug(ctx: PlanFileContext, slug: string): string {
  const cleaned = sanitizePlanSlug(slug);
  if (!cleaned) {
    throw new Error("plan slug must not be empty");
  }
  const keyString = cacheKey(baseKey(ctx));
  planSlugs.set(keyString, cleaned);
  const index = readSlugIndex(ctx);
  index[baseKey(ctx).sessionId] = cleaned;
  writeSlugIndex(ctx, index);
  return cleaned;
}

export function clearPlanSlug(ctx: PlanFileContext = {}): void {
  const key = baseKey(ctx);
  planSlugs.delete(cacheKey(key));
  const index = readSlugIndex(ctx);
  delete index[key.sessionId];
  writeSlugIndex(ctx, index);
}

export function clearAllPlanSlugs(): void {
  planSlugs.clear();
}

export function getPlanFilePath(ctx: PlanFileContext = {}): string {
  return pathForSlug(ctx, getPlanSlug(ctx));
}

/**
 * Does `absolutePath` belong to the current session's plan-file family?
 *
 * Mirrors openclaude `isSessionPlanFile`
 * (`/home/tetsuo/git/openclaude/src/utils/permissions/filesystem.ts:254`):
 *
 *     const expectedPrefix = join(getPlansDirectory(), getPlanSlug())
 *     return path.startsWith(expectedPrefix) && path.endsWith('.md')
 *
 * The prefix match (rather than exact equality) covers both the main
 * plan file `<plansDir>/<slug>.md` and per-agent plans
 * `<plansDir>/<slug>-agent-<agentId>.md`. The `.md` suffix guards
 * against directory-traversal corner cases like `<slug>../../etc/passwd`.
 *
 * The `.slugs.json` index itself is NOT a plan file — its name does not
 * end in `.md` so the suffix check excludes it.
 *
 * Used by the filesystem tools to allowlist plan-file writes regardless
 * of the workspace allowlist, matching openclaude's
 * `checkEditableInternalPath` carve-out (filesystem.ts:1488-1506) which
 * fires before the workspace-write check and bypasses dangerous-path
 * heuristics (the plan dir lives under `~/.agenc`/`~/.claude` which is
 * normally treated as dangerous).
 */
export function isSessionPlanFile(
  absolutePath: string,
  ctx: PlanFileContext = {},
): boolean {
  if (typeof absolutePath !== "string" || absolutePath.length === 0) {
    return false;
  }
  const expectedPrefix = join(getPlansDirectory(ctx), getPlanSlug(ctx));
  return absolutePath.startsWith(expectedPrefix) && absolutePath.endsWith(".md");
}

export function getPlan(ctx: PlanFileContext = {}): string | null {
  const path = getPlanFilePath(ctx);
  try {
    const content = readFileSync(path, "utf8");
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

export function readPlanFile(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, "utf8");
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

export async function writePlan(
  ctx: PlanFileContext,
  content: string,
): Promise<string> {
  const filePath = getPlanFilePath(ctx);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return filePath;
}

export function writePlanSync(ctx: PlanFileContext, content: string): string {
  const filePath = getPlanFilePath(ctx);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

export function copyPlanForResume(
  source: PlanFileContext,
  target: PlanFileContext,
): string | null {
  const sourcePath = getPlanFilePath(source);
  if (!existsSync(sourcePath)) return null;
  const targetPath = getPlanFilePath(target);
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
  return targetPath;
}

export async function copyPlanForFork(
  source: PlanFileContext,
  target: PlanFileContext,
): Promise<string | null> {
  const sourcePath = getPlanFilePath(source);
  if (!existsSync(sourcePath)) return null;
  const targetPath = getPlanFilePath(target);
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
  return targetPath;
}

export function formatPlanMarkdownFromSteps(state: {
  readonly explanation?: string;
  readonly plan: readonly {
    readonly step: string;
    readonly status: "pending" | "in_progress" | "completed";
  }[];
  readonly updatedAt?: string;
}): string {
  const lines = ["# AgenC Plan", ""];
  if (state.explanation && state.explanation.trim().length > 0) {
    lines.push("## Context", "", state.explanation.trim(), "");
  }
  lines.push("## Steps", "");
  if (state.plan.length === 0) {
    lines.push("- [ ] No plan items written yet.");
  } else {
    for (const item of state.plan) {
      const marker =
        item.status === "completed"
          ? "x"
          : item.status === "in_progress"
            ? "-"
            : " ";
      lines.push(`- [${marker}] ${item.step}`);
    }
  }
  if (state.updatedAt) {
    lines.push("", `Updated: ${state.updatedAt}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatPlanText(planContent: string, planPath: string): string {
  return [
    "Current Plan",
    planPath,
    "",
    planContent,
    "",
    'Use "/plan open" to edit this plan in your configured editor.',
  ].join("\n");
}
